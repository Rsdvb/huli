# Huli Cloud

Huli 的账号服务（机主管理的几个账号，不开放注册）、推送网关、中转站（relay）和网页版的后端，按 Kettu 开源客户端的协议实现。设计文档见 Kettu 里的 artifact「Huli Cloud 设计」。

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

| 变量                                                            | 说明                                                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `HULI_ORIGIN`                                                   | 对外地址，主机签推送请求和中转登录时用它，必须和 Huli 桌面端里的 `PUSH_URL`、`RELAY_URL` 一致                        |
| `HULI_DATA_DIR`                                                 | 数据目录：`state.json`（600）、`relay-token.key`（中转令牌签名密钥，首次启动生成，600）、`admin.sock`（命令用，600） |
| `HULI_HOST` / `HULI_PORT`                                       | 监听地址，默认 `127.0.0.1:3010`                                                                                      |
| `HULI_TRUST_PROXY`                                              | `1` 时从 nginx 的 `X-Real-IP` 取客户端地址（只信任来自本机的连接）                                                   |
| `HULI_WEB_ORIGIN`                                               | 网页版的地址：只有它能以 `kettu-web` 登录、跨域调用 API、从浏览器连中转；不设时网页版不能用                          |
| `HULI_REGIONS_FILE`                                             | 签好名的中转区域列表（`cloud/deploy/regions.signed.json`），`GET /v1/regions` 原样返回；不设时不提供列表             |
| `APNS_KEY_FILE` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC` | 苹果推送密钥；不设时推送一律拒绝                                                                                     |

## 账号

**模型**：`state.json` 里有几个账号，每个有固定的 id、用户名（2–32 位小写字母、数字或 `. _ -`）、密码哈希（scrypt）、TOTP 密钥、恢复码哈希、创建时间、停用时间。最早的那个是**机主**（`owner`）：只有它能管理别的账号，它不能被停用或删除。每次登录（family）、访问令牌、中转令牌、设备码、网页登录、电脑登记表里的每台电脑、每个推送目标都绑在一个账号上；一个账号的令牌看不到、连不上、登记不了、推送不到别的账号的任何东西。账号停用、删除或等待重设时，它的登录、令牌、网页会话一律拒绝，中转上的连接立刻断开。最多 32 个账号。

**不开放注册**：只有拿到机主给的**邀请码**才能注册。邀请码 16 位（约 79 位随机性），只存哈希，只能用一次，默认 7 天过期（1–30 天），机主随时可以撤销；同时最多 20 个没用的。

**朋友怎么注册**：手机上纸鸢「设置 › 账号」或配对页点「用邀请码注册」，电脑上「设置 › 账号」点「注册账号」，网页版登录页点「没有账号？用邀请码注册」。打开的是同一个登录页（`/signin/app/?mode=register`）：填邀请码、自己定用户名和密码（至少 12 位）→ 用验证器 App 扫二维码（在同一台手机上就点「在这台设备上添加验证码」或手动输入密钥）并输入 6 位验证码 → 页面显示 10 个恢复码（只显示这一次）→ 点「继续」，App 就登录好了。以后登录填用户名、密码、验证码。

**机主登录**：和以前一样，用户名可以不填（不填就是机主），也可以填 `owner` 或机主的邮箱。

**管理（在服务器上运行，以 huli 用户）**：

```bash
H="sudo -u huli env HULI_DATA_DIR=/var/lib/huli-cloud /opt/huli-cloud/node/bin/node /opt/huli-cloud/huli-cloud.mjs"
$H user invite               # 新建邀请码（--days N，默认 7），只显示这一次
$H user list                 # 账号（状态、设备数、电脑数、推送目标数）和邀请码（编号、状态、谁用的）
$H user uninvite <编号>      # 撤销没用的邀请码
$H user disable <用户名>     # 停用：不能登录，令牌一律拒绝，中转连接立刻断开；enable 恢复，原来的登录也恢复
$H user enable <用户名>
$H user reset <用户名>       # 忘了密码/换了手机：所有设备退出，清掉密码和两步验证，给一个重设用的邀请码（用户名要填原来的）
$H user remove <用户名>      # 删除账号和它的一切：登录、电脑、推送目标、邀请码；中转连接立刻断开（要再输一次用户名确认）
$H signout-all [用户名]      # 让一个账号（默认机主）的所有设备退出登录
$H init [--force]            # 建机主账号（--force 重建机主，机主的设备都会退出；别的账号不动）
$H passwd                    # 改机主密码
$H totp                      # 重新绑定机主的两步验证并换恢复码
```

- 密码、验证码只在运行后按提示输入，命令行参数里永远没有密码、验证码或密钥（多余的参数一律拒绝，不会被 shell 历史和进程列表记下）。邀请码由服务生成，只显示一次。
- 服务在跑时，命令经 `admin.sock`（数据目录里，600，只有 huli 能连）交给服务，马上生效（停用、删除会立刻断开中转连接），`state.json` 只由服务写；服务没在跑时，命令直接改 `state.json`。不能用 root 运行（`state.json` 会变成 root 的，服务读不了）。
- 机主网页 `/account/admin/`（「已登录的设备」页底下「账号和邀请码」）：看账号、停用/启用，新建（只显示这一次）和撤销邀请码。删除和重设只在服务器上做。

**给朋友的说明**：

- 纸鸢 iOS 是 Ad Hoc 分发：朋友的 iPhone 要先把 **UDID 加进开发者账号的设备列表**、重新构建安装包，才装得上（一年最多 100 台 iPhone）。
- 朋友的手机和电脑之间用他自己的 Tailscale 直连时，不经过这台服务器；账号主要给他**推送通知**（电脑登录 Kite Cloud 后才能给手机推送），中转只在直连不通时用。
- 中转转发的流量走这台服务器（甲骨文的出站流量每月 10 TB 免费）；朋友经中转用得多时会占带宽，必要时停用他的账号或让他关掉「使用 Huli 中转」。

## 接口

| 路径                                               | 作用                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /signin/app/`                            | 浏览器登录（PKCE）：桌面端回本机、网页版回 `HULI_WEB_ORIGIN`、手机回 `huli://signin`；`mode=register` 先用邀请码注册 |
| `POST /api/oauth/token`                            | 授权码、刷新（轮换，重放旧令牌整组作废）、设备码                                                                     |
| `POST /api/oauth/device`、`GET/POST /device`       | 设备码登录（验证码要手动输入，链接不预填；确认页显示发起的 IP 和时间）                                               |
| `POST /api/oauth/revoke`                           | 退出登录                                                                                                             |
| `GET /api/v1/me`                                   | 账号信息                                                                                                             |
| `POST /api/v1/relay/token`                         | 用访问令牌换中转令牌（只能用来连中转，1 小时过期）                                                                   |
| `GET /api/v1/account/devices`                      | 账号的已登录设备和电脑（登记表），只认访问令牌（不认中转令牌）                                                       |
| `POST /api/v1/account/devices/revoke`              | `device=<id>` 让一台设备退出，`others=1` 让除自己外的都退出；它在中转上的连接立刻断开                                |
| `GET /account/devices/`                            | 本账号已登录的设备和电脑，可踢出（踢出后它在中转上的主机和设备连接立刻断开）                                         |
| `GET/POST /account/admin/`                         | 机主：账号（停用/启用）和邀请码（新建/撤销）                                                                         |
| `POST /v1/push`                                    | 推送网关（只认电脑的登录，签名的钥匙要和电脑登记表一致，推送目标按账号分开）                                         |
| `GET /v1`、`/v1/regions`、`/v1/ping`、`/v1/hosts`  | 中转站信息、签名区域列表、测延迟、本账号的主机                                                                       |
| `WS /v1/hosts/<id>`、`/connect`、`/accept/<token>` | 中转的 WebSocket：主机控制连接、设备连接、主机接受连接                                                               |
| `GET /healthz`                                     | 健康检查                                                                                                             |

