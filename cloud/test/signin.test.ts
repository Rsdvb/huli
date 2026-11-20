// Signing in in two steps, on the browser sign-in the desktop app, the web client and the phone
// open (PKCE) and on the service's own pages (/web/login, for /device and /account): the password
// first, and only once it is right, for an account with two-step verification (the owner's
// always), its code. An account without one is done with its password. Before the password is
// right nothing tells an account that exists from one that does not, or one with two-step
// verification from one without: the same answer, the same log line, the same limits.

import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AccountApi, DESKTOP_CLIENT, WEB_CLIENT } from '@shared/account-api'
import { MOBILE_CLIENT, MOBILE_REDIRECT, WEB_CALLBACK_PATH } from '@shared/huli-cloud'
import { runAdmin } from '../src/admin'
import {
  base32Decode,
  hashPassword,
  hotp,
  newTotpSecret,
  pkceChallenge,
  randomToken,
  sha256Hex,
  TOTP_PERIOD_S,
} from '../src/secrets'
import { makeServer, type ServerParts } from '../src/server'
import { passwordOnly } from '../src/store'
import { makeMember, makeOwner, signInSteps, stepOf } from './accounts'

const WEB_ORIGIN = 'https://app.example'
const LOOPBACK = 'http://127.0.0.1:5555/callback'
const REDIRECTS: Record<string, string> = {
  [DESKTOP_CLIENT]: LOOPBACK,
  [WEB_CLIENT]: `${WEB_ORIGIN}${WEB_CALLBACK_PATH}`,
  [MOBILE_CLIENT]: MOBILE_REDIRECT,
}
const PASSWORD = 'correct horse battery staple'
const WRONG = 'not the password at all'

let clock = Date.UTC(2026, 10, 20, 12, 0, 0)
const now = () => clock
const nextStep = () => (clock += TOTP_PERIOD_S * 1000)
const ownerSecret = newTotpSecret()
const tessSecret = newTotpSecret()
const code = (secret: string) =>
  hotp(base32Decode(secret), Math.floor(clock / 1000 / TOTP_PERIOD_S))

