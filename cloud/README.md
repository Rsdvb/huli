# Huli Cloud

Huli 的单用户账号服务、推送网关、中转站（relay）和网页版的后端，按 Kettu 开源客户端的协议实现。设计文档见 Kettu 里的 artifact「Huli Cloud 设计」。

## 开发

```powershell
npx tsc -p cloud/tsconfig.json                    # 类型检查
npx vitest run cloud/test                         # 测试（用 Kettu 自己的客户端代码驱动）
npx vite build -c vite.cloud.config.mts           # 打包成 cloud/dist/huli-cloud.mjs（单文件，只依赖 Node.js）
```

## 运行

```bash
HULI_ORIGIN=https://huli.132-145-200-0.sslip.io \
HULI_DATA_DIR=/var/lib/huli-cloud \
HULI_TRUST_PROXY=1 \
HULI_WEB_ORIGIN=https://app.huli.132-145-200-0.sslip.io \
HULI_REGIONS_FILE=/opt/huli-cloud/regions.signed.json \
node huli-cloud.mjs serve
```

| 变量                                                            | 说明                                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `HULI_ORIGIN`                                                   | 对外地址，主机签推送请求和中转登录时用它，必须和 Huli 桌面端里的 `PUSH_URL`、`RELAY_URL` 一致            |
| `HULI_DATA_DIR`                                                 | 数据目录：`state.json`（权限 600）、`relay-token.key`（中转令牌的签名密钥，首次启动生成，600）           |
| `HULI_HOST` / `HULI_PORT`                                       | 监听地址，默认 `127.0.0.1:3010`                                                                          |
| `HULI_TRUST_PROXY`                                              | `1` 时从 nginx 的 `X-Real-IP` 取客户端地址（只信任来自本机的连接）                                       |
| `HULI_WEB_ORIGIN`                                               | 网页版的地址：只有它能以 `kettu-web` 登录、跨域调用 API、从浏览器连中转；不设时网页版不能用              |
| `HULI_REGIONS_FILE`                                             | 签好名的中转区域列表（`cloud/deploy/regions.signed.json`），`GET /v1/regions` 原样返回；不设时不提供列表 |
| `APNS_KEY_FILE` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC` | 苹果推送密钥；不设时推送一律拒绝                                                                         |

## 账号管理（在服务器上运行，密码自己输入）

```bash
sudo -u huli env HULI_DATA_DIR=/var/lib/huli-cloud node /opt/huli-cloud/huli-cloud.mjs init
# passwd：改密码　totp：重新绑定两步验证并换恢复码　signout-all：所有设备退出登录
```

## 接口

| 路径                                               | 作用                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET/POST /signin/app/`                            | 浏览器登录（PKCE）：桌面端回本机、网页版回 `HULI_WEB_ORIGIN`、手机回 `huli://signin` |
| `POST /api/oauth/token`                            | 授权码、刷新（轮换，重放旧令牌整组作废）、设备码                                     |
| `POST /api/oauth/device`、`GET/POST /device`       | 设备码登录                                                                           |
| `POST /api/oauth/revoke`                           | 退出登录                                                                             |
| `GET /api/v1/me`                                   | 账号信息                                                                             |
| `POST /api/v1/relay/token`                         | 用访问令牌换中转令牌（只能用来连中转，1 小时过期）                                   |
| `GET /account/devices/`                            | 已登录设备，可踢出（踢出后它在中转上的主机一分钟内下线）                             |
| `POST /v1/push`                                    | 推送网关                                                                             |
| `GET /v1`、`/v1/regions`、`/v1/ping`、`/v1/hosts`  | 中转站信息、签名区域列表、测延迟、本账号的主机                                       |
| `WS /v1/hosts/<id>`、`/connect`、`/accept/<token>` | 中转的 WebSocket：主机控制连接、设备连接、主机接受连接                               |
| `GET /healthz`                                     | 健康检查                                                                             |

日志里 `huli-cloud: login failed from <IP>` 给 fail2ban 用。中转只记事件（主机 id 前 8 位上线/下线/被拒、关闭码），不记令牌和转发的内容。

## 中转站（relay）

协议就是 Kettu 客户端说的那套（`src/shared/remote/relay.ts`），和账号服务在同一个进程里（直接查同一份 `state.json` 校验令牌，不用再开一个服务和内部接口）：

- 主机（电脑）连 `/v1/hosts/<id>`，用 Ed25519 主机密钥签中转站给的随机数（签名内容含中转站地址和 id，不能挪到别处重放），再带上本账号的访问令牌或中转令牌；id 必须是这把公钥算出来的。
- 设备（手机、网页、别的电脑）连 `/v1/hosts/<id>/connect`，带同一账号的令牌；中转通知主机 `incoming`，主机开 `/accept/<一次性令牌>`，两个连接接在一起。
- 接上之后中转只原样转发二进制消息（Noise 加密过的通道消息，中转看不到明文）；文本消息只认 `ping`，其他一律断开。设备能不能连，主机还会在加密通道里自己判断（配对密钥）。
- 限制：单条消息 64 KiB（超了 1009 断开两边）、每台主机 16 个设备、登录/连接/接受各 10 秒、全局 512 个连接、单个 IP 64 个连接、每分钟 120 次新连接、同一主机每分钟 10 次登录、15 分钟内 20 次令牌被拒就暂时拒绝该 IP；主机控制连接 90 秒无消息、接通的一对 5 分钟无消息就断；每 30 秒 WebSocket ping，没回就断；转发积压 1 MiB 暂停读取。
- 浏览器的 `Origin` 只认 `HULI_ORIGIN` 和 `HULI_WEB_ORIGIN`。
- 主机的令牌每分钟复查一次：所属登录被踢出、或令牌过期超过 5 分钟没续，就以 4401 断开。

