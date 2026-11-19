#!/usr/bin/env bash
# Installs or upgrades Huli Cloud on oracle-relay (Ubuntu 24.04, arm64): the account service, the
# push gateway, the relay and the hosted web client. Run as root, as `install.sh [folder]`, with
# the folder (/tmp by default) holding huli-cloud.mjs and, when they are to be installed too,
# regions.signed.json (the signed relay region list) and huli-web.tar.gz with
# huli-web.tar.gz.sha256 (the hosted web client). tools/huli/deploy-cloud.ps1 uploads them and runs
# this. Safe to run again: it replaces the program, the unit, the region list and the web client,
# keeping the program and the web client before as .prev, and keeps the data, the environment file
# (adding only settings it lacks), the certificates and the account.
set -euo pipefail

DOMAIN=huli.132-145-200-0.sslip.io
APP_DOMAIN=app.huli.132-145-200-0.sslip.io
FROM="${1:-/tmp}"

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

# 3. The program, the one before kept as huli-cloud.mjs.prev, and the signed region list.
if [ -f /opt/huli-cloud/huli-cloud.mjs ] &&
  ! cmp -s "$FROM/huli-cloud.mjs" /opt/huli-cloud/huli-cloud.mjs; then
  cp -p /opt/huli-cloud/huli-cloud.mjs /opt/huli-cloud/huli-cloud.mjs.prev
fi
install -o root -g root -m 644 "$FROM/huli-cloud.mjs" /opt/huli-cloud/huli-cloud.mjs
if [ -f "$FROM/regions.signed.json" ]; then
  install -o root -g root -m 644 "$FROM/regions.signed.json" /opt/huli-cloud/regions.signed.json
fi

# 4. Settings, readable by root and huli only; never overwritten, only given what they lack.
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
grep -q '^HULI_WEB_ORIGIN=' /etc/huli-cloud.env ||
  echo "HULI_WEB_ORIGIN=https://$APP_DOMAIN" >>/etc/huli-cloud.env
if [ -f /opt/huli-cloud/regions.signed.json ]; then
  grep -q '^HULI_REGIONS_FILE=' /etc/huli-cloud.env ||
    echo 'HULI_REGIONS_FILE=/opt/huli-cloud/regions.signed.json' >>/etc/huli-cloud.env
fi

# 4b. The hosted web client, checked against its SHA-256; the one before kept as huli-app.prev.
if [ -f "$FROM/huli-web.tar.gz" ]; then
  (cd "$FROM" && sha256sum -c huli-web.tar.gz.sha256)
  rm -rf /var/www/huli-app.new
  install -d -o root -g root -m 755 /var/www/huli-app.new
  tar -xzf "$FROM/huli-web.tar.gz" -C /var/www/huli-app.new --no-same-owner --no-same-permissions
  test -f /var/www/huli-app.new/index.html
  chmod -R u=rwX,go=rX /var/www/huli-app.new
  if [ -d /var/www/huli-app ]; then
    rm -rf /var/www/huli-app.prev
    mv /var/www/huli-app /var/www/huli-app.prev
  fi
  mv /var/www/huli-app.new /var/www/huli-app
fi

# 5. The service, sandboxed: it may write only its data folder.
cat >/etc/systemd/system/huli-cloud.service <<'EOF'
[Unit]
Description=Huli Cloud (account service, push gateway and relay)
After=network-online.target
Wants=network-online.target

[Service]
User=huli
Group=huli
EnvironmentFile=/etc/huli-cloud.env
ExecStart=/opt/huli-cloud/node/bin/node /opt/huli-cloud/huli-cloud.mjs serve
Restart=on-failure
RestartSec=3
LimitNOFILE=4096
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
curl -fsS http://127.0.0.1:3010/v1 && echo ' <- relay'

# 6. Certificates through the shared ACME webroot that port 80 already serves: the service's, and
# the hosted web client's on a name of its own, so its pages share no origin with the sign-in's.
certbot certonly --webroot -w /var/www/acme -d "$DOMAIN" --non-interactive --keep-until-expiring
app_site=''
if [ -d /var/www/huli-app ]; then
  certbot certonly --webroot -w /var/www/acme -d "$APP_DOMAIN" --non-interactive --keep-until-expiring
  app_site=1
fi

