#!/usr/bin/env bash
# Weekly backup of an iPlast server: database, uploaded files (photos, documents, price-list PDFs) and server settings.
#   sudo bash /opt/iplast/infra/backup.sh            take a backup now
#   sudo bash /opt/iplast/infra/backup.sh --install  install the weekly timer (Friday 03:30) and take a first backup
# Backups go to /opt/iplast-backups/<date>/ (root only) and the newest KEEP (default 8, two months) are kept.
# One archive with all the data (database + uploads) is also sent to the senior manager in Telegram, split into
# parts under Telegram's 50 MB limit (BACKUP_TELEGRAM=0 in .env turns this off), so a copy lives off the server.
# That is the only message the backup sends. .env holds secrets and is never sent; it stays on the server.
# Restore: see docs/BUILD.md, section «بازگردانی پشتیبان».
set -uo pipefail
DIR=/opt/iplast
OUT_ROOT=/opt/iplast-backups
SELF="$DIR/infra/backup.sh"

if [ "${1:-}" = "--install" ]; then
  cat > /etc/systemd/system/iplast-backup.service <<UNIT
[Unit]
Description=iPlast backup (database, uploads, settings)
After=docker.service
[Service]
Type=oneshot
ExecStart=/bin/bash $SELF
UNIT
  cat > /etc/systemd/system/iplast-backup.timer <<UNIT
[Unit]
Description=Weekly iPlast backup
[Timer]
OnCalendar=Fri *-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now iplast-backup.timer >/dev/null 2>&1
  # first backup soon (after a running deploy has settled) when there is none yet
  ls -d "$OUT_ROOT"/2* >/dev/null 2>&1 || systemd-run --quiet --on-active=10min --unit="iplast-backup-first-$(date +%s)" \
    /bin/systemctl start iplast-backup.service >/dev/null 2>&1 || true
  echo "backup timer installed"
  exit 0
fi

cd "$DIR" || exit 1
set -a; . ./.env; set +a
[ -n "${BUILD_PROXY:-}" ] && export HTTPS_PROXY=$BUILD_PROXY https_proxy=$BUILD_PROXY
KEEP="${BACKUP_KEEP:-8}"
STAMP=$(date +%Y-%m-%d_%H%M)
OUT="$OUT_ROOT/$STAMP"
umask 077
mkdir -p "$OUT"
LOG="$OUT/backup.log"
ok=1

# 1) database (plain SQL, gzip)
if docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists 2>>"$LOG" | gzip -9 > "$OUT/db.sql.gz" \
   && [ "$(gzip -cd "$OUT/db.sql.gz" | head -c 200 | wc -c)" -gt 0 ]; then :; else ok=0; echo "pg_dump failed" >>"$LOG"; fi

# 2) uploaded product photos
docker compose exec -T api tar -C /data/uploads -czf - . > "$OUT/uploads.tar.gz" 2>>"$LOG" || { ok=0; echo "uploads failed" >>"$LOG"; }

# 3) server settings (secrets: stay on this server only)
tar -czf "$OUT/settings.tar.gz" -C / opt/iplast/.env \
  $(cd / && ls -d opt/iplast-proxy/source.txt opt/iplast-proxy/config.json opt/iplast-tls/host opt/iplast-tls/cf-token opt/iplast-tls/data 2>/dev/null) 2>>"$LOG" || { ok=0; echo "settings failed" >>"$LOG"; }
git rev-parse HEAD > "$OUT/commit.txt" 2>/dev/null
( cd "$OUT" && sha256sum db.sql.gz uploads.tar.gz settings.tar.gz > SHA256SUMS 2>/dev/null )

# rotation
ls -1d "$OUT_ROOT"/2* 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf

SIZE=$(du -sh "$OUT" | cut -f1)
# the senior manager: the one set in the panel after a transfer, else the first ADMIN_TELEGRAM_IDS
owner_id() {
  local v
  v=$(cd /opt/iplast 2>/dev/null && timeout 15 docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT value->>0 FROM \"Setting\" WHERE key='owner.telegramIds'" 2>/dev/null | tr -cd '0-9')
  echo "${v:-${ADMIN_TELEGRAM_IDS%%,*}}"
}
tg() { curl -fsS -m 300 "https://api.telegram.org/bot${BOT_TOKEN}/$1" "${@:2}" >/dev/null 2>>"$LOG"; }
ID="$(owner_id)"
if [ -n "${BOT_TOKEN:-}" ] && [ -n "$ID" ] && [ "${BACKUP_TELEGRAM:-1}" != 0 ]; then
  if [ "$ok" = 1 ]; then
    # all the data in one archive, split into 45 MB parts (a bot may send files up to 50 MB)
    SEND="$OUT/send"; mkdir -p "$SEND"
    tar -C "$OUT" -cf - db.sql.gz uploads.tar.gz commit.txt SHA256SUMS 2>>"$LOG" | split -b 45M -d -a 2 - "$SEND/iplast-backup-$STAMP.tar.part"
    PARTS=$(ls -1 "$SEND" | wc -l)
    i=0
    for f in "$SEND"/*; do
      i=$((i + 1))
      CAP="🗄 پشتیبان هفتگی iPlast ($STAMP): دیتابیس و همه‌ی فایل‌ها، $SIZE"
      [ "$PARTS" -gt 1 ] && CAP="$CAP، بخش $i از $PARTS (برای بازکردن: cat iplast-backup-*.part* > backup.tar)"
      tg sendDocument -F "chat_id=$ID" -F "document=@$f" -F "caption=$CAP" -F disable_notification=true \
        || { echo "telegram upload failed: $f" >>"$LOG"; break; }
    done
    rm -rf "$SEND"
  else
    tg sendMessage --data-urlencode "chat_id=$ID" --data-urlencode "text=⚠️ پشتیبان هفتگی iPlast ($STAMP) کامل نشد؛ جزئیات روی سرور: $LOG" || true
  fi
fi
echo "backup $STAMP: $([ $ok = 1 ] && echo ok || echo 'with errors') ($SIZE) in $OUT"
[ "$ok" = 1 ]