区域列表：只有一个区域 Ashburn（就是主站）。签名私钥只在机主电脑 `%USERPROFILE%\.huli-keys\region-list-{current,next}.pem`，公钥写在 `src/shared/remote/relay-regions.ts` 的 `REGION_KEYS`（r1 现用、r2 备用）。改列表：编辑 `cloud/deploy/regions.json`，运行 `node tools/huli/region-list.mjs sign`（序号自动加 1），提交 `regions.signed.json` 再部署。

## 部署（oracle-relay）

一步完成（在本机仓库根目录，已 `npx -y pnpm@10.11.1 install`，`ssh oracle-relay` 能连上）：

```powershell
powershell -ExecutionPolicy Bypass -File tools\huli\deploy-cloud.ps1            # 构建、上传、安装
powershell -ExecutionPolicy Bypass -File tools\huli\deploy-cloud.ps1 -BuildOnly # 只构建到 out\cloud-deploy
```

脚本从当前提交（HEAD）导出一份干净代码、跑 rebrand、构建 `huli-cloud.mjs` 和网页版 `huli-web.tar.gz`（附 SHA-256），连同 `regions.signed.json`、`install.sh` 传到服务器 `/tmp/huli-deploy-<提交>/`，执行 `sudo bash install.sh <那个目录>`，最后删掉临时目录。`install.sh` 可以重复运行，它会：

1. 把旧程序存成 `/opt/huli-cloud/huli-cloud.mjs.prev`，装新程序和 `/opt/huli-cloud/regions.signed.json`；
2. 在 `/etc/huli-cloud.env` 里**只补缺的行**：`HULI_WEB_ORIGIN=https://app.huli.132-145-200-0.sslip.io`、`HULI_REGIONS_FILE=/opt/huli-cloud/regions.signed.json`（其余配置、APNs 密钥不动）；
3. 校验并解开网页版到 `/var/www/huli-app`（旧的存成 `/var/www/huli-app.prev`）；
4. 重写 systemd 单元（加了 `LimitNOFILE=4096`）并重启 `huli-cloud`，检查 `/healthz` 和 `/v1`；
5. 用现有的 ACME webroot 申请 `app.huli.132-145-200-0.sslip.io` 的证书（80 端口的 default_server 已经提供 `/.well-known/acme-challenge/`）；
6. nginx：huli 站点加 `location /v1/hosts/`（WebSocket 升级头、读写超时 120 秒、不缓冲）；新站点 `huli-app`（静态文件、CSP 等安全头见 `snippets/huli-app-headers.conf`）；`nginx -t` 后 reload；
7. 隐私政策页加上中转的说明；最后从服务器上自测 `https://…/healthz`、`/v1`、`/v1/regions` 和网页版首页。

防火墙 / OCI：**不用改**，只用已经放行的 TCP 443（新证书走已放行的 80）。数据、账号、证书、APNs 都保留。

部署后：电脑端 Huli 打开 Huli Cloud 服务（设置里的云服务开关）并登录账号、设置 › 远程访问 打开「使用 Huli 中转」（新装默认开）；状态里出现 Ashburn「已连接」即可。之后「添加设备」的配对码会带上中转，浏览器链接是 `https://app.huli.132-145-200-0.sslip.io/pair#…`。

### 回滚

```bash
sudo install -m 644 /opt/huli-cloud/huli-cloud.mjs.prev /opt/huli-cloud/huli-cloud.mjs && sudo systemctl restart huli-cloud
sudo rm -rf /var/www/huli-app && sudo mv /var/www/huli-app.prev /var/www/huli-app      # 网页版回上一版
# 完全撤掉中转和网页版：
sudo rm /etc/nginx/sites-enabled/huli-app && sudo nginx -t && sudo systemctl reload nginx
sudo sed -i '/^HULI_WEB_ORIGIN=/d;/^HULI_REGIONS_FILE=/d' /etc/huli-cloud.env && sudo systemctl restart huli-cloud
```

旧程序不认识 `/v1/hosts/` 的 WebSocket，回滚后电脑端会显示中转连不上，直连和 Tailscale 照常。`location /v1/hosts/` 留着无害。

### 运维记录里要写的

- 服务器 oracle-relay；`huli-cloud` 现在也是中转站，仍是 127.0.0.1:3010（无新端口），对外 443：`https://huli.132-145-200-0.sslip.io/v1/…`（WebSocket `/v1/hosts/`）。
- 新增：证书 `app.huli.132-145-200-0.sslip.io`；nginx 站点 `huli-app` 和 `snippets/huli-app-headers.conf`；huli 站点的 `location /v1/hosts/`；目录 `/var/www/huli-app`（及 `.prev`）；文件 `/opt/huli-cloud/regions.signed.json`、`/opt/huli-cloud/huli-cloud.mjs.prev`、`/var/lib/huli-cloud/relay-token.key`（中转令牌签名密钥，丢了只会让已发的中转令牌失效，自动重建）；`/etc/huli-cloud.env` 新增两行 `HULI_WEB_ORIGIN`、`HULI_REGIONS_FILE`；单元加 `LimitNOFILE=4096`。
- 部署的提交号和 `huli-cloud.mjs` 的 sha256 前缀（脚本会打印）；撤销方法见上面「回滚」。
- 更新运维记录里「甲骨文 oracle-relay 现状」表格的 nginx 和 Huli Cloud 两行。