# 7. Huli's update files, served under a random path kept in /etc/huli-updates.path, uploaded by
# the build through the huli-upload user, who may only write into the folder (rrsync). Its key
# comes from the deploy folder as huli_upload.pub, only when that folder and the file are root's or
# the deploying user's and nobody else may write the folder: a fixed name in /tmp is anyone's.
updates_location=''
if [ -s /etc/huli-updates.path ]; then
  segment="$(tr -cd 'a-f0-9' </etc/huli-updates.path)"
  id huli-upload >/dev/null 2>&1 ||
    useradd --system --create-home --home-dir /var/lib/huli-upload --shell /bin/sh huli-upload
  install -d -o huli-upload -g huli-upload -m 755 /var/www/huli-updates
  install -d -o huli-upload -g huli-upload -m 700 /var/lib/huli-upload/.ssh
  pub="$FROM/huli_upload.pub"
  if [ -f "$pub" ] && [ ! -L "$pub" ]; then
    ours() {
      local owner
      owner=$(stat -c %U "$1")
      [ "$owner" = root ] || [ "$owner" = "${SUDO_USER:-root}" ]
    }
    key_type='(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com|ssh-rsa)'
    if ours "$FROM" && ours "$pub" && [ -z "$(find "$FROM" -maxdepth 0 -perm /022)" ] &&
      [ "$(grep -c '' "$pub")" = 1 ] &&
      grep -Eq "^$key_type [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._+-]*)?\$" "$pub" &&
      ssh-keygen -l -f "$pub" >/dev/null 2>&1; then
      # The type and the key alone, after the options that confine it to rrsync in the folder.
      printf 'restrict,command="/usr/bin/rrsync -wo /var/www/huli-updates" %s huli-upload\n' \
        "$(cut -d' ' -f1,2 "$pub")" >/var/lib/huli-upload/.ssh/authorized_keys.new
      chown huli-upload:huli-upload /var/lib/huli-upload/.ssh/authorized_keys.new
      chmod 600 /var/lib/huli-upload/.ssh/authorized_keys.new
      mv /var/lib/huli-upload/.ssh/authorized_keys.new /var/lib/huli-upload/.ssh/authorized_keys
      echo 'huli-upload key replaced'
    else
      echo "$pub is not one SSH public key in a folder only root or ${SUDO_USER:-root} writes;" \
        'the upload key is unchanged' >&2
    fi
    rm -f "$pub"
  fi
  # Keeps the five newest versions; latest/ always names one of them.
  cat >/etc/cron.d/huli-updates-prune <<'EOF'
17 4 * * * root ls -1dt /var/www/huli-updates/download/v* 2>/dev/null | tail -n +6 | xargs -r rm -rf
EOF
  # A phone's browser needs the APK's own type to offer installing it, and an iPhone's installer
  # takes the itms-services manifest as XML (Apple names text/xml) and the IPA as bytes. Nothing
  # here is a page: the sandbox keeps a document a stolen upload key put here from running script
  # on the service's origin.
  updates_location="
    location ^~ /u/$segment/ {
        alias /var/www/huli-updates/;
        types {
            application/vnd.android.package-archive apk;
            application/json json;
            application/octet-stream ipa;
            text/xml plist;
        }
        add_header Cache-Control no-cache;
        add_header Content-Security-Policy sandbox;
    }"
fi

# 7b. A snapshot of the service's state every night, kept two weeks, root's alone: it holds the
# account's TOTP secret and password hash, so a copy is pulled off the server with sudo. The state
# is one small file written atomically. Snapshots an earlier run left readable by a group are
# closed too.
install -d -o root -g root -m 700 /var/backups/huli-cloud
chown root:root /var/backups/huli-cloud
chmod 700 /var/backups/huli-cloud
find /var/backups/huli-cloud -maxdepth 1 -type f -name 'state-*.json' \
  -exec chown root:root {} + -exec chmod 600 {} +
cat >/etc/cron.d/huli-cloud-backup <<'EOF'
41 3 * * * root f=/var/backups/huli-cloud/state-$(date -u +\%Y\%m\%d).json; install -m 600 -o root -g root /var/lib/huli-cloud/state.json "$f" && ln -sfn "$f" /var/backups/huli-cloud/latest.json && find /var/backups/huli-cloud -name 'state-*.json' -mtime +14 -delete
EOF

