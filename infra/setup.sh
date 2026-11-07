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
  OPENAI_KEY="${OPENAI_API_KEY:-$(ask 'OpenAI API key for the order assistant (Enter to skip, add later in .env): ')}"
  # No domain yet: the mini app (and its admin panel at /admin/) run on <server-ip>.sslip.io, a free
  # hostname that points to this server, so Telegram gets the HTTPS address it requires.
  # Move to a real domain later with: sudo bash /opt/iplast/infra/enable-web.sh isfahanplast.co
  DOMAIN="${DOMAIN-$(ask "Domain (e.g. $DOMAIN_DEFAULT), Enter = none for now: ")}"
  if [ -n "$DOMAIN" ]; then SITE="app.$DOMAIN"; else
    IP="$(curl -4fsS https://api.ipify.org)"; SITE="$(echo "$IP" | tr . -).sslip.io"; fi
  PGPASS="$(openssl rand -hex 24)"
  cat > .env <<ENV
NODE_ENV=production
DOMAIN=$DOMAIN
SITE_HOST=$SITE
BOT_TOKEN=$BOT_TOKEN
ADMIN_TELEGRAM_IDS=$ADMIN_ID
SUPPORT_TELEGRAM_IDS=$ADMIN_ID
MINIAPP_URL=https://$SITE
CORS_ORIGINS=https://$SITE
POSTGRES_USER=iplast
POSTGRES_PASSWORD=$PGPASS
POSTGRES_DB=iplast
DATABASE_URL=postgresql://iplast:$PGPASS@postgres:5432/iplast?schema=public
REDIS_URL=redis://redis:6379
JWT_SECRET=$(openssl rand -hex 32)
API_PORT=3000
# order assistant (OpenAI). Empty key = assistant off; everything else still works.
OPENAI_API_KEY=$OPENAI_KEY
OPENAI_MODEL=gpt-6-luna
OPENAI_TRANSCRIBE_MODEL=gpt-transcribe
# bot → API calls inside the Docker network only
INTERNAL_KEY=$(openssl rand -hex 32)
API_INTERNAL_URL=http://api:3000/api
# SMS to managers when a sales agent approves a proforma (Kavenegar). Empty = Telegram message only.
KAVENEGAR_API_KEY=
KAVENEGAR_SENDER=
ADMIN_SMS_NUMBERS=
ENV
  chmod 600 .env
  echo ".env created."
fi
# settings added after the first install
grep -q '^INTERNAL_KEY=' .env || printf '\nINTERNAL_KEY=%s\nAPI_INTERNAL_URL=http://api:3000/api\nOPENAI_API_KEY=\nOPENAI_MODEL=gpt-6-luna\nOPENAI_TRANSCRIBE_MODEL=gpt-transcribe\n' "$(openssl rand -hex 32)" >> .env
grep -q '^KAVENEGAR_API_KEY=' .env || printf '\nKAVENEGAR_API_KEY=\nKAVENEGAR_SENDER=\nADMIN_SMS_NUMBERS=\n' >> .env

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
SITE_HOST=$(grep '^SITE_HOST=' .env | cut -d= -f2)
echo "Mini app: https://$SITE_HOST   Admin panel: https://$SITE_HOST/admin/ (or /admin in the bot)"
case "$SITE_HOST" in *.sslip.io) ;; *) echo "Point the DNS A record of $SITE_HOST to this IP.";; esac
echo "Open the bot in Telegram and send /start."
