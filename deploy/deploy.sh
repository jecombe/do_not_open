#!/usr/bin/env bash
# Runs on the server, from CI: switches the API to IMAGE, migrations run as it starts.
#   echo "$REGISTRY_TOKEN" | ssh ubuntu@SERVER 'bash /opt/dno/deploy.sh IMAGE REGISTRY_USER'
# Expects /opt/dno (docker-compose.yml, .env, dno.caddy.template) and /opt/edge (the shared proxy).
set -euo pipefail
IMAGE="${1:?usage: deploy.sh <image> [registry-user]}"
REGISTRY_USER="${2:-}"
cd /opt/dno

# A private registry: log in with the token on stdin, for this pull only.
if [ -n "$REGISTRY_USER" ]; then
  docker login ghcr.io -u "$REGISTRY_USER" --password-stdin >/dev/null
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
fi

# The shared proxy: started once, then left alone (other projects use it too).
docker network inspect edge >/dev/null 2>&1 || docker network create edge >/dev/null
if [ -z "$(docker ps -q -f name=^edge-caddy$)" ]; then
  (cd /opt/edge && docker compose up -d)
fi

if grep -q '^API_IMAGE=' .env; then sed -i "s|^API_IMAGE=.*|API_IMAGE=$IMAGE|" .env; else echo "API_IMAGE=$IMAGE" >> .env; fi
# A registry image is pulled; a local one (built on the server, for a test) is used as is.
if [[ "$IMAGE" == */* ]]; then docker compose pull --quiet api; fi
docker compose up -d --remove-orphans

# Wait for the new container to answer.
healthy=""
for _ in $(seq 1 60); do
  if docker compose exec -T api wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
if [ -z "$healthy" ]; then
  docker compose logs --tail 80 api
  echo "the API did not come up" >&2
  exit 1
fi

# Route the domain, and any aliases (space or comma separated), to it, then reload the proxy
# (a reload keeps the other sites up). The proxy checks the file before switching to it.
API_DOMAIN="$(grep '^API_DOMAIN=' .env | cut -d= -f2-)"
API_ALIASES="$(grep '^API_ALIASES=' .env | cut -d= -f2- || true)"
API_HOSTS="$(echo "$API_DOMAIN $API_ALIASES" | tr ',' ' ' | xargs | sed 's/ /, /g')"
sed "s|__API_HOSTS__|$API_HOSTS|" dno.caddy.template > /opt/edge/sites/dno.caddy

# The monitoring (Prometheus, Grafana, Alertmanager), once monitoring/.env exists: see
# monitoring/.env.example. One stack for every network; each API is a file in prometheus/targets.
if [ -f monitoring/.env ]; then
  (cd monitoring && docker compose up -d --remove-orphans)
  # Prometheus and Alertmanager read their files again without a restart.
  (cd monitoring && docker compose kill -s HUP prometheus alertmanager >/dev/null 2>&1 || true)
  MONITORING_DOMAIN="$(grep '^MONITORING_DOMAIN=' monitoring/.env | cut -d= -f2-)"
  sed "s|__MONITORING_HOST__|$MONITORING_DOMAIN|" monitoring/monitoring.caddy.template > /opt/edge/sites/dno-monitoring.caddy
fi
docker exec edge-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null

docker image prune -f >/dev/null
echo "deployed $IMAGE at https://${API_HOSTS//, / https://}"
