#!/usr/bin/env bash
# Installs or upgrades Huli Cloud on oracle-relay (Ubuntu 24.04, arm64). Run as root, with the
# bundle at /tmp/huli-cloud.mjs. Safe to run again: it replaces the program and the unit, and keeps
# the data, the environment file, the certificate and the account.
set -euo pipefail

DOMAIN=huli.132-145-200-0.sslip.io

# 1. User and folders.
id huli >/dev/null 2>&1 ||
  useradd --system --home-dir /var/lib/huli-cloud --no-create-home --shell /usr/sbin/nologin huli
install -d -o root -g root -m 755 /opt/huli-cloud
install -d -o huli -g huli -m 700 /var/lib/huli-cloud

# 2. Node.js 24 LTS from nodejs.org, checked against its SHA-256, kept apart from the system.
if [ ! -x /opt/huli-cloud/node/bin/node ]; then
  tmp=$(mktemp -d)
  sums=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt)
  file=$(printf '%s\n' "$sums" | awk '/linux-arm64\.tar\.xz$/ {print $2}')
  curl -fsSL -o "$tmp/$file" "https://nodejs.org/dist/latest-v24.x/$file"
  (cd "$tmp" && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c -)
  install -d -o root -g root -m 755 /opt/huli-cloud/node
  tar -xJf "$tmp/$file" -C /opt/huli-cloud/node --strip-components=1 --no-same-owner
  rm -rf "$tmp"
fi
/opt/huli-cloud/node/bin/node --version

# 3. The program.
install -o root -g root -m 644 /tmp/huli-cloud.mjs /opt/huli-cloud/huli-cloud.mjs

# 4. Settings, readable by root and huli only; never overwritten.
if [ ! -f /etc/huli-cloud.env ]; then
  cat >/etc/huli-cloud.env <<EOF
HULI_ORIGIN=https://$DOMAIN
HULI_DATA_DIR=/var/lib/huli-cloud
HULI_HOST=127.0.0.1
HULI_PORT=3010
HULI_TRUST_PROXY=1
EOF
  chown root:huli /etc/huli-cloud.env
  chmod 640 /etc/huli-cloud.env
fi

# 5. The service, sandboxed: it may write only its data folder.
cat >/etc/systemd/system/huli-cloud.service <<'EOF'
[Unit]
Description=Huli Cloud (account service and push gateway)
After=network-online.target
Wants=network-online.target

[Service]
User=huli
Group=huli
EnvironmentFile=/etc/huli-cloud.env
ExecStart=/opt/huli-cloud/node/bin/node /opt/huli-cloud/huli-cloud.mjs serve
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/huli-cloud
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable huli-cloud >/dev/null
systemctl restart huli-cloud
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS http://127.0.0.1:3010/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:3010/healthz && echo ' <- huli-cloud'

# 6. Certificate through the shared ACME webroot that port 80 already serves.
certbot certonly --webroot -w /var/www/acme -d "$DOMAIN" --non-interactive --keep-until-expiring

# 7. nginx site.
cat >/etc/nginx/sites-available/huli-cloud <<EOF
server {
    listen 443 ssl;
    server_name $DOMAIN;
    server_tokens off;
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 1m;
    access_log /var/log/nginx/huli-cloud.log;
    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
EOF
ln -sfn /etc/nginx/sites-available/huli-cloud /etc/nginx/sites-enabled/huli-cloud
nginx -t
systemctl reload nginx

# 8. fail2ban: five failed sign-ins in 15 minutes ban the address for an hour.
cat >/etc/fail2ban/filter.d/huli-cloud.conf <<'EOF'
[Definition]
failregex = huli-cloud: login failed from <HOST>$
journalmatch = _SYSTEMD_UNIT=huli-cloud.service
EOF
cat >/etc/fail2ban/jail.d/huli-cloud.conf <<'EOF'
[huli-cloud]
enabled = true
backend = systemd
port = http,https
filter = huli-cloud
maxretry = 5
findtime = 15m
bantime = 1h
EOF
fail2ban-client reload >/dev/null
fail2ban-client status huli-cloud | head -3

curl -fsS "https://$DOMAIN/healthz" && echo " <- https://$DOMAIN"
