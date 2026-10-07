#!/usr/bin/env bash
# Runs on the server, from CI: switches the API to IMAGE without dropping a request.
#   echo "$REGISTRY_TOKEN" | ssh ubuntu@SERVER 'bash /opt/dno/deploy.sh IMAGE REGISTRY_USER'
#   bash /opt/dno/deploy.sh          # the running image again, after editing .env
# Expects /opt/dno (docker-compose.yml, .env, dno.caddy.template) and /opt/edge (the shared proxy).
set -euo pipefail
cd /opt/dno
IMAGE="${1:-$(grep '^API_IMAGE=' .env | cut -d= -f2- || true)}"
[ -n "$IMAGE" ] || { echo "usage: deploy.sh <image> [registry-user]" >&2; exit 1; }
REGISTRY_USER="${2:-}"

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
REPLICAS="$(grep '^API_REPLICAS=' .env | cut -d= -f2- || true)"
REPLICAS="${REPLICAS:-2}"
# A registry image is pulled; a local one (built on the server, for a test) is used as is.
if [[ "$IMAGE" == */* ]]; then docker compose pull --quiet api indexer; fi
docker compose up -d --no-deps postgres

# Route the domain, and any aliases (space or comma separated), to the replicas, then reload the
# proxy (a reload keeps the other sites up). The proxy checks the file before switching to it.
API_DOMAIN="$(grep '^API_DOMAIN=' .env | cut -d= -f2-)"
API_ALIASES="$(grep '^API_ALIASES=' .env | cut -d= -f2- || true)"
API_HOSTS="$(echo "$API_DOMAIN $API_ALIASES" | tr ',' ' ' | xargs | sed 's/ /, /g')"
sed "s|__API_HOSTS__|$API_HOSTS|" dno.caddy.template > /opt/edge/sites/dno.caddy
# The team's admin site, once ADMIN_DOMAIN is set (and ADMIN_PASSWORD, or it answers nothing).
ADMIN_DOMAIN="$(grep '^ADMIN_DOMAIN=' .env | cut -d= -f2- || true)"
if [ -n "$ADMIN_DOMAIN" ] && [ -f dno-admin.caddy.template ]; then
  sed "s|__ADMIN_HOST__|$ADMIN_DOMAIN|" dno-admin.caddy.template > /opt/edge/sites/dno-admin.caddy
else
  rm -f /opt/edge/sites/dno-admin.caddy
fi

answers() { docker exec "$1" wget -qO- http://127.0.0.1:8080/health 2>/dev/null | grep -q '"ok":true'; }

# The API, replica by replica: the new ones start beside the old ones, each must answer its
# health check, then the proxy sees them (it reads the DNS every 2 s) and the old ones stop,
# finishing the requests they hold. If a new one never answers, it is removed and the old ones
# keep serving: a broken image never takes the API down.
old="$(docker compose ps -q api || true)"
count=$(echo "$old" | grep -c . || true)
docker compose up -d --no-deps --no-recreate --scale api=$((count + REPLICAS)) api
new="$(comm -13 <(echo "$old" | sort) <(docker compose ps -q api | sort))"
for c in $new; do
  up=""
  for _ in $(seq 1 60); do
    if answers "$c"; then up=1; break; fi
    sleep 2
  done
  if [ -z "$up" ]; then
    docker logs --tail 80 "$c" || true
    echo "a new API replica did not come up: the old ones keep serving" >&2
    # shellcheck disable=SC2086
    docker rm -f $new >/dev/null
    exit 1
  fi
done
docker exec edge-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null
# Long enough for the proxy to read the new replicas' addresses.
sleep 5
if [ -n "$old" ]; then
  # shellcheck disable=SC2086
  docker stop -t 30 $old >/dev/null && docker rm $old >/dev/null
fi

# The indexer, once the old processes are gone (a ROLE=all API from before the split indexed
# too): a short pause in indexing, nothing the public sees.
docker compose up -d --no-deps indexer
healthy=""
for _ in $(seq 1 60); do
  if answers "$(docker compose ps -q indexer)"; then healthy=1; break; fi
  sleep 2
done
if [ -z "$healthy" ]; then
  docker compose logs --tail 80 indexer
  echo "the indexer did not come up (the API still serves the index as it was)" >&2
  exit 1
fi
docker compose up -d --remove-orphans --no-recreate

# The monitoring (Prometheus, Grafana, Alertmanager), once monitoring/.env exists: see
# monitoring/.env.example. One stack for every network; Prometheus finds each API replica by DNS.
if [ -f monitoring/.env ]; then
  (cd monitoring && docker compose up -d --remove-orphans)
  # Prometheus and Alertmanager read their files again without a restart.
  (cd monitoring && docker compose kill -s HUP prometheus alertmanager >/dev/null 2>&1 || true)
  MONITORING_DOMAIN="$(grep '^MONITORING_DOMAIN=' monitoring/.env | cut -d= -f2-)"
  sed "s|__MONITORING_HOST__|$MONITORING_DOMAIN|" monitoring/monitoring.caddy.template > /opt/edge/sites/dno-monitoring.caddy
  docker exec edge-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null
fi

# Every deploy pulls a new <repo>:<sha> tag, which a plain prune never removes: keep the
# running image and the two before it (for a rollback), drop older ones, then the untagged layers.
REPO="${IMAGE%:*}"
docker images "$REPO" --format '{{.ID}}' | awk '!seen[$0]++' | tail -n +4 | xargs -r docker rmi -f >/dev/null 2>&1 || true
docker image prune -f >/dev/null
echo "deployed $IMAGE ($REPLICAS API replicas and the indexer) at https://${API_HOSTS//, / https://}"