日志里 `huli-cloud: login failed from <IP>` 和 `huli-cloud: signup failed from <IP>`（邀请码不对）给 fail2ban 用（15 分钟 10 次封 1 小时）。客户端发来的设备名、系统等先去掉控制字符和换行再存、再记日志，伪造不出这一行。出错只记错误类型和调用栈，不记错误消息（可能带令牌）。中转只记事件（主机 id 前 8 位上线/下线/被拒、关闭码），不记令牌和转发的内容。

## 登录的限制

- 按账号和 IP 分开数：同一个 IP 对同一个账号 15 分钟内 5 次没成功就暂时拒绝这个 IP 登这个账号；同一个 IP 不管登哪个账号（包括不存在的用户名）一共 10 次就整个 IP 暂时拒绝。尝试在验证密码之前就记下，成功了再撤回，同时发出的请求绕不过去。一个账号输错不会锁住另一个账号（同一个 IP 也不会，除非这个 IP 一共错了 10 次）；没有全局上限，别人换几个 IP 也锁不住任何账号。
- 不存在的用户名也照样算一次 scrypt（对着一个谁也不知道的密码的哈希），回答一样，看不出用户名存不存在。停用的账号只有密码和验证码都对时才说「已停用」。
- 每个账号同时最多验证 2 个密码（scrypt 每次 32 MiB），不存在的用户名和注册合用另外 2 个，总共最多 8 个；其余的回 429，过几秒再试。攻击一个账号占不满别的账号的名额。
- 登录、注册、确认设备、管理页的表单只收本站页面提交的：浏览器说是从别的网站提交的（`Sec-Fetch-Site` 不是 `same-origin`）一律 403，免得别人把你的浏览器登进他选的账号。
- 邀请码：每个 IP 15 分钟内 5 次不对就暂时拒绝，全部 IP 加起来 1 小时 30 次不对就暂时停止注册（只停注册，不影响登录）。邀请码约 79 位随机性，猜不中。注册时绑定两步验证的验证码最多错 5 次，之后要重新开始。
- 浏览器登录页每打开一次存一张 10 分钟的票：每个 IP 最多 20 张、总共最多 1000 张，满了挤掉最旧的；等待中的设备码登录总共最多 1000 个。过期的每分钟清一次。
- 设备码登录：服务不给 `verification_uri_complete`，`/device` 也不从链接里读验证码，要机主自己输入自己电脑上显示的验证码；下一页显示是哪个客户端、从哪个 IP、多久前发起的，并提醒只允许自己刚刚发起的登录。
- 推送：只认电脑（`kettu-desktop`、`kettu-daemon`）的登录；电脑在登记表里时，签名的 Ed25519 钥匙和登录都要和登记的一致，一次登录登记过电脑后就只能以它的身份推送。没开中转（没登记）的电脑仍只验签名。
- 推送按账号分开：手机的推送令牌（APNs 设备令牌、实时活动令牌）第一次由哪个账号的电脑推送成功，就记成那个账号的（只存哈希）；别的账号的电脑再往这个令牌推一律拒绝（401，不发给 Apple），所以知道了别人手机的令牌也推不过去。Apple 说令牌失效（410）就忘掉它；90 天没推过也忘掉；每个账号最多记 512 个。限流按电脑（每分钟 60）、按账号（每分钟 300）、按 IP（每分钟 300）分开。
- 已知限制：一台手机同时配对了两个账号的电脑时，只有先推送成功的那个账号能推给它。

