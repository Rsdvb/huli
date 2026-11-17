# Huli Cloud

Huli 的单用户账号服务和推送网关，按 Kettu 开源客户端的协议实现。设计文档见 Kettu 里的 artifact「Huli Cloud 设计」。

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
node huli-cloud.mjs serve
```

| 变量                                                            | 说明                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `HULI_ORIGIN`                                                   | 对外地址，主机签推送请求时用它，必须和 Huli 桌面端里的 `PUSH_URL` 一致 |
| `HULI_DATA_DIR`                                                 | 数据目录，`state.json` 权限 600                                        |
| `HULI_HOST` / `HULI_PORT`                                       | 监听地址，默认 `127.0.0.1:3010`                                        |
| `HULI_TRUST_PROXY`                                              | `1` 时从 nginx 的 `X-Real-IP` 取客户端地址（只信任来自本机的连接）     |
| `APNS_KEY_FILE` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC` | 苹果推送密钥；不设时推送一律拒绝                                       |

## 账号管理（在服务器上运行，密码自己输入）

```bash
sudo -u huli env HULI_DATA_DIR=/var/lib/huli-cloud node /opt/huli-cloud/huli-cloud.mjs init
# passwd：改密码　totp：重新绑定两步验证并换恢复码　signout-all：所有设备退出登录
```

## 接口

| 路径                                         | 作用                                             |
| -------------------------------------------- | ------------------------------------------------ |
| `GET/POST /signin/app/`                      | 浏览器登录（PKCE + 本机回调）                    |
| `POST /api/oauth/token`                      | 授权码、刷新（轮换，重放旧令牌整组作废）、设备码 |
| `POST /api/oauth/device`、`GET/POST /device` | 设备码登录                                       |
| `POST /api/oauth/revoke`                     | 退出登录                                         |
| `GET /api/v1/me`                             | 账号信息                                         |
| `GET /account/devices/`                      | 已登录设备，可踢出                               |
| `POST /v1/push`                              | 推送网关                                         |
| `GET /healthz`                               | 健康检查                                         |

日志里 `huli-cloud: login failed from <IP>` 给 fail2ban 用。
