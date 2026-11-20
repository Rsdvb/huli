// The web pages: sign-in (the password, then the code for an account with two-step verification),
// sign-up with an invite code, consent, device codes, the device list and the owner's page of
// accounts and invites. Plain HTML forms, no script.

import type { HuliClientInfo } from '@shared/huli-cloud'
import type { AccountRow, InviteRow } from './admin'
import type { Account, Computer, Family, InviteStatus } from './store'

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
input,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font-size:15px}
a{color:var(--accent)}
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

// C0 and C1 control characters, DEL, and the Unicode line and paragraph separators.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/**
 * Text a client sent, without the characters that could break a log line: a name with a line
 * break in it could otherwise write a `login failed from` line of its own, which fail2ban acts on.
 */
export function printable(text: string): string {
  return text.replace(UNPRINTABLE, ' ')
}

export function describeClient(info: HuliClientInfo | null): string {
  if (!info) return '未知设备'
  const kind =
    { desktop: '纸鸢桌面端', daemon: '纸鸢命令行', web: '网页版', mobile: '纸鸢手机端' }[
      info.kind
    ] ?? info.kind
  return printable(
    `${kind} · ${info.name}（${info.os} ${info.arch}${info.version ? ` · ${info.version}` : ''}）`,
  )
}

const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escape(value)}">`

const hiddenFields = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => hidden(k, v))
    .join('')

const errorLine = (error: string | undefined) =>
  error ? `<p class="error">${escape(error)}</p>` : ''

/**
 * The username and password form, posting to `action` with its hidden fields. The owner may leave
 * the username empty. An account with two-step verification is asked its code on the next page,
 * once its password is right. In the browser sign-in (with a ticket) it also leads to signing up
 * with an invite code.
 */
export function loginPage(input: {
  action: string
  fields: Record<string, string>
  purpose: string
  username?: string
  error?: string
}): string {
  const ticket = Boolean(input.fields.ticket)
  return page(
    '登录',
    `<h1>登录</h1><p class="muted">${escape(input.purpose)}</p>
<form method="post" action="${escape(input.action)}">${hiddenFields(input.fields)}
<label for="username">用户名（机主可不填）</label><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="256" value="${escape(input.username ?? '')}" autofocus>
<label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<p class="muted">开了两步验证的账号（比如机主），密码对了之后下一页再输验证码。</p>
${errorLine(input.error)}
<div class="row"><button class="primary" name="action" value="allow">登录</button>${ticket ? '<button name="action" value="deny" formnovalidate>取消</button>' : ''}</div>
${ticket ? '<div class="row"><button name="action" value="signup" formnovalidate>没有账号？用邀请码注册</button></div>' : ''}</form>`,
  )
}

/**
 * The second step of signing in, for an account with two-step verification once its password was
 * right: a one-time code from its authenticator app, or one of its recovery codes.
 */
export function codePage(input: {
  action: string
  fields: Record<string, string>
  username: string
  /** Whether it offers to cancel the browser sign-in. */
  cancel: boolean
  error?: string
}): string {
  return page(
    '两步验证',
    `<h1>两步验证</h1><p class="muted">账号 <b>${escape(input.username)}</b> 开了两步验证：输入验证器 App 里的 6 位验证码。手机不在身边时，可以用一个恢复码代替，每个只能用一次。</p>
<form method="post" action="${escape(input.action)}">${hiddenFields(input.fields)}
<label for="code">验证码或恢复码</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" maxlength="64" required autofocus>
${errorLine(input.error)}
<div class="row"><button class="primary" name="action" value="code">继续</button>${input.cancel ? '<button name="action" value="deny" formnovalidate>取消</button>' : ''}</div></form>`,
  )
}

/** Signing up with an invite code, in the browser sign-in: the code, a username and a password. */
export function signupPage(input: { ticket: string; username?: string; error?: string }): string {
  return page(
    '注册',
    `<h1>用邀请码注册</h1><p class="muted">邀请码是机主给你的，只能用一次。定好用户名和密码就注册好了，会回到纸鸢并已登录。</p>
<form method="post" action="/signin/app/">${hidden('ticket', input.ticket)}
<label for="invite">邀请码</label><input id="invite" name="invite" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="64" required autofocus>
<label for="username">用户名</label><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="2" maxlength="32" value="${escape(input.username ?? '')}" required>
<p class="muted">2 到 32 位：字母、数字或 . _ -，以字母或数字开头，不分大小写。</p>
<label for="password">密码（至少 12 位）</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required>
<label for="password2">再输一次密码</label><input id="password2" name="password2" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required>
<p class="muted">以后登录只用用户名和密码，所以请用一个够长、没在别处用过的密码，最好让密码管理器生成并记住它。</p>
${errorLine(input.error)}
<div class="row"><button class="primary" name="action" value="signup-submit">注册</button><button name="action" value="login" formnovalidate>返回登录</button></div></form>`,
  )
}