## 中转站（relay）

协议就是 Kettu 客户端说的那套（`src/shared/remote/relay.ts`），和账号服务在同一个进程里（直接查同一份 `state.json` 校验令牌，不用再开一个服务和内部接口）：

- 主机（电脑）连 `/v1/hosts/<id>`，用 Ed25519 主机密钥签中转站给的随机数（签名内容含中转站地址和 id，不能挪到别处重放），再带上本账号的访问令牌或中转令牌；id 必须是这把公钥算出来的。**只有电脑的登录（`kettu-desktop`、`kettu-daemon`）能当主机**：手机（`huli-mobile`）和网页版（`kettu-web`）的令牌只能当设备，拿来登录主机一律 4401，续令牌时换成它们的也一样。
- 主机一登录就记进账号的**电脑登记表**（`state.json` 的 `computers`）：中转 id、签名证明过的 Ed25519 公钥、登记它的那次登录、首次/最近在线时间；它发来的 profile（名字、平台、通道的 X25519 公钥、是否接受配对请求）也记下。登记跟着登录走：那次登录被踢出或过期，电脑就从表里消失；同一个 id 换了公钥（重装）就从头登记。每个账号最多 64 台，满了挤掉最久没在线的。
- 设备（手机、网页、别的电脑）连 `/v1/hosts/<id>/connect`，带同一账号的令牌；中转确认这台主机**在登记表里、属于同一账号、登记它的登录还有效**，才通知主机 `incoming`，主机开 `/accept/<一次性令牌>`，两个连接接在一起。
- `GET /v1/hosts`（Kettu 客户端的列表）只列在线、接受配对请求的主机；完整的电脑列表（含离线的、最近在线时间）在 `GET /api/v1/account/devices`。
- 接上之后中转只原样转发二进制消息（Noise 加密过的通道消息，中转看不到明文）；文本消息只认 `ping`，其他一律断开。设备能不能连，主机还会在加密通道里自己判断（配对密钥）。
- 每个账号有自己的名额：最多 64 台主机同时在线、160 个已登录的连接（主机控制连接、设备连接和接上的接受连接），一个账号占满了也不影响别的账号；全局最多 256 台主机。
- 限制：单条消息 64 KiB（超了 1009 断开两边）、每台主机 16 个设备、登录/连接/接受各 10 秒、全局 512 个连接、单个 IP 64 个连接、还没登录的连接（主机签名前、设备交令牌前、未配上的接受连接）另有上限：总共 128 个、单个 IP 16 个、每分钟 120 次新连接、同一主机每分钟 10 次登录、15 分钟内 20 次令牌被拒就暂时拒绝该 IP；主机控制连接 90 秒无消息、接通的一对 5 分钟无消息就断；每 30 秒 WebSocket ping，没回就断；转发积压 1 MiB 暂停读取。
- 浏览器的 `Origin` 只认 `HULI_ORIGIN` 和 `HULI_WEB_ORIGIN`。
- 主机和设备的令牌每分钟复查一次，踢出设备、停用/删除/重设账号时立刻复查：主机所属登录被踢出、或令牌过期超过 5 分钟没续，就以 4401 断开；设备（手机、网页、别的电脑）所属登录被踢出，它的连接也以 4401 断开（接通的那一头一起断）。设备只查登录还在不在，不查令牌过期，因为接通后它没法续令牌。

