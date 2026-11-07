#!/usr/bin/env bash
# Moves the mini app and admin panel from <ip>.sslip.io to your own domain:
#   sudo bash /opt/iplast/infra/enable-web.sh isfahanplast.co
# First point the DNS A record of app.<domain> to this server (Caddy gets HTTPS by itself).
set -euo pipefail
DIR="/opt/iplast"
DOMAIN="${1:?usage: enable-web.sh <domain>}"
cd "$DIR"
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
set_env DOMAIN "$DOMAIN"
set_env SITE_HOST "app.$DOMAIN"
set_env MINIAPP_URL "https://app.$DOMAIN"
set_env CORS_ORIGINS "https://app.$DOMAIN"
FORCE=1 /usr/local/bin/iplast-autodeploy
echo "Done: https://app.$DOMAIN (mini app) and https://app.$DOMAIN/admin/ (admin panel)."
