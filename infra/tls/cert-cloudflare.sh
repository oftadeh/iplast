#!/usr/bin/env bash
# HTTPS certificate for the mini app when the server cannot be reached from abroad (e.g. inside Iran):
# Let's Encrypt validates through Cloudflare DNS (DNS-01), so no inbound connection is needed.
# The DNS record of HOST must be "DNS only" (grey cloud) and point to this server.
#
#   bash infra/tls/cert-cloudflare.sh iplast.iplas.co     first run: asks once for a Cloudflare API token
#                                                         ("Edit zone DNS" template), installs a weekly renew timer
#
# The certificate is served by the shared Caddy of this machine (CADDY_CONTAINER, CADDYFILE below): the cert files
# go into its /data volume and an iPlast site block in its Caddyfile is replaced with one for HOST.
set -euo pipefail
HOST=${1:-$(cat /opt/iplast-tls/host 2>/dev/null || true)}
[ -n "$HOST" ] || { echo "usage: $0 <host>"; exit 1; }
DIR=/opt/iplast-tls
PROXY=${TLS_PROXY:-http://127.0.0.1:10809}  # host xray (infra/proxy)
CADDY_CONTAINER=${CADDY_CONTAINER:-niva-panel-proxy-1}
CADDYFILE=${CADDYFILE:-/opt/niva/deploy/panel-ip.Caddyfile}
UPSTREAM=${UPSTREAM:-172.17.0.1:8088}
mkdir -p "$DIR"; chmod 700 "$DIR"; echo "$HOST" > "$DIR/host"

if [ ! -s "$DIR/cf-token" ]; then
  read -rsp "Cloudflare API token (Edit zone DNS for ${HOST#*.}): " T; echo
  [ -n "$T" ] || { echo "no token"; exit 1; }
  umask 077; printf %s "$T" > "$DIR/cf-token"; unset T
fi

if [ ! -x "$DIR/lego" ]; then
  echo "Downloading lego..."
  curl -fsSL -x "$PROXY" -o "$DIR/lego.tgz" https://github.com/go-acme/lego/releases/download/v4.21.0/lego_v4.21.0_linux_amd64.tar.gz
  tar -xzf "$DIR/lego.tgz" -C "$DIR" lego; rm -f "$DIR/lego.tgz"
fi

export CF_DNS_API_TOKEN_FILE="$DIR/cf-token" HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY"
ARGS=(--accept-tos --email "admin@${HOST#*.}" --path "$DIR/lego" --dns cloudflare --dns.propagation-wait 90s -d "$HOST")
CRT="$DIR/lego/certificates/$HOST.crt"
BEFORE=$(stat -c %Y "$CRT" 2>/dev/null || echo 0)
if [ -s "$CRT" ]; then "$DIR/lego" "${ARGS[@]}" renew --days 30; else "$DIR/lego" "${ARGS[@]}" run; fi
AFTER=$(stat -c %Y "$CRT")

# install into the shared Caddy (its /data volume) and make sure the site block exists
DATA=$(docker volume inspect -f '{{.Mountpoint}}' "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$CADDY_CONTAINER")")
mkdir -p "$DATA/iplast"
install -m 644 "$CRT" "$DATA/iplast/cert.crt"
install -m 600 "$DIR/lego/certificates/$HOST.key" "$DATA/iplast/cert.key"

python3 - "$CADDYFILE" "$HOST" "$UPSTREAM" <<'PY'
import sys
path, host, upstream = sys.argv[1:]
lines = open(path).read().split('\n')
out, i = [], 0
while i < len(lines):  # drop any earlier iPlast block (comment line + the braced block after it)
    if lines[i].startswith('# iPlast'):
        i += 1
        depth, started = 0, False
        while i < len(lines):
            depth += lines[i].count('{') - lines[i].count('}')
            started = started or '{' in lines[i]
            i += 1
            if started and depth <= 0:
                break
        continue
    out.append(lines[i]); i += 1
while out and out[-1] == '':
    out.pop()
out += ['', f'# iPlast mini app + admin panel (/opt/iplast, web container on {upstream}); cert from /opt/iplast-tls',
        f'{host} {{', '\ttls /data/iplast/cert.crt /data/iplast/cert.key', '\tencode gzip',
        '\trequest_body {', '\t\tmax_size 21MB', '\t}', f'\treverse_proxy {upstream}', '}', '']
with open(path, 'r+') as f:  # rewrite in place: the file is bind-mounted into the Caddy container
    f.seek(0); f.write('\n'.join(out)); f.truncate()
PY
docker exec -i "$CADDY_CONTAINER" caddy validate --adapter caddyfile --config /dev/stdin < "$CADDYFILE" >/dev/null 2>&1 \
  || { echo "Caddyfile is not valid; not reloaded"; exit 1; }
docker exec -i "$CADDY_CONTAINER" caddy reload --adapter caddyfile --config /dev/stdin < "$CADDYFILE" 2>/dev/null
[ "$BEFORE" != "$AFTER" ] && echo "Certificate for $HOST installed."

# point the app at HOST
if [ -f /opt/iplast/.env ] && ! grep -q "^SITE_HOST=$HOST$" /opt/iplast/.env; then
  sed -i "s|^SITE_HOST=.*|SITE_HOST=$HOST|; s|^MINIAPP_URL=.*|MINIAPP_URL=https://$HOST|" /opt/iplast/.env
  (cd /opt/iplast && docker compose up -d >/dev/null 2>&1) && echo "Mini app: https://$HOST  Admin: https://$HOST/admin/"
fi

# weekly renewal
if [ ! -f /etc/systemd/system/iplast-tls.timer ]; then
  cat > /etc/systemd/system/iplast-tls.service <<UNIT
[Unit]
Description=Renew the iPlast HTTPS certificate
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/iplast/infra/tls/cert-cloudflare.sh
UNIT
  cat > /etc/systemd/system/iplast-tls.timer <<UNIT
[Unit]
Description=Weekly iPlast certificate renewal
[Timer]
OnCalendar=weekly
RandomizedDelaySec=6h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload && systemctl enable --now iplast-tls.timer
fi