区域列表：只有一个区域 Ashburn（就是主站）。签名私钥只在机主电脑 `%USERPROFILE%\.huli-keys\region-list-{current,next}.pem`，公钥写在 `src/shared/remote/relay-regions.ts` 的 `REGION_KEYS`（r1 现用、r2 备用）。改列表：编辑 `cloud/deploy/regions.json`，运行 `node tools/huli/region-list.mjs sign`（序号自动加 1），提交 `regions.signed.json` 再部署。

客户端（桌面端、手机、网页版）只把账号令牌和中转令牌发给主中转本身（`RELAY_URL`）和签名区域列表里的区域；配对码、welcome 或保存的主机里写的其他地址，哪怕在同一个域名下也不认：sslip.io 的任何 `a-b-c-d.132-145-200-0.sslip.io` 都解析到 a.b.c.d，谁都能起一个指向自己服务器的名字。要加区域，就加进签名列表。

## 账号、电脑登记表和免扫码配对

**登录**：手机在「设置 › 账号」或配对页「用 Huli Cloud 账号登录」，经系统的 ASWebAuthenticationSession（每次独立会话，不留 Safari cookie）打开 `/signin/app/`，客户端 `huli-mobile`、PKCE S256、回调只认 `huli://signin` 且核对 state。刷新令牌存手机钥匙串（`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`，不进备份、不同步到别的设备），访问令牌和中转令牌只在内存；刷新一次一个、先存新令牌再用（旧令牌重放会让整组作废）；退出登录先在本机忘掉、再去云端吊销。每次登录（family）都记着它属于哪个账号：别的账号的令牌、电脑一概不认；`init --force` 重建机主后，旧机主账号的令牌、电脑也一概不认。