export function consentPage(input: {
  action: string
  fields: Record<string, string>
  client: string
  username: string
}): string {
  return page(
    '允许登录',
    `<h1>允许这台设备登录？</h1><p>${escape(input.client)}</p><p class="muted">账号 <b>${escape(input.username)}</b>。允许后它能用这个账号收发推送。不认识的话请点「拒绝」。</p>
<form method="post" action="${escape(input.action)}">${hiddenFields(input.fields)}<div class="row"><button class="primary" name="action" value="allow">允许</button><button name="action" value="deny">拒绝</button></div>
<div class="row"><button name="action" value="switch">换个账号</button></div></form>`,
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
  username: string
}): string {
  return page(
    '允许设备登录',
    `<h1>允许这台设备登录？</h1><p>${escape(input.client)}</p>
<p class="muted">登录到账号 <b>${escape(input.username)}</b> · 验证码 ${escape(input.code)} · 来自 ${escape(input.address)} · ${ago(input.startedMsAgo)}开始</p>
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
  account: Account
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
    `<h1>已登录的设备</h1><p class="muted">账号 ${escape(input.account.username)}${input.account.email !== input.account.username ? ` · ${escape(input.account.email)}` : ''}</p>
${rows ? `<table>${rows}</table>` : '<p class="muted">没有已登录的设备。</p>'}
<h2>电脑</h2><p class="muted">登录了这个账号、开着远程访问和中转的电脑。让一台退出，在上面退出它的登录。</p>
${computers ? `<table>${computers}</table>` : '<p class="muted">还没有电脑。</p>'}
${
  input.account.owner
    ? '<p class="gap"><a href="/account/admin/">账号和邀请码</a></p><p class="muted">改密码和两步验证：在服务器上运行 <b>huli-cloud passwd</b> 或 <b>huli-cloud totp</b>（见服务端的说明）。</p>'
    : `<p class="muted gap">${input.account.totp ? '忘了密码或换了手机' : '忘了密码'}：请机主重设你的账号，再用新的邀请码重新设密码。</p>`
}
<form method="post" action="/account/signout">${hidden('csrf', input.csrf)}<div class="row"><button>退出网页登录</button></div></form>`,
  )
}

const STATUS_TEXT: Record<InviteStatus, string> = {
  open: '未使用',
  used: '已使用',
  revoked: '已撤销',
  expired: '已过期',
}

const STATE_TEXT: Record<AccountRow['state'], string> = {
  active: '正常',
  disabled: '已停用',
  reset: '等待用邀请码重设',
}

/** The owner's page: the accounts, which can be disabled and enabled, and the invites. */
export function ownerPage(input: {
  csrf: string
  accounts: AccountRow[]
  invites: InviteRow[]
  created?: { code: string; expiresAt: number }
  error?: string
}): string {
  const time = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
  const button = (action: string, fields: Record<string, string>, label: string, danger = false) =>
    `<form method="post" action="/account/admin/">${hidden('csrf', input.csrf)}${hiddenFields(fields)}<button${danger ? ' class="danger"' : ''} name="action" value="${action}">${label}</button></form>`
  const accounts = input.accounts
    .map((row) => {
      const state = row.owner ? '机主' : STATE_TEXT[row.state]
      const action = row.owner
        ? ''
        : row.state === 'disabled'
          ? button('enable', { username: row.username }, '启用')
          : button('disable', { username: row.username }, '停用', true)
      const signIn = row.state === 'reset' ? '' : row.twoStep ? ' · 两步验证' : ' · 仅密码'
      return `<tr><td><b>${escape(row.username)}</b> · ${state}${signIn}<br><span class="muted">创建于 ${time(row.createdAt)} · ${row.devices} 台设备 · ${row.computers} 台电脑</span></td><td>${action}</td></tr>`
    })
    .join('')
  const invites = input.invites
    .map((row) => {
      const what = row.resets === null ? '新账号' : `重设 ${escape(row.resets)}`
      const used =
        row.status === 'used' && row.usedBy !== null && row.usedAt !== null
          ? `：${escape(row.usedBy)}，${time(row.usedAt)}`
          : ''
      const action = row.status === 'open' ? button('revoke', { invite: row.id }, '撤销', true) : ''
      return `<tr><td>${escape(row.id)} · ${what} · ${STATUS_TEXT[row.status]}${used}<br><span class="muted">创建于 ${time(row.createdAt)} · 到期 ${time(row.expiresAt)}</span></td><td>${action}</td></tr>`
    })
    .join('')
  const days = [1, 3, 7, 14, 30]
    .map((d) => `<option value="${d}"${d === 7 ? ' selected' : ''}>${d} 天</option>`)
    .join('')
  const created = input.created
    ? `<p>新的邀请码（只显示这一次）：</p><p><code>${escape(input.created.code)}</code></p><p class="muted">到期 ${time(input.created.expiresAt)}，只能用一次。发给要注册的人，让他在纸鸢的登录页点「用邀请码注册」。</p>`
    : ''
  return page(
    '账号和邀请码',
    `<h1>账号和邀请码</h1>
${errorLine(input.error)}
<h2>账号</h2><table>${accounts}</table>
<p class="muted">停用后它不能登录，已登录的设备和电脑立刻断开；启用后恢复。删除账号、重设密码在服务器上运行 <b>huli-cloud user</b>（见服务端的说明）。</p>
<h2>邀请码</h2>${created}
<form method="post" action="/account/admin/">${hidden('csrf', input.csrf)}
<label for="days">有效期</label><select id="days" name="days">${days}</select>
<div class="row"><button class="primary" name="action" value="invite">新建邀请码</button></div></form>
${invites ? `<table>${invites}</table>` : '<p class="muted">还没有邀请码。</p>'}
<p class="gap"><a href="/account/devices/">返回已登录的设备</a></p>`,
  )
}