# 7c. The privacy policy, which TestFlight's external testing asks a link to.
install -d -o root -g root -m 755 /var/www/huli-static
cat >/var/www/huli-static/privacy.html <<'EOF'
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>纸鸢 Kite 隐私政策</title>
<style>body{font:16px/1.7 -apple-system,"PingFang SC",sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#222}</style>
</head><body>
<h1>纸鸢 Kite 隐私政策</h1>
<p>纸鸢（Kite）是开发者自用的工具：桌面端在自己的电脑上运行 AI 编程助手，手机端用来查看和操作这台电脑上的会话。</p>
<h2>收集的信息</h2>
<p>纸鸢不收集、不出售、不分享任何个人信息，不含广告和第三方统计。</p>
<h2>数据去向</h2>
<ul>
<li>手机、浏览器和电脑之间的内容经端到端加密，在两者之间直接传输（局域网或 Tailscale）；不在同一网络时经开发者自己的中转服务器（Kite Cloud）转发，中转只传递加密后的数据，看不到内容。</li>
<li>登录和推送由开发者自己的服务器（Kite Cloud）处理：只保存账号、已登录设备和推送所需的设备标识；推送内容在电脑上加密，只有手机能解开，服务器和 Apple 都看不到。</li>
<li>拍照、相册和文件只在你主动选择后发送到你自己的电脑。</li>
</ul>
<h2>联系</h2>
<p>a2768811@icloud.com</p>
<h1 lang="en" style="margin-top:48px">Privacy Policy (English)</h1>
<p lang="en">Kite collects no personal data and has no ads or analytics. What the phone and the computer exchange is end-to-end encrypted and travels between them directly, or, when they are on different networks, through the developer's own relay, which passes on only encrypted data it cannot read. The developer's own server handles sign-in, the relay and push only, storing the account, signed-in devices and push tokens; push contents are encrypted for the phone alone. Photos and files are sent only when you choose them, to your own computer.</p>
</body></html>
EOF
chmod 644 /var/www/huli-static/privacy.html

# 8. nginx sites. The relay's WebSockets (/v1/hosts/...) are upgraded to the service, which pings
# every socket every 30 s, so two minutes without a frame either way means the peer is gone. The
# files before are kept, and put back when nginx refuses the new ones, so that nginx's next reload
# or restart does not trip on them.
nginx_files='sites-available/huli-cloud sites-available/huli-app snippets/huli-app-headers.conf
  sites-enabled/huli-cloud sites-enabled/huli-app'
nginx_before=$(mktemp -d)
for f in $nginx_files; do
  if [ -e "/etc/nginx/$f" ] || [ -L "/etc/nginx/$f" ]; then
    mkdir -p "$nginx_before/$(dirname "$f")"
    cp -P -p "/etc/nginx/$f" "$nginx_before/$f"
  fi
done
restore_nginx() {
  for f in $nginx_files; do
    rm -f "/etc/nginx/$f"
    if [ -e "$nginx_before/$f" ] || [ -L "$nginx_before/$f" ]; then
      cp -P -p "$nginx_before/$f" "/etc/nginx/$f"
    fi
  done
}
cat >/etc/nginx/sites-available/huli-cloud <<EOF
map \$http_upgrade \$huli_connection_upgrade {
    default upgrade;
    ''      close;
}
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
    location /v1/hosts/ {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$huli_connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
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

# 8b. The hosted web client: static files under the policy the remote host gives its own web
# client, with connections allowed to the service and its relay alone. A path that is no file is
# the page itself, as /pair and /signin/callback are; the hashed assets are kept for a year.
cat >/etc/nginx/snippets/huli-app-headers.conf <<EOF
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://$DOMAIN wss://$DOMAIN; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
add_header Cross-Origin-Opener-Policy same-origin always;
add_header Cross-Origin-Resource-Policy same-origin always;
add_header X-Frame-Options DENY always;
add_header Strict-Transport-Security "max-age=31536000" always;
EOF
if [ -n "$app_site" ]; then
  cat >/etc/nginx/sites-available/huli-app <<EOF
server {
    listen 443 ssl;
    server_name $APP_DOMAIN;
    server_tokens off;
    ssl_certificate /etc/letsencrypt/live/$APP_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$APP_DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    access_log /var/log/nginx/huli-app.log;
    root /var/www/huli-app;
    location /assets/media-worker- {
        limit_except GET { deny all; }
        include snippets/huli-app-headers.conf;
        add_header Service-Worker-Allowed / always;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files \$uri =404;
    }
    location /assets/ {
        limit_except GET { deny all; }
        include snippets/huli-app-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files \$uri =404;
    }
    location / {
        limit_except GET { deny all; }
        include snippets/huli-app-headers.conf;
        add_header Cache-Control no-cache always;
        try_files \$uri /index.html;
    }
}
EOF
  ln -sfn /etc/nginx/sites-available/huli-app /etc/nginx/sites-enabled/huli-app
fi
ln -sfn /etc/nginx/sites-available/huli-cloud /etc/nginx/sites-enabled/huli-cloud
if ! nginx -t; then
  restore_nginx
  rm -rf "$nginx_before"
  echo 'nginx refused the new sites; the ones before are back and nginx was not reloaded' >&2
  exit 1
fi
rm -rf "$nginx_before"
systemctl reload nginx

# 9. fail2ban: ten failed sign-ins or invite codes in 15 minutes ban the address for an hour. The
# service itself already stops an address after five failures for one account, and after ten in
# all; ten here keeps one account's failures from banning another account's user on the same
# address (a shared NAT).
cat >/etc/fail2ban/filter.d/huli-cloud.conf <<'EOF'
[Definition]
failregex = huli-cloud: login failed from <HOST>$
            huli-cloud: signup failed from <HOST>$
journalmatch = _SYSTEMD_UNIT=huli-cloud.service
EOF
cat >/etc/fail2ban/jail.d/huli-cloud.conf <<'EOF'
[huli-cloud]
enabled = true
backend = systemd
port = http,https
filter = huli-cloud
maxretry = 10
findtime = 15m
bantime = 1h
EOF
fail2ban-client reload >/dev/null
fail2ban-client status huli-cloud | head -3

curl -fsS "https://$DOMAIN/healthz" && echo " <- https://$DOMAIN"
curl -fsS "https://$DOMAIN/v1" && echo " <- https://$DOMAIN/v1"
curl -fsS -o /dev/null -w '%{http_code}' "https://$DOMAIN/v1/regions" && echo " <- /v1/regions"
if [ -n "$app_site" ]; then
  curl -fsS -o /dev/null -w '%{http_code}' "https://$APP_DOMAIN/" && echo " <- https://$APP_DOMAIN"
fi