**免扫码配对**：手机/网页版/桌面端列出账号里的电脑，点一台「未配对」的：

1. 从登记表拿到它的中转 id 和通道 X25519 公钥（只当作“把握手加密给谁”的提示）；
2. 经中转对这把公钥做 Noise IK（discovery 前缀，和配对码、已配对设备的握手都区分开）——**只有握着对应私钥的电脑才能完成握手**，登记表给的钥匙不对就握不上；
3. 先承诺后揭示交换随机数，两边算出同一个 6 位数字，各自显示；
4. 电脑上弹出「要添加这台设备吗？」（设备名、型号、数字），**电脑主人同意**，并且**手机上的人确认数字一致**，电脑才把它加进已配对设备并发 welcome；之后它和扫码配对的一样保存、直连/中转都能连。

威胁模型（假设云端/中转被完全控制）：

| 云端能做的                                       | 结果                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 看/改中转的流量                                  | 只有 Noise 加密后的字节，看不到内容；改了就解密失败断开                                                                                                                                                                                                |
| 在登记表里给某台电脑填自己的 X25519 钥（中间人） | 手机连到的其实是云端；云端再以「设备」身份向真电脑发请求。两段握手不同，手机上和电脑弹窗里的数字不一样（只有百万分之一碰巧相同；电脑连续 3 次被拒/作废就冷却 10 分钟）。电脑弹窗写着要核对数字，手机上也要按「数字一致」：只要有一边认真核对，就配不上 |
| 冒充电脑直接发 welcome                           | 手机在用户确认数字之前收到 welcome 一律拒绝（真电脑只会在两边都同意后才发）                                                                                                                                                                            |
| 不经同意把自己加到电脑上                         | 做不到：电脑只在**电脑主人点同意**且设备确认数字后才添加；云端没有任何能让电脑添加设备的接口                                                                                                                                                           |
| 用账号令牌登录成主机/冒充别的主机                | 主机必须用中转 id 对应的 Ed25519 私钥签名；而且只有电脑的登录能当主机                                                                                                                                                                                  |
| 踢人、拒绝服务、谎报在线状态                     | 能（它本来就控制服务）。影响的是可用性，不是已配对连接的机密性和完整性                                                                                                                                                                                 |

不在防护范围：电脑主人不核对数字就点「添加」（那样加进来的可能是云端冒充的「手机」，它就成了这台电脑的已配对设备。所以弹窗出现时先看数字；不是自己正在配对时冒出来的请求一律点「不添加」）；电脑本机或手机本机已经被攻破。

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
6. nginx：huli 站点加 `location /v1/hosts`（不带结尾斜杠，否则 nginx 把列表请求 301 掉）（WebSocket 升级头、读写超时 120 秒、不缓冲）；新站点 `huli-app`（静态文件、CSP 等安全头见 `snippets/huli-app-headers.conf`）；`nginx -t` 后 reload；
7. 隐私政策页加上中转的说明；最后从服务器上自测 `https://…/healthz`、`/v1`、`/v1/regions` 和网页版首页。

另外：`nginx -t` 不通过时，先把这次改之前的站点文件和 snippet 放回去再退出，nginx 不 reload；每晚 3:41 备份 `state.json` 到 `/var/backups/huli-cloud/`（保留两周），里面有 TOTP 密钥和密码哈希，所以只有 root 能读（文件 600、目录 700），要拷下来用 sudo，以前留下的组可读的备份也在这次改成 600；更新文件上传用户 `huli-upload` 的公钥只从部署目录里的 `huli_upload.pub` 读（目录和文件属于 root 或执行 sudo 的用户、别人不能写，内容只有一行 SSH 公钥），不再读 `/tmp/huli_upload.pub`，写入时仍带 `restrict` 和只能 rrsync 到更新目录的限制。

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

### 账号登记表这一版（feat/account）

