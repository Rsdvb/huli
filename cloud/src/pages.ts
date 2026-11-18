// The web pages: sign-in, consent, device codes and the device list. Plain HTML forms, no script.

import type { HuliClientInfo } from '@shared/huli-cloud'
import type { Computer, Family } from './store'

export const STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--bg:#f5f5f7;--card:#fff;--line:#d2d2d7;--accent:#e2611f;--danger:#c0392b}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--bg:#1c1c1e;--card:#2c2c2e;--line:#3a3a3c}}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:420px;margin:8vh auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:17px;margin:20px 0 4px}
.gap{margin-top:20px}
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
.dot{width:28px;height:28px;border-radius:7px}
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

/** The service's name on its pages, after the app it serves. */
export const SERVICE_NAME = 'Kite Cloud'

// Kite's icon, drawn small (tools/huli/brand/kite-light.svg with a thicker string): the pages'
// favicon and the mark beside their title, inline as the pages' CSP allows images from data URLs.
const ICON = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'><defs><linearGradient id='g' x2='1' y2='1'><stop stop-color='#FF9A5A'/><stop offset='1' stop-color='#E2541F'/></linearGradient></defs><rect width='1024' height='1024' rx='230' fill='url(#g)'/><path d='M513 630C507 680 457 731 407 745S307 810 301 860' fill='none' stroke='#fff' stroke-width='44' stroke-linecap='round'/><circle cx='301' cy='860' r='54' fill='#fff'/><path transform='translate(575 340) rotate(12)' d='M0-153L151 0 0 297-151 0Z' fill='#fff' stroke='#fff' stroke-width='24' stroke-linejoin='round'/></svg>",
)}`

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · ${SERVICE_NAME}</title><link rel="icon" type="image/svg+xml" href="${ICON}"><link rel="stylesheet" href="/static/style.css"></head><body><main><div class="brand"><img class="dot" src="${ICON}" alt="">${SERVICE_NAME}</div><div class="card">${body}</div></main></body></html>`
}

export function describeClient(info: HuliClientInfo | null): string {
  if (!info) return '未知设备'
  const kind =
    { desktop: '纸鸢桌面端', daemon: '纸鸢命令行', web: '网页版', mobile: '纸鸢手机端' }[
      info.kind
    ] ?? info.kind
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

/**
 * Where the owner types the code their own computer shows. It is never filled in from the link, so
 * a link someone else sent cannot carry a code of theirs to approve.
 */
export function devicePage(input: { csrf: string; error?: string }): string {
  return page(
    '设备登录',
    `<h1>设备登录</h1><p class="muted">输入你自己电脑的命令行里显示的验证码。</p>
<form method="post" action="/device">${hidden('csrf', input.csrf)}
<label for="user_code">验证码</label><input id="user_code" name="user_code" autocomplete="off" required autofocus>
${input.error ? `<p class="error">${escape(input.error)}</p>` : ''}
<div class="row"><button class="primary" name="action" value="continue">继续</button></div></form>`,
  )
}

/** How long ago `ms` milliseconds were, in words. */
function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`
}

/** The device sign-in a code names: who asked, from where and when, before it is allowed. */
export function deviceConfirmPage(input: {
  csrf: string
  code: string
  client: string
  address: string
  startedMsAgo: number
}): string {
  return page(
    '允许设备登录',
    `<h1>允许这台设备登录？</h1><p>${escape(input.client)}</p>
<p class="muted">验证码 ${escape(input.code)} · 来自 ${escape(input.address)} · ${ago(input.startedMsAgo)}开始</p>
<p class="error">只有当这个验证码是你刚刚在自己的电脑上开始登录时显示的，才点「允许」。如果验证码是别人发给你的，或者你不记得刚刚开始过登录，请点「拒绝」：允许之后，对方就能用你的账号。</p>
<form method="post" action="/device">${hidden('csrf', input.csrf)}${hidden('user_code', input.code)}
<div class="row"><button class="primary" name="action" value="allow">允许</button><button name="action" value="deny">拒绝</button></div></form>`,
  )
}

export function messagePage(title: string, text: string): string {
  return page(title, `<h1>${escape(title)}</h1><p>${escape(text)}</p>`)
}

export function devicesPage(input: {
  csrf: string
  families: Family[]
  computers: (Computer & { online: boolean })[]
  email: string
}): string {
  const time = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
  const rows = input.families
    .map(
      (f) =>
        `<tr><td>${escape(describeClient(f.info))}<br><span class="muted">登录于 ${time(f.createdAt)} · 最近使用 ${time(f.lastUsedAt)}</span></td><td><form method="post" action="/account/devices/revoke">${hidden('csrf', input.csrf)}${hidden('family', f.id)}<button class="danger">退出</button></form></td></tr>`,
    )
    .join('')
  const computers = input.computers
    .map(
      (c) =>
        `<tr><td>${escape(c.name ?? '未命名的电脑')}<br><span class="muted">${c.online ? '在线' : `最近在线 ${time(c.lastSeen)}`} · 中转 id ${escape(c.id.slice(0, 8))}</span></td></tr>`,
    )
    .join('')
  return page(
    '已登录的设备',
    `<h1>已登录的设备</h1><p class="muted">${escape(input.email)}</p>
${rows ? `<table>${rows}</table>` : '<p class="muted">没有已登录的设备。</p>'}
<h2>电脑</h2><p class="muted">登录了这个账号、开着远程访问和中转的电脑。让一台退出，在上面退出它的登录。</p>
${computers ? `<table>${computers}</table>` : '<p class="muted">还没有电脑。</p>'}
<p class="muted gap">改密码和两步验证：在服务器上运行 <b>huli-cloud passwd</b> 或 <b>huli-cloud totp</b>（见服务端的说明）。</p>
<form method="post" action="/account/signout">${hidden('csrf', input.csrf)}<div class="row"><button>退出网页登录</button></div></form>`,
  )
}
