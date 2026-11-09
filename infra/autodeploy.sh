#!/usr/bin/env bash
# Pulls new commits from GitHub and rebuilds. Messages the senior manager only when something needs attention.
set -uo pipefail
DIR="/opt/iplast"
cd "$DIR" || exit 1
exec 9>/tmp/iplast-deploy.lock
flock -n 9 || exit 0

set -a; . ./.env; set +a
# on the host, the proxy is xray on 127.0.0.1 (proxy:10809 only exists inside Docker)
if [ -n "${BUILD_PROXY:-}" ]; then export HTTPS_PROXY=$BUILD_PROXY HTTP_PROXY=$BUILD_PROXY https_proxy=$BUILD_PROXY http_proxy=$BUILD_PROXY; fi
# the senior manager: the one set in the panel after a transfer, else the first ADMIN_TELEGRAM_IDS
owner_id() {
  local v
  v=$(cd /opt/iplast 2>/dev/null && timeout 15 docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT value->>0 FROM \"Setting\" WHERE key='owner.telegramIds'" 2>/dev/null | tr -cd '0-9')
  echo "${v:-${ADMIN_TELEGRAM_IDS%%,*}}"
}
notify() {
  local id; id="$(owner_id)"
  [ -n "${BOT_TOKEN:-}" ] && [ -n "$id" ] || return 0
  curl -fsS -m 20 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${id}" --data-urlencode "text=${1:0:3900}" >/dev/null || true
}

# what the owner needs to see when a deploy fails: disk, memory and the database's own log
diag() {
  echo "--- disk/memory:"
  df -h / /var/lib/docker 2>/dev/null | awk 'NR==1 || !seen[$0]++'
  free -m 2>/dev/null | head -2
  docker system df 2>/dev/null
  echo "--- postgres:"
  docker compose logs --no-color --tail 15 postgres 2>&1 | tail -n 15
  echo "--- migrate:"
  docker compose logs --no-color --tail 15 migrate 2>&1 | tail -n 15
}
# free space in GB on the disk that holds Docker's images and volumes
free_gb() { df -BG --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -cd '0-9'; }
# every deploy leaves the previous images and build cache behind; when the disk runs low the database can no longer
# write and stops answering. Only unused images and build cache are removed, never volumes (the data).
cleanup() {
  # unused images, and build cache older than a day (kept recent so the next build stays fast)
  docker image prune -f >/dev/null 2>&1
  docker builder prune -f --filter until=24h >/dev/null 2>&1
  local f; f=$(free_gb)
  if [ -n "$f" ] && [ "$f" -lt 6 ]; then
    # disk still low: all build cache (only slows the next build) and old system logs
    docker builder prune -af >/dev/null 2>&1
    journalctl --vacuum-size=200M >/dev/null 2>&1
  fi
}
# waits until the database answers (it may be recovering after the server ran out of memory or disk)
wait_db() {
  docker compose up -d postgres redis >>"$LOG" 2>&1
  for i in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = healthy ] && return 0
    # still not answering after 2 minutes: restart it once (the data is in its volume and is kept)
    [ "$i" = 24 ] && docker compose restart postgres >>"$LOG" 2>&1
    sleep 5
  done
  echo "postgres is still unhealthy after 5 minutes" >>"$LOG"
  return 1
}
LOG=/var/log/iplast-deploy.log
RETRY=/var/lib/iplast-deploy-retry

# low disk: one warning a day at most (a full disk stops the database, as on 2026-11-09)
DISKMARK=/var/lib/iplast-disk-warned
f=$(free_gb)
if [ -n "$f" ] && [ "$f" -lt 5 ]; then
  if [ ! -f "$DISKMARK" ] || [ $(( $(date +%s) - $(stat -c %Y "$DISKMARK") )) -gt 86400 ]; then
    cleanup; f=$(free_gb)
    if [ -n "$f" ] && [ "$f" -lt 5 ]; then
      touch "$DISKMARK"
      notify "⚠️ دیسک سرور iPlast تقریباً پر است: فقط ${f} گیگ آزاد مانده. اگر پر شود دیتابیس و سایت از کار می‌افتند. این پیام را برای پشتیبان فنی بفرستید.
$(df -h / | tail -1)"
    fi
  fi
else
  rm -f "$DISKMARK"
fi

git fetch -q origin main || { echo "fetch failed"; exit 1; }
LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ] && [ -z "${FORCE:-}" ]; then
  # the last deploy of this commit failed (the API is not running): try again every 20 minutes, at most 6 times
  [ -n "$(docker compose ps -q --status running api 2>/dev/null)" ] && { rm -f "$RETRY"; exit 0; }
  n=$(cat "$RETRY" 2>/dev/null || echo 0)
  [ "$n" -ge 6 ] && exit 0
  [ -f "$RETRY" ] && [ $(( $(date +%s) - $(stat -c %Y "$RETRY") )) -lt 1200 ] && exit 0
  echo $((n + 1)) >"$RETRY"
fi

git reset -q --hard origin/main
MSG=$(git log -1 --pretty=%s)
# host tools that live outside the repo: this script itself and the daily backup timer
install -m 755 infra/autodeploy.sh /usr/local/bin/iplast-autodeploy 2>/dev/null || true
# the server's own front proxy for ports 80/443 (moves the sites off the old niva Caddy once; see the script)
bash infra/front/install.sh >>/var/log/iplast-front.log 2>&1 || notify "⚠️ جابه‌جایی پروکسی جلوی سایت انجام نشد و پروکسی قبلی دوباره روشن شد؛ جزئیات: /var/log/iplast-front.log"
grep -q 'Fri' /etc/systemd/system/iplast-backup.timer 2>/dev/null || bash infra/backup.sh --install >/dev/null 2>&1 || true
# servers that use the outbound proxy (see infra/proxy): keep its host tools current
if [ -d /opt/iplast-proxy ]; then bash infra/proxy/install.sh >/dev/null 2>&1 || notify "⚠️ iPlast proxy tools update failed"; set -a; . ./.env; set +a; [ -n "${BUILD_PROXY:-}" ] && export HTTPS_PROXY=$BUILD_PROXY HTTP_PROXY=$BUILD_PROXY https_proxy=$BUILD_PROXY http_proxy=$BUILD_PROXY; fi
: >"$LOG"
cleanup
# images are built one at a time, so the build does not take the memory the running database needs
BUILT=1
for s in migrate api bot web; do docker compose build "$s" >>"$LOG" 2>&1 || { BUILT=0; break; }; done
if [ "$BUILT" = 1 ] && wait_db && docker compose up -d --remove-orphans >>"$LOG" 2>&1; then
  rm -f "$RETRY"
  cleanup
  sleep 8
  # a successful deploy is silent (a failed database update is reported once by the API itself)
else
  [ -f "$RETRY" ] || echo 0 >"$RETRY"
  n=$(cat "$RETRY" 2>/dev/null || echo 0)
  # one message when it first fails and one when the retries run out, not one every 20 minutes
  [ "$n" = 0 ] || [ "$n" -ge 6 ] || exit 1
  notify "❌ iPlast deploy failed: ${MSG}
$(tail -n 12 "$LOG")
$(diag)
$([ "$n" -ge 6 ] && echo "(۶ بار دوباره امتحان شد و نشد؛ دیگر خودکار امتحان نمی‌شود)" || echo "(هر ۲۰ دقیقه بی‌صدا دوباره امتحان می‌شود، حداکثر ۶ بار)")"
  exit 1
fi