- 不用改环境变量、nginx、端口、防火墙：新接口都在已有的 `location /`（`/api/…`）下，网页版的 CSP `connect-src` 已经包含 `https://huli.…`；手机回调 `huli://signin` 早在登录页的 `form-action` 里。
- `state.json` 第一次写入时：每个登录记上 `account`（旧记录归当前账号），新增 `computers` 登记表。回滚到上一版没问题（旧程序原样保留不认识的字段）。
- 部署后电脑端需要更新到这一版才会一直上报 profile（否则只有开了「让账号下的设备找到这台电脑」的电脑才有名字和通道钥匙）；手机 App 需要重新构建（新增原生模块 `expo-web-browser`）。

### 多账号这一版（feat/cloud-multi-account）

- 不用改环境变量、nginx、端口、防火墙。`install.sh` 把 fail2ban 改成 15 分钟 10 次（以前 5 次），并把 `signup failed from` 也算进去。
- **第一次启动时自动迁移** `state.json`（v1 → v2）：原来的账号变成机主 `owner`（id、密码、两步验证、恢复码都不变），所有已登录的设备、电脑登记表、令牌照常可用，不用重新登录。迁移前的原文件存成 `/var/lib/huli-cloud/state.v1.json`（600，只做一次；已有同名文件就另存 `state.v1-<时间>.json`）。
- 部署后检查：`sudo journalctl -u huli-cloud -n 20` 没有报错；`$H user list` 能列出 `owner`；手机、电脑照常连得上；`ls -l /var/lib/huli-cloud/` 有 `state.v1.json` 和 `admin.sock`（都属于 huli、600）。
- 给朋友开账号：`$H user invite`，把打出来的邀请码发给他（另外按上面的说明把他的 iPhone UDID 加进设备列表、重新构建纸鸢）。
- 客户端：要更新到这一版才有「用邀请码注册」/「注册账号」按钮；旧客户端照样能登录，网页登录页上也有「没有账号？用邀请码注册」。
- **回滚**：旧程序不认识 v2 的 `state.json`，会启动失败。回滚时先停服务、把迁移前的文件放回去，再装回旧程序（这之后新建的账号没了；迁移后换过刷新令牌的设备要重新登录）：

  ```bash
  sudo systemctl stop huli-cloud
  sudo -u huli cp /var/lib/huli-cloud/state.json /var/lib/huli-cloud/state.v2-backup.json
  sudo -u huli cp /var/lib/huli-cloud/state.v1.json /var/lib/huli-cloud/state.json
  sudo install -m 644 /opt/huli-cloud/huli-cloud.mjs.prev /opt/huli-cloud/huli-cloud.mjs && sudo systemctl start huli-cloud
  ```

### 运维记录里要写的

- 服务器 oracle-relay；`huli-cloud` 现在也是中转站，仍是 127.0.0.1:3010（无新端口），对外 443：`https://huli.132-145-200-0.sslip.io/v1/…`（WebSocket `/v1/hosts/`）。
- 新增：证书 `app.huli.132-145-200-0.sslip.io`；nginx 站点 `huli-app` 和 `snippets/huli-app-headers.conf`；huli 站点的 `location /v1/hosts/`；目录 `/var/www/huli-app`（及 `.prev`）；文件 `/opt/huli-cloud/regions.signed.json`、`/opt/huli-cloud/huli-cloud.mjs.prev`、`/var/lib/huli-cloud/relay-token.key`（中转令牌签名密钥，丢了只会让已发的中转令牌失效，自动重建）；`/etc/huli-cloud.env` 新增两行 `HULI_WEB_ORIGIN`、`HULI_REGIONS_FILE`；单元加 `LimitNOFILE=4096`。
- 部署的提交号和 `huli-cloud.mjs` 的 sha256 前缀（脚本会打印）；撤销方法见上面「回滚」。
- 多账号这一版：`state.json` 迁到 v2，迁移前的副本 `/var/lib/huli-cloud/state.v1.json`；新文件 `/var/lib/huli-cloud/admin.sock`（服务运行时才有）；fail2ban `huli-cloud` 改成 maxretry 10、加了 `signup failed from`；账号管理命令见「账号」；给谁开了账号、哪天开的（不写邀请码）。
- 更新运维记录里「甲骨文 oracle-relay 现状」表格的 nginx 和 Huli Cloud 两行。