let parts: ServerParts
let base: string
let dir: string
const lines: string[] = []
let address = 0
/** An address no other sign-in in these tests came from, so that no limit carries over. */
const fresh = () => `192.0.2.${++address}`

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'huli-signin-'))
  parts = makeServer(
    { origin: 'http://127.0.0.1', dataDir: dir, trustProxy: true, webOrigin: WEB_ORIGIN },
    null,
    { now, log: (line) => lines.push(line) },
  )
  const password = await hashPassword(PASSWORD)
  makeOwner(parts.store, {
    password,
    totp: ownerSecret,
    totpLastStep: -1,
    recovery: [sha256Hex('aaaaa-bbbbb')],
  })
  // A friend who bound two-step verification before sign-up stopped asking for it; one who signed
  // up with a password alone; and one whose reset waits for its invite.
  makeMember(parts.store, 'tess', { password, totp: tessSecret, totpLastStep: -1, recovery: [] })
  makeMember(parts.store, 'pal', passwordOnly(password))
  makeMember(parts.store, 'wren', passwordOnly(password))
  expect(runAdmin(parts.admin, { op: 'reset', username: 'wren', days: 7 }).ok).toBe(true)
  await new Promise<void>((resolve) => parts.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(parts.server.address() as AddressInfo).port}`
})

afterAll(() => {
  parts.server.close()
  rmSync(dir, { recursive: true, force: true })
})

async function start(from: string, clientId = DESKTOP_CLIENT) {
  const verifier = randomToken(48)
  const url = new URL('/signin/app/', base)
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECTS[clientId]!,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    state: 'state-1',
  }).toString()
  const html = await (await fetch(url, { headers: { 'x-real-ip': from } })).text()
  return { ticket: /name="ticket" value="([^"]+)"/.exec(html)![1]!, verifier, clientId }
}

const post =
  (from: string, pathname = '/signin/app/') =>
  (fields: Record<string, string>) =>
    fetch(new URL(pathname, base), {
      method: 'POST',
      body: new URLSearchParams(fields),
      redirect: 'manual',
      headers: { 'x-real-ip': from },
    })

/** The tokens a browser sign-in's redirect hands its client. */
async function exchange(answer: Response, started: Awaited<ReturnType<typeof start>>) {
  expect(answer.status).toBe(302)
  const location = new URL(answer.headers.get('location')!)
  expect(location.href.startsWith(REDIRECTS[started.clientId]!)).toBe(true)
  expect(location.searchParams.get('state')).toBe('state-1')
  return new AccountApi(base, fetch, now).exchangeCode({
    code: location.searchParams.get('code')!,
    redirectUri: REDIRECTS[started.clientId]!,
    verifier: started.verifier,
    clientId: started.clientId,
  })
}

const me = async (access: string) => (await new AccountApi(base, fetch, now).me(access)).account

describe('an account without two-step verification', () => {
  it('signs in with its password alone, on the desktop, the web and the phone', async () => {
    const pal = parts.store.findAccount('pal')!
    for (const clientId of [DESKTOP_CLIENT, WEB_CLIENT, MOBILE_CLIENT]) {
      const from = fresh()
      const started = await start(from, clientId)
      const answer = await post(from)({
        ticket: started.ticket,
        action: 'allow',
        username: 'pal',
        password: PASSWORD,
      })
      const tokens = await exchange(answer, started)
      expect((await me(tokens.accessToken)).id).toBe(pal.id)
    }
    expect(lines).toContain(`huli-cloud: signed in 未知设备 as pal`)
  })

  it('signs in to the web pages and approves a device code with its password alone', async () => {
    const answer = await post(
      fresh(),
      '/web/login',
    )({ next: '/device', username: 'pal', password: PASSWORD })
    expect(answer.status).toBe(302)
    expect(answer.headers.get('location')).toBe('/device')
    const cookie = answer.headers.get('set-cookie')!.split(';')[0]!
    const api = new AccountApi(base, fetch, now)
    const device = await api.startDevice({
      kind: 'daemon',
      name: 'Box',
      os: 'linux',
      arch: 'x64',
      version: '1',
    })
    const page = await (await fetch(new URL('/device', base), { headers: { cookie } })).text()
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!
    const approved = await fetch(new URL('/device', base), {
      method: 'POST',
      body: new URLSearchParams({ csrf, user_code: device.userCode, action: 'allow' }),
      headers: { cookie },
    })
    expect(await approved.text()).toContain('已允许')
    clock += 60_000
    const tokens = await api.pollDevice(device.deviceCode)
    expect((await me(tokens.accessToken)).email).toBe('pal')
    // Its own page says what to do when the password is lost, and nothing of a code.
    const devices = await (
      await fetch(new URL('/account/devices/', base), { headers: { cookie } })
    ).text()
    expect(devices).toContain('忘了密码：请机主重设你的账号')
    expect(devices).not.toContain('两步验证')
    // The owner's page is still the owner's alone.
    expect((await fetch(new URL('/account/admin/', base), { headers: { cookie } })).status).toBe(
      403,
    )
  })
})

describe('an account with two-step verification', () => {
  it('asks the owner for its code once the password is right, and takes nothing less', async () => {
    const owner = parts.store.owner()!
    const from = fresh()
    const started = await start(from)
    const send = post(from)
    const first = await send({ ticket: started.ticket, action: 'allow', password: PASSWORD })
    expect(first.status).toBe(200)
    expect(first.headers.get('location')).toBeNull()
    const html = await first.text()
    expect(html).toContain('账号 <b>owner</b> 开了两步验证')
    const step = stepOf(html)!
    expect(step).toBeTruthy()
    const again = (codeText: string) =>
      send({ ticket: started.ticket, step, action: 'code', code: codeText })
    for (const wrong of ['', '000000', '12345', 'zzzzz-zzzzz']) {
      const refused = await again(wrong)
      expect(refused.status).toBe(401)
      expect(await refused.text()).toContain('验证码不对')
    }
    nextStep()
    const tokens = await exchange(await again(code(ownerSecret)), started)
    expect((await me(tokens.accessToken)).id).toBe(owner.id)
    // A code works once: the same one in a new sign-in is refused.
    const second = await start(from)
    const reused = await signInSteps(
      post(from),
      { ticket: second.ticket, action: 'allow', password: PASSWORD },
      code(ownerSecret),
    )
    expect(reused.status).toBe(401)
  })

  it('asks a friend who bound it for the code too, and takes a recovery code once', async () => {
    nextStep()
    const from = fresh()
    const tess = await start(from)
    const signedIn = await signInSteps(
      post(from),
      { ticket: tess.ticket, action: 'allow', username: 'tess', password: PASSWORD },
      code(tessSecret),
    )
    expect((await me((await exchange(signedIn, tess)).accessToken)).email).toBe('tess')
    for (const expected of [302, 401]) {
      const started = await start(from)
      const answer = await signInSteps(
        post(from),
        { ticket: started.ticket, action: 'allow', password: PASSWORD },
        'AAAAA-BBBBB',
      )
      expect(answer.status).toBe(expected)
    }
    expect(lines).toContain('huli-cloud: a recovery code was used')
  })

  it('reaches the owner’s page through the web sign-in’s two steps', async () => {
    nextStep()
    const answer = await signInSteps(
      post(fresh(), '/web/login'),
      { next: '/account/admin/', password: PASSWORD },
      code(ownerSecret),
    )
    expect(answer.status).toBe(302)
    expect(answer.headers.get('location')).toBe('/account/admin/')
    const cookie = answer.headers.get('set-cookie')!.split(';')[0]!
    const page = await fetch(new URL('/account/admin/', base), { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<b>pal</b> · 正常 · 仅密码')
  })
})

describe('the code’s step', () => {
  it('comes only after a right password, and serves only the sign-in it came from', async () => {
    const from = fresh()
    for (const username of ['', 'owner', 'tess']) {
      const started = await start(from)
      const answer = await post(from)({
        ticket: started.ticket,
        action: 'allow',
        username,
        password: WRONG,
      })
      expect(answer.status).toBe(401)
      expect(stepOf(await answer.text())).toBeNull()
    }
    // A step nobody was given leads nowhere, on either page.
    const started = await start(fresh())
    const made = { step: randomToken(18), action: 'code', code: code(ownerSecret) }
    const forged = await post(from)({ ticket: started.ticket, ...made })
    expect(forged.status).toBe(400)
    expect(await forged.text()).toContain('这次登录已过期')
    expect((await post(from, '/web/login')(made)).status).toBe(400)

    // A real step, for one sign-in page alone.
    const other = fresh()
    const mine = await start(other)
    const theirs = await start(other)
    const page = await post(other)({ ticket: mine.ticket, action: 'allow', password: PASSWORD })
    const step = stepOf(await page.text())!
    nextStep()
    const fields = { step, action: 'code', code: code(ownerSecret) }
    expect((await post(other)({ ticket: theirs.ticket, ...fields })).status).toBe(400)
    expect((await post(other, '/web/login')(fields)).status).toBe(400)
    expect((await post(other)({ ticket: mine.ticket, ...fields })).status).toBe(302)
    // Spent with its sign-in.
    expect((await post(other)({ ticket: mine.ticket, ...fields })).status).toBe(400)
    // And a step of the web pages serves no browser sign-in.
    const web = await post(other, '/web/login')({ next: '/device', password: PASSWORD })
    const webStep = stepOf(await web.text())!
    nextStep()
    const later = await start(other)
    const crossed = await post(other)({
      ticket: later.ticket,
      step: webStep,
      action: 'code',
      code: code(ownerSecret),
    })
    expect(crossed.status).toBe(400)
  })

  it('ends after five wrong codes, and the password is asked again', async () => {
    const from = fresh()
    const started = await start(from)
    const page = await post(from)({ ticket: started.ticket, action: 'allow', password: PASSWORD })
    const step = stepOf(await page.text())!
    const send = (codeText: string) =>
      post(from)({ ticket: started.ticket, step, action: 'code', code: codeText })
    for (let i = 0; i < 4; i++) expect(await (await send('000000')).text()).toContain('验证码不对')
    const last = await (await send('000000')).text()
    expect(last).toContain('验证码错了太多次')
    expect(last).toContain('name="password"')
    expect(stepOf(last)).toBeNull()
    nextStep()
    expect((await send(code(ownerSecret))).status).not.toBe(302)
    expect(lines.filter((l) => l === `huli-cloud: login failed from ${from}`)).toHaveLength(5)
  })

  it('ends when the password changes or the account is reset in between', async () => {
    const from = fresh()
    const step = async (username: string) => {
      const started = await start(from)
      const page = await post(from)({
        ticket: started.ticket,
        action: 'allow',
        username,
        password: PASSWORD,
      })
      return { ticket: started.ticket, step: stepOf(await page.text())! }
    }
    const owner = parts.store.owner()!
    const pending = await step('owner')
    parts.store.updateAccount(owner.id, { password: await hashPassword(PASSWORD) })
    nextStep()
    const changed = await post(from)({ ...pending, action: 'code', code: code(ownerSecret) })
    expect(changed.status).toBe(400)
    expect(await changed.text()).toContain('这次登录已过期')

    const tess = await step('tess')
    expect(runAdmin(parts.admin, { op: 'reset', username: 'tess', days: 1 }).ok).toBe(true)
    nextStep()
    const reset = await post(from)({ ...tess, action: 'code', code: code(tessSecret) })
    expect(reset.status).toBe(400)
    expect(parts.store.findAccount('tess')!.totp).toBeNull()
  })
})

describe('a wrong password', () => {
  /** Who is tried: accounts with and without a code, one waiting for its reset, and nobody. */
  const NAMES = ['', 'owner', 'tess2', 'pal', 'wren', 'ghost']

  beforeAll(async () => {
    makeMember(parts.store, 'tess2', {
      password: await hashPassword(PASSWORD),
      totp: newTotpSecret(),
      totpLastStep: -1,
      recovery: [],
    })
  })

  /** The answer with what differs by design taken out: the sign-in page and the name typed. */
  const plain = (html: string, username: string) =>
    html
      .replace(/name="ticket" value="[^"]+"/, 'name="ticket" value="T"')
      .replace(`value="${username}"`, 'value="NAME"')

  async function wrong(from: string, username: string, pathname: string) {
    const before = lines.length
    const fields: Record<string, string> =
      pathname === '/web/login'
        ? { next: '/account/devices/', username, password: WRONG }
        : { ticket: (await start(from)).ticket, action: 'allow', username, password: WRONG }
    const answer = await post(from, pathname)(fields)
    return {
      status: answer.status,
      html: plain(await answer.text(), username),
      lines: lines.slice(before),
    }
  }

  it('gets the same answer and log line whoever it names, on both pages', async () => {
    for (const pathname of ['/signin/app/', '/web/login']) {
      const seen: { status: number; html: string }[] = []
      for (const username of NAMES) {
        const from = fresh()
        const answer = await wrong(from, username, pathname)
        expect(answer.lines, username).toEqual([`huli-cloud: login failed from ${from}`])
        seen.push({ status: answer.status, html: answer.html })
      }
      expect(seen[0]!.status).toBe(401)
      expect(seen[0]!.html).toContain('用户名或密码不对')
      expect(seen[0]!.html).not.toMatch(/验证码不对|两步验证码|name="step"/)
      for (const answer of seen) expect(answer).toEqual(seen[0])
    }
  })

  it('meets the same limits whoever it names: five for each name, ten for an address', async () => {
    const seen: { blocked: { status: number; html: string }; other: number }[] = []
    for (const username of NAMES) {
      const from = fresh()
      for (let i = 0; i < 5; i++)
        expect((await wrong(from, username, '/signin/app/')).status).toBe(401)
      const blocked = await wrong(from, username, '/signin/app/')
      expect(blocked.lines, username).toEqual([`huli-cloud: login blocked from ${from}`])
      // Another name nobody has, from the same address, is not blocked by them.
      const other = await wrong(from, `nobody-${username || 'empty'}`, '/signin/app/')
      expect(other.lines, username).toEqual([`huli-cloud: login failed from ${from}`])
      seen.push({ blocked: { status: blocked.status, html: blocked.html }, other: other.status })
    }
    expect(seen[0]!.blocked.status).toBe(401)
    expect(seen[0]!.blocked.html).toContain('尝试次数太多')
    for (const answer of seen) expect(answer).toEqual(seen[0])
  })
})
