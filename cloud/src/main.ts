// huli-cloud: `serve` runs the service; `init`, `passwd`, `totp` and `signout-all` manage the one
// account from the server's own terminal, where the password is typed and never logged.

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { renderUnicodeCompact } from 'uqr'
import { Apns } from './apns'
import { loadConfig } from './config'
import {
  checkTotp,
  hashPassword,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  sha256Hex,
} from './secrets'
import { makeServer } from './server'
import { Store } from './store'

function dataDir(): string {
  const dir = process.env.HULI_DATA_DIR?.trim()
  if (!dir) throw new Error('HULI_DATA_DIR is not set')
  return dir
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
    const first = await ask('新密码（至少 12 位，输入时不显示）：', true)
    if (first.length < 12) {
      console.log('太短了，至少 12 位。')
      continue
    }
    const second = await ask('再输一次：', true)
    if (first === second) return first
    console.log('两次不一样，重来。')
  }
}

/** Shows a new TOTP secret and waits for a code from it; the secret and its last step. */
async function bindTotp(email: string): Promise<{ secret: string; step: number }> {
  const secret = newTotpSecret()
  const uri = otpauthUri(secret, email)
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

async function init(force: boolean): Promise<void> {
  const store = new Store(dataDir())
  if (store.account && !force) {
    throw new Error('账号已经存在。要重建请加 --force（会让所有设备退出登录）。')
  }
  const email = (await ask('邮箱（只用来显示）：')).trim()
  const name = (await ask('名字（可留空）：')).trim() || null
  const password = await hashPassword(await newPassword())
  const { secret, step } = await bindTotp(email)
  const recovery = newRecoveryCodes()
  store.setAccount({
    id: randomUUID(),
    email,
    name,
    password,
    totp: secret,
    totpLastStep: step,
    recovery: recovery.map(sha256Hex),
  })
  for (const family of store.families()) store.revokeFamily(family.id)
  showRecovery(recovery)
  console.log('账号已建好。')
}

async function passwd(): Promise<void> {
  const store = new Store(dataDir())
  if (!store.account) throw new Error('还没有账号，先运行 init。')
  store.updateAccount({ password: await hashPassword(await newPassword()) })
  console.log('密码已改。已登录的设备不受影响；要让它们都退出，运行 signout-all。')
}

async function totp(): Promise<void> {
  const store = new Store(dataDir())
  if (!store.account) throw new Error('还没有账号，先运行 init。')
  const { secret, step } = await bindTotp(store.account.email)
  const recovery = newRecoveryCodes()
  store.updateAccount({ totp: secret, totpLastStep: step, recovery: recovery.map(sha256Hex) })
  showRecovery(recovery)
  console.log('两步验证已重新绑定，旧的恢复码作废。')
}

function signOutAll(): void {
  const store = new Store(dataDir())
  const families = store.families()
  for (const family of families) store.revokeFamily(family.id)
  console.log(`已让 ${families.length} 台设备退出登录。`)
}

function serve(): void {
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

async function main(): Promise<void> {
  const [command = 'serve', ...rest] = process.argv.slice(2)
  switch (command) {
    case 'serve':
      return serve()
    case 'init':
      return init(rest.includes('--force'))
    case 'passwd':
      return passwd()
    case 'totp':
      return totp()
    case 'signout-all':
      return signOutAll()
    default:
      console.log('用法：huli-cloud [serve | init [--force] | passwd | totp | signout-all]')
      process.exitCode = 2
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message)
  process.exit(1)
})
