#!/usr/bin/env bash
# Turns on the mini app and admin panel once the domain is ready:
#   sudo bash /opt/iplast/infra/enable-web.sh isfahanplast.co
# Before running, point DNS A records app.<domain> and admin.<domain> to this server
# (Caddy then gets HTTPS certificates by itself).
set -euo pipefail
DIR="/opt/iplast"
DOMAIN="${1:?usage: enable-web.sh <domain>}"
cd "$DIR"
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
set_env DOMAIN "$DOMAIN"
set_env COMPOSE_PROFILES web
set_env MINIAPP_URL "https://app.$DOMAIN"
set_env CORS_ORIGINS "https://app.$DOMAIN,https://admin.$DOMAIN"
FORCE=1 /usr/local/bin/iplast-autodeploy
echo "Done: https://app.$DOMAIN (mini app) and https://admin.$DOMAIN (admin panel)."
