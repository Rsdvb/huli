// The web pages: sign-in, consent, device codes and the device list. Plain HTML forms, no script.

import type { ClientInfo } from '@shared/account-api'
import type { Family } from './store'

export const STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--bg:#f5f5f7;--card:#fff;--line:#d2d2d7;--accent:#e2611f;--danger:#c0392b}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--bg:#1c1c1e;--card:#2c2c2e;--line:#3a3a3c}}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:420px;margin:8vh auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:20px;margin:0 0 4px}
p{margin:8px 0}
.muted{color:var(--muted);font-size:13px}
label{display:block;margin:14px 0 4px;font-size:13px;color:var(--muted)}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font-size:15px}
.row{display:flex;gap:8px;margin-top:18px}
button{flex:1;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);font-size:15px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--danger)}
.error{color:var(--danger);margin-top:12px}
.brand{display:flex;align-items:center;gap:8px;margin-bottom:16px;font-weight:600}
.dot{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,#ff9933,#d6481c);color:#fff;display:grid;place-items:center;font-size:16px}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
td{padding:8px 4px;border-top:1px solid var(--line);vertical-align:middle}
td form{margin:0}
td button{padding:4px 10px;font-size:13px}
code{font-size:18px;letter-spacing:2px}
`

export function escape(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · Huli Cloud</title><link rel="stylesheet" href="/static/style.css"></head><body><main><div class="brand"><span class="dot">狐</span>Huli Cloud</div><div class="card">${body}</div></main></body></html>`
}

export function describeClient(info: ClientInfo | null): string {
  if (!info) return '未知设备'
  const kind = { desktop: 'Huli 桌面端', daemon: 'Huli 命令行', web: '网页版' }[info.kind] ?? info.kind
  return `${kind} · ${info.name}（${info.os} ${info.arch}${info.version ? ` · ${info.version}` : ''}）`
}

const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escape(value)}">`

/** The password and one-time code form, posting to `action` with its hidden fields. */
export function loginPage(input: {
  action: string
  fields: Record<string, string>
  purpose: string
  error?: string
}): string {
  const fields = Object.entries(input.fields)
    .map(([k, v]) => hidden(k, v))
    .join('')
  return page(
    '登录',
    `<h1>登录</h1><p class="muted">${escape(input.purpose)}</p>
<form method="post" action="${escape(input.action)}">${fields}
<label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<label for="code">两步验证码（或恢复码）</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
${input.error ? `<p class="error">${escape(input.error)}</p>` : ''}
<div class="row"><button class="primary" name="action" value="allow">登录</button>${input.fields.ticket ? '<button name="action" value="deny" formnovalidate>取消</button>' : ''}</div></form>`,
  )
}

export function consentPage(input: {
  action: string
  fields: Record<string, string>
  client: string
}): string {
  const fields = Object.entries(input.fields)
    .map(([k, v]) => hidden(k, v))
    .join('')
  return page(
    '允许登录',
    `<h1>允许这台设备登录？</h1><p>${escape(input.client)}</p><p class="muted">允许后它能用你的账号收发推送。不认识的话请点「拒绝」。</p>
<form method="post" action="${escape(input.action)}">${fields}<div class="row"><button class="primary" name="action" value="allow">允许</button><button name="action" value="deny">拒绝</button></div></form>`,
  )
}

export function devicePage(input: {
  csrf: string
  code: string
  client?: string
  error?: string
}): string {
  return page(
    '设备登录',
    `<h1>设备登录</h1><p class="muted">输入命令行里显示的验证码。</p>
<form method="post" action="/device">${hidden('csrf', input.csrf)}
<label for="user_code">验证码</label><input id="user_code" name="user_code" value="${escape(input.code)}" autocomplete="off" required autofocus>
${input.client ? `<p>${escape(input.client)}</p>` : ''}
${input.error ? `<p class="error">${escape(input.error)}</p>` : ''}
<div class="row"><button class="primary" name="action" value="allow">允许</button><button name="action" value="deny">拒绝</button></div></form>`,
  )
}

export function messagePage(title: string, text: string): string {
  return page(title, `<h1>${escape(title)}</h1><p>${escape(text)}</p>`)
}

export function devicesPage(input: { csrf: string; families: Family[]; email: string }): string {
  const time = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
  const rows = input.families
    .map(
      (f) =>
        `<tr><td>${escape(describeClient(f.info))}<br><span class="muted">登录于 ${time(f.createdAt)} · 最近使用 ${time(f.lastUsedAt)}</span></td><td><form method="post" action="/account/devices/revoke">${hidden('csrf', input.csrf)}${hidden('family', f.id)}<button class="danger">退出</button></form></td></tr>`,
    )
    .join('')
  return page(
    '已登录的设备',
    `<h1>已登录的设备</h1><p class="muted">${escape(input.email)}</p>
${rows ? `<table>${rows}</table>` : '<p class="muted">没有已登录的设备。</p>'}
<form method="post" action="/account/signout">${hidden('csrf', input.csrf)}<div class="row"><button>退出网页登录</button></div></form>`,
  )
}
