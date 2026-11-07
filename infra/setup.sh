#!/usr/bin/env bash
# One-time setup of an iPlast server (Ubuntu 22.04/24.04, run as root):
#   curl -fsSL https://raw.githubusercontent.com/oftadeh/iplast/main/infra/setup.sh | sudo bash
# It installs Docker, clones the code into /opt/iplast, creates .env with random
# secrets, starts everything, and installs auto-deploy: every 2 minutes the server
# pulls new commits from GitHub and rebuilds. Status is sent to the admin via the bot.
set -euo pipefail
REPO="https://github.com/oftadeh/iplast.git"
DIR="/opt/iplast"
DOMAIN_DEFAULT="isfahanplast.co"

ask() { local q="$1" v; read -r -p "$q" v < /dev/tty; echo "$v"; }

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }

echo "== iPlast setup =="
if ! command -v docker >/dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi
apt-get update -qq && apt-get install -y -qq git curl openssl >/dev/null

if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR"

if [ ! -f .env ]; then
  BOT_TOKEN="${BOT_TOKEN:-$(ask 'Telegram bot token: ')}"
  ADMIN_ID="${ADMIN_ID:-$(ask 'Your numeric Telegram ID (send /id to the bot later if unsure, Enter to skip): ')}"
  DOMAIN="${DOMAIN:-$DOMAIN_DEFAULT}"
  PGPASS="$(openssl rand -hex 24)"
  cat > .env <<ENV
NODE_ENV=production
DOMAIN=$DOMAIN
BOT_TOKEN=$BOT_TOKEN
ADMIN_TELEGRAM_IDS=$ADMIN_ID
SUPPORT_TELEGRAM_IDS=$ADMIN_ID
MINIAPP_URL=https://app.$DOMAIN
CORS_ORIGINS=https://app.$DOMAIN,https://admin.$DOMAIN
POSTGRES_USER=iplast
POSTGRES_PASSWORD=$PGPASS
POSTGRES_DB=iplast
DATABASE_URL=postgresql://iplast:$PGPASS@postgres:5432/iplast?schema=public
REDIS_URL=redis://redis:6379
JWT_SECRET=$(openssl rand -hex 32)
API_PORT=3000
ENV
  chmod 600 .env
  echo ".env created."
fi

install -m 755 infra/autodeploy.sh /usr/local/bin/iplast-autodeploy
cat > /etc/systemd/system/iplast-autodeploy.service <<UNIT
[Unit]
Description=iPlast auto-deploy from GitHub
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/iplast-autodeploy
UNIT
cat > /etc/systemd/system/iplast-autodeploy.timer <<UNIT
[Unit]
Description=Check GitHub for new iPlast commits every 2 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now iplast-autodeploy.timer

echo "Building and starting (first build takes several minutes)..."
FORCE=1 /usr/local/bin/iplast-autodeploy
if [ ! -f .seeded ]; then
  echo "Loading the Aban 1405 catalog..."
  docker compose run --rm api node node_modules/@iplast/db/dist/seed.js && touch .seeded
fi
echo "Done. Public IP: $(curl -fsS https://api.ipify.org || echo unknown)"
echo "Point DNS A records app.<domain> and admin.<domain> to this IP."
