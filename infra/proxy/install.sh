#!/usr/bin/env bash
# Installs/updates the host side of the outbound proxy (see iplast-proxy.py). Idempotent; autodeploy runs it
# on every deploy when /opt/iplast-proxy exists. Needs the xray binary at /opt/iplast-proxy/xray.
set -euo pipefail
HOME_DIR=/opt/iplast-proxy
cd "$(dirname "$0")/../.."
[ -x "$HOME_DIR/xray" ] || { echo "xray missing in $HOME_DIR"; exit 1; }
mkdir -p "$HOME_DIR/inbox"
install -m 755 infra/proxy/iplast-proxy.py /usr/local/bin/iplast-proxy

cat > /etc/systemd/system/iplast-proxy.service <<UNIT
[Unit]
Description=iPlast outbound proxy (xray)
After=network-online.target docker.service
[Service]
ExecStart=$HOME_DIR/xray run -config $HOME_DIR/config.json
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
# a new subscription saved in the admin panel lands in inbox/request.txt
cat > /etc/systemd/system/iplast-proxy-apply.path <<UNIT
[Unit]
Description=Apply a new iPlast proxy subscription from the admin panel
[Path]
PathExists=$HOME_DIR/inbox/request.txt
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/iplast-proxy-apply.service <<UNIT
[Unit]
Description=Apply iPlast proxy subscription
[Service]
Type=oneshot
ExecStart=/usr/local/bin/iplast-proxy apply
UNIT
cat > /etc/systemd/system/iplast-proxy-check.service <<UNIT
[Unit]
Description=Check the iPlast proxy and switch servers when it fails
[Service]
Type=oneshot
ExecStart=/usr/local/bin/iplast-proxy check
UNIT
cat > /etc/systemd/system/iplast-proxy-check.timer <<UNIT
[Unit]
Description=Check the iPlast proxy every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now iplast-proxy.service iplast-proxy-apply.path iplast-proxy-check.timer >/dev/null 2>&1
# the API container reads status.json and drops request.txt here
if [ -f .env ] && ! grep -q '^PROXY_INBOX=' .env; then printf '\nPROXY_INBOX=%s/inbox\n' "$HOME_DIR" >> .env; fi
echo "proxy tools installed"
