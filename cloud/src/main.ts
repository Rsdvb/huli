// huli-cloud: `serve` runs the service; the other commands manage the accounts from the server's
// own terminal (see cli.ts and cloud/README.md). Each change goes to the running service over its
// admin socket, so that it applies to the state the service holds and takes effect at once, or,
// with the service stopped, straight to state.json. Passwords are typed and never logged.

import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { renderUnicodeCompact } from 'uqr'
import {
  adminSocketPath,
  callAdmin,
  runAdmin,
  type AdminAnswer,
  type AdminRequest,
  type InviteRow,
} from './admin'
import { Apns } from './apns'
import { MIN_PASSWORD } from './auth'
import { parseCommand, USAGE } from './cli'
import { loadConfig } from './config'
import { errorTrace } from './http'
import {
  checkTotp,
  hashPassword,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  sha256Hex,
} from './secrets'
import { makeServer } from './server'
import { normalizeUsername, OWNER_USERNAME, Store } from './store'

function dataDir(): string {
  const dir = process.env.HULI_DATA_DIR?.trim()
  if (!dir) throw new Error('HULI_DATA_DIR is not set')
  return dir
}

/**
 * Sends a change to the running service, or applies it to state.json when none runs. Never as
 * root: state.json and its copies must stay the service user's, or the service cannot read them.
 */
async function send(request: AdminRequest): Promise<AdminAnswer> {
  if (process.getuid?.() === 0) {
    throw new Error('别用 root 运行：用 sudo -u huli …，state.json 要一直属于 huli。')
  }
  const dir = dataDir()
  const answer =
    (await callAdmin(adminSocketPath(dir), request)) ??
    runAdmin({ store: new Store(dir), kicked: () => {} }, request)
  if (!answer.ok) throw new Error(answer.error)
  return answer.answer
}

async function ask(question: string, hidden = false): Promise<string> {
  let muted = false
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk)
      done()
    },
  })
  const rl = createInterface({ input: process.stdin, output, terminal: true })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer)
    })
    muted = hidden
  })
}

async function newPassword(): Promise<string> {
  for (;;) {
    const first = await ask(`新密码（至少 ${MIN_PASSWORD} 位，输入时不显示）：`, true)
    if (first.length < MIN_PASSWORD) {
      console.log(`太短了，至少 ${MIN_PASSWORD} 位。`)
      continue
    }
    const second = await ask('再输一次：', true)
    if (first === second) return first
    console.log('两次不一样，重来。')
  }
}

/** Shows a new TOTP secret and waits for a code from it; the secret and its last step. */
async function bindTotp(label: string): Promise<{ secret: string; step: number }> {
  const secret = newTotpSecret()
  const uri = otpauthUri(secret, label)
  console.log('\n用验证器 App（如 iOS「密码」、Google Authenticator）扫这个二维码：\n')
  console.log(renderUnicodeCompact(uri))
  console.log(`扫不了的话手动输入密钥：${secret}\n`)
  for (;;) {
    const code = (await ask('输入 App 里显示的 6 位验证码确认：')).trim()
    const step = checkTotp(secret, code, Date.now(), -1)
    if (step !== null) return { secret, step }
    console.log('不对，再试一次。')
  }
}

function showRecovery(codes: string[]): void {
  console.log(
    '\n恢复码（每个只能用一次，手机丢了时代替验证码登录）。现在抄下来，之后不会再显示：\n',
  )
  for (const code of codes) console.log(`  ${code}`)
  console.log('')
}

const time = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false })

async function owner() {
  const { accounts = [] } = await send({ op: 'list' })
  return accounts.find((account) => account.owner) ?? null
}

async function init(force: boolean): Promise<void> {
  if ((await owner()) && !force) {
    throw new Error('账号已经存在。要重建机主账号请加 --force（机主的所有设备都会退出登录）。')
  }
  const typed = (await ask(`机主的用户名（默认 ${OWNER_USERNAME}）：`)).trim() || OWNER_USERNAME
  const username = normalizeUsername(typed)
  if (!username) throw new Error('用户名要 2 到 32 位：字母、数字或 . _ -，以字母或数字开头。')
  const email = (await ask('邮箱（只用来显示）：')).trim() || username
  const name = (await ask('名字（可留空）：')).trim() || null
  const password = await hashPassword(await newPassword())
  const { secret, step } = await bindTotp(email)
  const recovery = newRecoveryCodes()
  await send({
    op: 'init',
    force,
    username,
    email,
    name,
    credentials: { password, totp: secret, totpLastStep: step, recovery: recovery.map(sha256Hex) },
  })
  showRecovery(recovery)
  console.log(`机主账号 ${username} 已建好。登录时用户名可以不填。`)
}

async function passwd(): Promise<void> {
  if (!(await owner())) throw new Error('还没有账号，先运行 init。')
  await send({ op: 'passwd', password: await hashPassword(await newPassword()) })
  console.log('密码已改。已登录的设备不受影响；要让它们都退出，运行 signout-all。')
}

async function totp(): Promise<void> {
  const account = await owner()
  if (!account) throw new Error('还没有账号，先运行 init。')
  const { secret, step } = await bindTotp(account.email)
  const recovery = newRecoveryCodes()
  await send({ op: 'totp', totp: secret, totpLastStep: step, recovery: recovery.map(sha256Hex) })
  showRecovery(recovery)
  console.log('两步验证已重新绑定，旧的恢复码作废。')
}

