#!/usr/bin/env bash
# iPlast's own front proxy for ports 80/443 (container «iplast-front», Caddy).
#
# On the shared server the sites (iplast.keyfitapp.ir and keyfitapp.ir) were served by niva-panel-proxy-1, a Caddy
# left over from the niva project: its Caddyfile was deleted from the host, so a restart of that container or of the
# server would have taken both sites down. This script moves the same sites to a container whose config lives in
# /opt/iplast-front/Caddyfile, keeping Caddy's /data and /config volumes (all certificates stay, nothing is re-issued).
#
#   sudo bash /opt/iplast/infra/front/install.sh     (also run by autodeploy; does nothing once iplast-front exists)
#
# The switch takes a few seconds. If the new proxy does not answer for both sites, it is removed and the old one is
# started again with the same config, so the sites come back as they were.
set -uo pipefail
DIR=/opt/iplast-front
OLD=${OLD_FRONT:-niva-panel-proxy-1}
NEW=iplast-front
HOST=$(cat /opt/iplast-tls/host 2>/dev/null || echo iplast.keyfitapp.ir)
UPSTREAM=${UPSTREAM:-172.17.0.1:8088}

if docker inspect "$NEW" >/dev/null 2>&1; then
  # already moved: make sure it runs (it has restart=unless-stopped, this is only a safety net)
  [ "$(docker inspect -f '{{.State.Running}}' "$NEW")" = true ] || docker start "$NEW" >/dev/null
  exit 0
fi
docker inspect "$OLD" >/dev/null 2>&1 || { echo "no $OLD on this server: nothing to move"; exit 0; }

IMAGE=$(docker inspect -f '{{.Config.Image}}' "$OLD")
vol() { docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$1\"}}{{.Name}}{{end}}{{end}}" "$OLD"; }
DATA=$(vol /data); CONF=$(vol /config)
[ -n "$DATA" ] && [ -n "$CONF" ] || { echo "cannot find the Caddy volumes of $OLD"; exit 1; }

mkdir -p "$DIR"
if [ ! -s "$DIR/Caddyfile" ]; then
  cat > "$DIR/Caddyfile" <<CADDY
# Front proxy of this server (container iplast-front). Edit, then reload with:
#   docker exec iplast-front caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

# keyfit (/opt/keyfit, container keyfitapp-app-1 published on 172.17.0.1:18090); certificate managed by Caddy
keyfitapp.ir {
	request_body {
		max_size 21MB
	}
	reverse_proxy 172.17.0.1:18090 {
		flush_interval -1
		header_up X-Forwarded-For {remote_host}
	}
}

# iPlast mini app + admin panel (/opt/iplast, web container on $UPSTREAM); cert from /opt/iplast-tls
$HOST {
	tls /data/iplast/cert.crt /data/iplast/cert.key
	encode gzip
	request_body {
		max_size 21MB
	}
	reverse_proxy $UPSTREAM
}
CADDY
fi

docker run --rm -v "$DIR":/etc/caddy:ro -v "$DATA":/data "$IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || { echo "the new Caddyfile is not valid; nothing changed"; exit 1; }

# answers for a site through this server's own port 443 (2xx-4xx counts: the site is up and the proxy routes it)
up() { local c; c=$(curl -sk -o /dev/null -m 10 -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1/"); [ "${c:-000}" -ge 200 ] && [ "$c" -lt 500 ]; }

docker stop "$OLD" >/dev/null
docker run -d --name "$NEW" --restart unless-stopped -p 80:80 -p 443:443 -p 443:443/udp \
  -v "$DATA":/data -v "$CONF":/config -v "$DIR":/etc/caddy:ro "$IMAGE" >/dev/null
ok=0
for i in $(seq 1 15); do sleep 2; if up "$HOST" && up keyfitapp.ir; then ok=1; break; fi; done

if [ "$ok" = 1 ]; then
  docker rm "$OLD" >/dev/null
  echo "front proxy moved to $NEW ($DIR/Caddyfile)"
  exit 0
fi
# roll back: the old container with the same config (its Caddyfile path on the host is recreated)
docker logs --tail 40 "$NEW" >"$DIR/failed-switch.log" 2>&1
docker rm -f "$NEW" >/dev/null
SRC=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$OLD")
if [ -n "$SRC" ] && [ ! -s "$SRC" ]; then rm -rf "$SRC"; mkdir -p "$(dirname "$SRC")"; cp "$DIR/Caddyfile" "$SRC"; fi
docker start "$OLD" >/dev/null
echo "the new front proxy did not answer; $OLD is running again (see $DIR/failed-switch.log)"
exit 1
