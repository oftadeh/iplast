#!/usr/bin/env bash
# Pulls new commits from GitHub and rebuilds. Reports the result to the admin via the bot.
set -uo pipefail
DIR="/opt/iplast"
cd "$DIR" || exit 1
exec 9>/tmp/iplast-deploy.lock
flock -n 9 || exit 0

set -a; . ./.env; set +a
notify() {
  local id="${ADMIN_TELEGRAM_IDS%%,*}"
  [ -n "${BOT_TOKEN:-}" ] && [ -n "$id" ] || return 0
  curl -fsS -m 20 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${id}" --data-urlencode "text=$1" >/dev/null || true
}

git fetch -q origin main || { echo "fetch failed"; exit 1; }
LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ] && [ -z "${FORCE:-}" ]; then exit 0; fi

git reset -q --hard origin/main
MSG=$(git log -1 --pretty=%s)
# servers that use the outbound proxy (see infra/proxy): keep its host tools current
if [ -d /opt/iplast-proxy ]; then bash infra/proxy/install.sh >/dev/null 2>&1 || notify "⚠️ iPlast proxy tools update failed"; set -a; . ./.env; set +a; fi
LOG=/var/log/iplast-deploy.log
if docker compose up -d --build --remove-orphans >"$LOG" 2>&1; then
  sleep 8
  STATE=$(docker compose ps --format '{{.Service}}: {{.State}}' | tr '\n' ' ')
  notify "✅ iPlast deployed: ${MSG}
${STATE}"
else
  notify "❌ iPlast deploy failed: ${MSG}
$(tail -n 25 "$LOG")"
  exit 1
fi
