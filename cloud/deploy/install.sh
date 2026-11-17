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

# 7. Huli's update files, served under a random path kept in /etc/huli-updates.path, uploaded by
# the build through the huli-upload user, who may only write into the folder (rrsync).
updates_location=''
if [ -s /etc/huli-updates.path ]; then
  segment="$(tr -cd 'a-f0-9' </etc/huli-updates.path)"
  id huli-upload >/dev/null 2>&1 ||
    useradd --system --create-home --home-dir /var/lib/huli-upload --shell /bin/sh huli-upload
  install -d -o huli-upload -g huli-upload -m 755 /var/www/huli-updates
  install -d -o huli-upload -g huli-upload -m 700 /var/lib/huli-upload/.ssh
  if [ -s /tmp/huli_upload.pub ]; then
    printf 'restrict,command="/usr/bin/rrsync -wo /var/www/huli-updates" %s\n' \
      "$(cat /tmp/huli_upload.pub)" >/var/lib/huli-upload/.ssh/authorized_keys
    chown huli-upload:huli-upload /var/lib/huli-upload/.ssh/authorized_keys
    chmod 600 /var/lib/huli-upload/.ssh/authorized_keys
    rm -f /tmp/huli_upload.pub
  fi
  # Keeps the five newest versions; latest/ always names one of them.
  cat >/etc/cron.d/huli-updates-prune <<'EOF'
17 4 * * * root ls -1dt /var/www/huli-updates/download/v* 2>/dev/null | tail -n +6 | xargs -r rm -rf
EOF
  # A phone's browser needs the APK's own type to offer installing it.
  updates_location="
    location ^~ /u/$segment/ {
        alias /var/www/huli-updates/;
        types {
            application/vnd.android.package-archive apk;
            application/json json;
        }
        add_header Cache-Control no-cache;
    }"
fi

# 7b. A snapshot of the service's state every night, kept two weeks, readable by the server's admin
# user so a copy can be pulled off the server. The state is one small file written atomically.
BACKUP_GROUP="${HULI_BACKUP_GROUP:-ubuntu}"
install -d -o root -g "$BACKUP_GROUP" -m 750 /var/backups/huli-cloud
cat >/etc/cron.d/huli-cloud-backup <<EOF
41 3 * * * root f=/var/backups/huli-cloud/state-\$(date -u +\\%Y\\%m\\%d).json; install -m 640 -g $BACKUP_GROUP /var/lib/huli-cloud/state.json "\$f" && ln -sfn "\$f" /var/backups/huli-cloud/latest.json && find /var/backups/huli-cloud -name 'state-*.json' -mtime +14 -delete
EOF

# 7c. The privacy policy, which TestFlight's external testing asks a link to.
install -d -o root -g root -m 755 /var/www/huli-static
cat >/var/www/huli-static/privacy.html <<'EOF'
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Huli 隐私政策</title>
<style>body{font:16px/1.7 -apple-system,"PingFang SC",sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#222}</style>
</head><body>
<h1>Huli 隐私政策</h1>
<p>Huli 是开发者自用的工具：桌面端在自己的电脑上运行 AI 编程助手，手机端用来查看和操作这台电脑上的会话。</p>
<h2>收集的信息</h2>
<p>Huli 不收集、不出售、不分享任何个人信息，不含广告和第三方统计。</p>
<h2>数据去向</h2>
<ul>
<li>手机和电脑之间的内容经端到端加密，直接在两者之间传输（局域网或 Tailscale），不经过任何服务器。</li>
<li>登录和推送由开发者自己的服务器（Huli Cloud）处理：只保存账号、已登录设备和推送所需的设备标识；推送内容在电脑上加密，只有手机能解开，服务器和 Apple 都看不到。</li>
<li>拍照、相册和文件只在你主动选择后发送到你自己的电脑。</li>
</ul>
<h2>联系</h2>
<p>a2768811@icloud.com</p>
<h1 lang="en" style="margin-top:48px">Privacy Policy (English)</h1>
<p lang="en">Huli collects no personal data and has no ads or analytics. What the phone and the computer exchange is end-to-end encrypted and travels between them directly. The developer's own server handles sign-in and push only, storing the account, signed-in devices and push tokens; push contents are encrypted for the phone alone. Photos and files are sent only when you choose them, to your own computer.</p>
</body></html>
EOF
chmod 644 /var/www/huli-static/privacy.html

# 8. nginx site.
cat >/etc/nginx/sites-available/huli-cloud <<EOF
server {
    listen 443 ssl;
    server_name $DOMAIN;
    server_tokens off;
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 1m;
    access_log /var/log/nginx/huli-cloud.log;$updates_location
    location = /privacy {
        default_type text/html;
        alias /var/www/huli-static/privacy.html;
    }
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

# 9. fail2ban: five failed sign-ins in 15 minutes ban the address for an hour.
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