async function signOutAll(username: string | null): Promise<void> {
  const name = username ?? (await owner())?.username
  if (!name) throw new Error('还没有账号，先运行 init。')
  const { signedOut = 0 } = await send({ op: 'signout', username: name })
  console.log(`已让 ${name} 的 ${signedOut} 台设备退出登录。`)
}

function inviteLine(invite: InviteRow): string {
  const what = invite.resets === null ? '新账号' : `重设 ${invite.resets}`
  const status = { open: '未使用', used: '已使用', revoked: '已撤销', expired: '已过期' }[
    invite.status
  ]
  const used = invite.status === 'used' && invite.usedBy ? `（${invite.usedBy}）` : ''
  return `  ${invite.id}  ${what}  ${status}${used}  到期 ${time(invite.expiresAt)}`
}

function showCode(code: string, invite: InviteRow): void {
  console.log(`\n邀请码（只显示这一次，只能用一次，${time(invite.expiresAt)} 前有效）：\n`)
  console.log(`    ${code}\n`)
  console.log(
    invite.resets === null
      ? '发给要注册的人：在纸鸢手机端「设置 › 账号」点「用邀请码注册」，或电脑端「设置 › 账号」点「注册账号」，自己定用户名和密码（至少 12 位）就注册好了，以后只用密码登录。'
      : `发给 ${invite.resets}：在纸鸢的登录页点「用邀请码注册」，用户名填 ${invite.resets}，重新设密码（至少 12 位），以后只用密码登录。`,
  )
  console.log(`撤销：huli-cloud user uninvite ${invite.id}`)
}

async function userList(): Promise<void> {
  const { accounts = [], invites = [] } = await send({ op: 'list' })
  console.log('账号：')
  for (const a of accounts) {
    const state = a.owner
      ? '机主'
      : { active: '正常', disabled: '已停用', reset: '等待重设' }[a.state]
    const signIn = a.state === 'reset' ? '' : a.twoStep ? '  两步验证' : '  仅密码'
    console.log(
      `  ${a.username}  ${state}${signIn}  创建于 ${time(a.createdAt)}  ${a.devices} 台设备  ${a.computers} 台电脑  ${a.pushTargets} 个推送目标`,
    )
  }
  console.log(invites.length ? '邀请码：' : '没有邀请码。')
  for (const invite of invites) console.log(inviteLine(invite))
}

async function confirm(question: string, expected: string): Promise<void> {
  if ((await ask(question)).trim() !== expected) throw new Error('已取消。')
}

async function run(): Promise<void> {
  const command = parseCommand(process.argv.slice(2))
  if (!command) {
    console.log(USAGE)
    process.exitCode = 2
    return
  }
  switch (command.name) {
    case 'serve':
      return serve()
    case 'init':
      return init(command.force)
    case 'passwd':
      return passwd()
    case 'totp':
      return totp()
    case 'signout-all':
      return signOutAll(command.username)
    case 'user-list':
      return userList()
    case 'user-invite': {
      const { code, invite } = await send({ op: 'invite', days: command.days })
      return showCode(code!, invite!)
    }
    case 'user-uninvite':
      await send({ op: 'uninvite', id: command.id })
      return console.log(`邀请码 ${command.id} 已撤销。`)
    case 'user-disable':
      await send({ op: 'disable', username: command.username })
      return console.log(
        `${command.username} 已停用：不能登录，令牌一律拒绝，中转上的连接已断开。启用后原来的登录恢复；要彻底踢出，再运行 signout-all ${command.username}。`,
      )
    case 'user-enable':
      await send({ op: 'enable', username: command.username })
      return console.log(`${command.username} 已启用。`)
    case 'user-remove': {
      await confirm(
        `删除 ${command.username} 和它的所有设备、电脑、推送目标，不能恢复。再输一次用户名确认：`,
        command.username,
      )
      const { signedOut = 0 } = await send({ op: 'remove', username: command.username })
      return console.log(`${command.username} 已删除，${signedOut} 台设备已退出登录。`)
    }
    case 'user-reset': {
      await confirm(
        `${command.username} 的所有设备会退出登录，密码和两步验证清掉，直到用新邀请码重新设密码。继续请输入 y：`,
        'y',
      )
      const {
        code,
        invite,
        signedOut = 0,
      } = await send({
        op: 'reset',
        username: command.username,
        days: command.days,
      })
      console.log(`${command.username} 的 ${signedOut} 台设备已退出登录。`)
      return showCode(code!, invite!)
    }
  }
}

function serve(): void {
  // A promise some path forgot to handle is logged, not the end of the service; its message is
  // left out, as it may quote a token.
  process.on('unhandledRejection', (reason) => {
    console.error(`huli-cloud: unhandled rejection: ${errorTrace(reason)}`)
  })
  const config = loadConfig()
  const apns = config.apns ? new Apns(config.apns) : null
  const { server, relay } = makeServer(config, apns ? { send: apns.send, topic: apns.topic } : null)
  server.listen(config.port, config.host, () => {
    console.warn(
      `huli-cloud: listening on ${config.host}:${config.port} for ${config.origin}` +
        (apns ? '' : ' (no APNs key: pushes are refused)') +
        (config.webOrigin ? `; web client at ${config.webOrigin}` : '') +
        (config.regions ? '' : '; no signed region list'),
    )
  })
  const stop = () => {
    relay.close()
    apns?.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

run().catch((error: unknown) => {
  console.error((error as Error).message)
  process.exit(1)
})
