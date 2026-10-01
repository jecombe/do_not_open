#!/usr/bin/env bash
# Prepares an Ubuntu server for the backend, once: Docker, a firewall, the shared edge proxy
# (/opt/edge, which other projects on the server use too), /opt/dno with its secrets, and a
# nightly database backup. Safe to run again: it keeps what exists.
#
#   scp deploy/bootstrap.sh ubuntu@SERVER: && ssh ubuntu@SERVER 'sudo bash bootstrap.sh <api-domain> <cors-origins>'
set -euo pipefail

API_DOMAIN="${1:?usage: bootstrap.sh <api-domain> [cors-origins]}"
CORS_ORIGINS="${2:-*}"
DIR=/opt/dno
OWNER="${SUDO_USER:-ubuntu}"

if ! command -v docker >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2
  systemctl enable --now docker
fi
usermod -aG docker "$OWNER"

if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
fi

# The shared proxy's home. Its compose file and Caddyfile are copied in by CI.
mkdir -p /opt/edge/sites
chown -R "$OWNER:$OWNER" /opt/edge

mkdir -p "$DIR/backups"
if [ ! -f "$DIR/.env" ]; then
  umask 077
  cat > "$DIR/.env" <<ENV
# Written by bootstrap.sh. Secrets: keep this file on the server only.
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
API_DOMAIN=$API_DOMAIN
CORS_ORIGINS=$CORS_ORIGINS
SIGN_IN_DOMAIN=$API_DOMAIN
# Optional: put a keyed endpoint first; the free ones stay as fallbacks.
# RPC_URLS=https://eth-sepolia.g.alchemy.com/v2/KEY,https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co
ENV
fi
chown -R "$OWNER:$OWNER" "$DIR"

# Nightly dump, a week kept.
cat > /etc/cron.d/dno-backup <<CRON
15 3 * * * $OWNER cd $DIR && docker compose exec -T postgres pg_dump -U dno -Fc dno > backups/dno-\$(date +\%F).dump && find backups -name '*.dump' -mtime +7 -delete
CRON

echo "ready: $DIR (API at https://$API_DOMAIN once deployed)"
