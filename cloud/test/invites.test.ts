// Signing up with an invite code inside the browser sign-in, as the desktop app, the phone and
// the web client open it: a username and a password make the account, with no two-step
// verification, and the client is signed in to it. The code works once, lapses, can be revoked,
// is never guessed (limits by address and in all), and nothing makes an account without one. A
// reset invite sets an account's password anew after its devices were signed out, and leaves it
// without two-step verification. The owner's page makes and revokes invites, and nobody else's
// session reaches it.

import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AccountApi, DESKTOP_CLIENT } from '@shared/account-api'
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
import { makeOwner, signInSteps, stepOf } from './accounts'

const REDIRECT = 'http://127.0.0.1:5555/callback'
const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a different long password'

let clock = Date.UTC(2026, 10, 19, 12, 0, 0)
const now = () => clock
const nextStep = () => (clock += TOTP_PERIOD_S * 1000)
const totp = (secret: string) =>
  hotp(base32Decode(secret), Math.floor(clock / 1000 / TOTP_PERIOD_S))

let parts: ServerParts
let base: string
let dir: string
let ownerSecret: string
const lines: string[] = []

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'huli-invites-'))
  parts = makeServer({ origin: 'http://127.0.0.1', dataDir: dir, trustProxy: true }, null, {
    now,
    log: (line) => lines.push(line),
  })
  ownerSecret = newTotpSecret()
  makeOwner(parts.store, {
    password: await hashPassword(PASSWORD),
    totp: ownerSecret,
    totpLastStep: -1,
    recovery: [],
  })
  await new Promise<void>((resolve) => parts.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(parts.server.address() as AddressInfo).port}`
})

afterAll(() => {
  parts.server.close()
  rmSync(dir, { recursive: true, force: true })
})

const field = (html: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] ?? null

function invite(days = 7): string {
  const answer = runAdmin(parts.admin, { op: 'invite', days })
  if (!answer.ok || !answer.answer.code) throw new Error('no invite')
  return answer.answer.code
}

interface Started {
  ticket: string
  verifier: string
  html: string
}

async function start(address: string, mode: 'register' | null = 'register'): Promise<Started> {
  const verifier = randomToken(48)
  const url = new URL('/signin/app/', base)
  url.search = new URLSearchParams({
    client_id: DESKTOP_CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    state: 'state-1',
    ...(mode ? { mode } : {}),
  }).toString()
  const html = await (await fetch(url, { headers: { 'x-real-ip': address } })).text()
  return { ticket: field(html, 'ticket')!, verifier, html }
}

function post(address: string, fields: Record<string, string>, cookie?: string) {
  return fetch(new URL('/signin/app/', base), {
    method: 'POST',
    body: new URLSearchParams(fields),
    redirect: 'manual',
    headers: { 'x-real-ip': address, ...(cookie ? { cookie } : {}) },
  })
}

/** The sign-up form posted: what came back, and the code its redirect carries when it worked. */
async function submit(
  address: string,
  ticket: string,
  fields: { invite: string; username: string; password?: string; password2?: string },
) {
  const password = fields.password ?? PASSWORD
  const answer = await post(address, {
    ticket,
    action: 'signup-submit',
    invite: fields.invite,
    username: fields.username,
    password,
    password2: fields.password2 ?? password,
  })
  const location = answer.headers.get('location')
  return {
    status: answer.status,
    html: await answer.text(),
    location: location ? new URL(location) : null,
    cookie: answer.headers.get('set-cookie')?.split(';')[0] ?? null,
  }
}

/** A whole sign-up, through to the client holding tokens of the new account. */
async function signUp(address: string, code: string, username: string, password = PASSWORD) {
  const { ticket, verifier } = await start(address)
  const done = await submit(address, ticket, { invite: code, username, password })
  expect(done.status).toBe(302)
  expect(done.location!.origin + done.location!.pathname).toBe(REDIRECT)
  expect(done.location!.searchParams.get('state')).toBe('state-1')
  const tokens = await new AccountApi(base, fetch, now).exchangeCode({
    code: done.location!.searchParams.get('code')!,
    redirectUri: REDIRECT,
    verifier,
  })
  return { tokens, cookie: done.cookie! }
}

describe('signing up with an invite code', () => {
  it('offers sign-up on the sign-in page, and opens on it in register mode', async () => {
    const plain = await start('192.0.2.1', null)
    expect(plain.html).toContain('name="username"')
    expect(plain.html).toContain('value="signup"')
    const shown = await post('192.0.2.1', { ticket: plain.ticket, action: 'signup' })
    expect(await shown.text()).toContain('name="invite"')
    const register = await start('192.0.2.1')
    expect(register.html).toContain('name="invite"')
    expect(register.html).toContain('autocomplete="new-password"')
    // A username and a password are all it asks: no authenticator, no codes.
    expect(register.html).not.toMatch(/验证器|两步验证|恢复码|otpauth/)
  })

  it('makes an account with a password alone and signs the client in to it at once', async () => {
    const code = invite()
    const { tokens } = await signUp('192.0.2.2', code, 'Alice')
    const me = await new AccountApi(base, fetch, now).me(tokens.accessToken)
    const alice = parts.store.findAccount('alice')!
    expect(me.account).toMatchObject({ id: alice.id, email: 'alice', name: null })
    expect(alice).toMatchObject({ owner: false, totp: null, totpLastStep: -1, recovery: [] })
    expect(lines).toContain('huli-cloud: signed up account alice')
    const listed = runAdmin(parts.admin, { op: 'list' })
    expect(listed.ok && listed.answer.invites?.[0]).toMatchObject({
      status: 'used',
      usedBy: 'alice',
    })
    expect(listed.ok && listed.answer.accounts?.find((a) => a.username === 'alice')).toMatchObject({
      state: 'active',
      twoStep: false,
    })

    // Signing in later: the username and the password, and nothing after them.
    const later = await start('192.0.2.2', null)
    const signedIn = await post('192.0.2.2', {
      ticket: later.ticket,
      action: 'allow',
      username: 'alice',
      password: PASSWORD,
    })
    expect(signedIn.status).toBe(302)
    expect(new URL(signedIn.headers.get('location')!).searchParams.get('code')).toBeTruthy()
  })

  it('takes an invite once, and the sign-up that came second finds it used', async () => {
    const code = invite()
    const first = await start('192.0.2.3')
    const second = await start('192.0.2.3')
    // Both at once: both find the invite open before either's password is hashed, and only the
    // first to be done uses it.
    const [a, b] = await Promise.all([
      submit('192.0.2.3', first.ticket, { invite: code, username: 'bob' }),
      submit('192.0.2.3', second.ticket, { invite: code, username: 'bob2' }),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses[0]).toBe(302)
    expect([401, 409]).toContain(statuses[1])
    const loser = a.status === 302 ? b : a
    expect(loser.html).toMatch(/邀请码刚刚被用掉或撤销了|邀请码不对、已经用过或已经过期/)
    expect(
      [parts.store.findAccount('bob'), parts.store.findAccount('bob2')].filter(Boolean),
    ).toHaveLength(1)
    const third = await start('192.0.2.3')
    const reused = await submit('192.0.2.3', third.ticket, { invite: code, username: 'carol' })
    expect(reused.status).toBe(401)
    expect(reused.html).toContain('邀请码不对、已经用过或已经过期')
  })

  it('signs in once per sign-in page, though two sign-ups are posted for it at once', async () => {
    const one = invite()
    const two = invite()
    const { ticket } = await start('192.0.2.10')
    const answers = await Promise.all([
      submit('192.0.2.10', ticket, { invite: one, username: 'paul' }),
      submit('192.0.2.10', ticket, { invite: two, username: 'paula' }),
    ])
    expect(answers.map((answer) => answer.status).sort()).toEqual([302, 400])
    expect(answers.find((answer) => answer.status === 400)!.html).toContain('登录已过期')
    // The one that lost made no account and left its invite open.
    const made = [parts.store.findAccount('paul'), parts.store.findAccount('paula')]
    expect(made.filter(Boolean)).toHaveLength(1)
    expect([one, two].filter((code) => parts.store.openInvite(code))).toHaveLength(1)
  })

  it('refuses an invite past its time, and one revoked', async () => {
    const lapsing = invite(1)
    const revoked = invite()
    const id = parts.store.openInvite(revoked)!.id
    expect(runAdmin(parts.admin, { op: 'uninvite', id }).ok).toBe(true)
    expect(runAdmin(parts.admin, { op: 'uninvite', id }).ok).toBe(false)
    const { ticket } = await start('192.0.2.4')
    expect((await submit('192.0.2.4', ticket, { invite: revoked, username: 'dave' })).status).toBe(
      401,
    )
    clock += 25 * 60 * 60 * 1000
    const later = await start('192.0.2.4')
    expect(
      (await submit('192.0.2.4', later.ticket, { invite: lapsing, username: 'dave' })).status,
    ).toBe(401)
    expect(parts.store.findAccount('dave')).toBeNull()
  })

  it('checks the username and password without using the invite', async () => {
    const code = invite()
    const { ticket } = await start('192.0.2.5')
    const tries: [Record<string, string>, string][] = [
      [{ username: 'x' }, '用户名要 2 到 32 位'],
      [{ username: 'has space' }, '用户名要 2 到 32 位'],
      [{ username: 'owner' }, '已经有人用了'],
      [{ username: 'ALICE' }, '已经有人用了'],
      [{ username: 'erin', password: 'short' }, '密码至少 12 位'],
      [{ username: 'erin', password: 'eleven char' }, '密码至少 12 位'],
      [{ username: 'erin', password: 'x'.repeat(1025) }, '密码至少 12 位'],
      [{ username: 'erin', password2: 'something else entirely' }, '两次输入的密码不一样'],
    ]
    for (const [fields, error] of tries) {
      const answer = await submit('192.0.2.5', ticket, { invite: code, username: '', ...fields })
      expect(answer.html).toContain(error)
      expect(answer.status).toBe(400)
    }
    expect(parts.store.findAccount('erin')).toBeNull()
    expect(parts.store.openInvite(code)).not.toBeNull()
    // None of them counted against the address: the right form goes through.
    const done = await submit('192.0.2.5', ticket, {
      invite: code,
      username: 'erin',
      password: 'twelve chars',
    })
    expect(done.status).toBe(302)
    expect(parts.store.findAccount('erin')?.totp).toBeNull()
  })

  it('makes no account without a valid invite, whatever is posted', async () => {
    const before = parts.store.accounts().length
    const { ticket } = await start('192.0.2.7')
    for (const code of ['', 'AAAA-AAAA-AAAA-AAAA', 'not a code at all', 'x'.repeat(5000)]) {
      const answer = await submit('192.0.2.7', ticket, { invite: code, username: 'mallory' })
      expect(answer.status).toBe(401)
    }
    // The steps sign-up once had lead nowhere now.
    const fresh = await start('192.0.2.8')
    for (const action of ['enroll', 'code']) {
      const forged = await post('192.0.2.8', {
        ticket: fresh.ticket,
        action,
        enrollment: randomToken(18),
        step: randomToken(18),
        code: '123456',
      })
      expect(forged.status).not.toBe(302)
    }
    expect(parts.store.accounts()).toHaveLength(before)
  })

  it('refuses a sign-in or sign-up form posted from another site', async () => {
    const code = invite()
    const { ticket } = await start('192.0.2.9')
    const fields = {
      ticket,
      action: 'signup-submit',
      invite: code,
      username: 'oscar',
      password: PASSWORD,
      password2: PASSWORD,
    }
    const posted = (site: string) =>
      fetch(new URL('/signin/app/', base), {
        method: 'POST',
        body: new URLSearchParams(fields),
        redirect: 'manual',
        headers: { 'x-real-ip': '192.0.2.9', 'sec-fetch-site': site },
      })
    for (const site of ['cross-site', 'same-site']) expect((await posted(site)).status).toBe(403)
    expect(parts.store.findAccount('oscar')).toBeNull()
    const login = await fetch(new URL('/web/login', base), {
      method: 'POST',
      body: new URLSearchParams({ password: PASSWORD }),
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(login.status).toBe(403)
    const step = await fetch(new URL('/web/login', base), {
      method: 'POST',
      body: new URLSearchParams({ step: randomToken(18), code: '000000' }),
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(step.status).toBe(403)
    expect((await posted('same-origin')).status).toBe(302)
  })

  it('limits invite codes tried, by address and in all', async () => {
    clock += 2 * 60 * 60 * 1000
    const code = invite()
    const wrong = 'BBBB-BBBB-BBBB-BBBB'
    for (let i = 0; i < 5; i++) {
      const { ticket } = await start('198.51.100.1')
      expect(
        (await submit('198.51.100.1', ticket, { invite: wrong, username: 'gina' })).status,
      ).toBe(401)
    }
    const blocked = await start('198.51.100.1')
    const refused = await submit('198.51.100.1', blocked.ticket, { invite: code, username: 'gina' })
    expect(refused.status).toBe(429)
    expect(refused.html).toContain('尝试次数太多')
    expect(lines).toContain('huli-cloud: signup failed from 198.51.100.1')
    // Thirty in an hour from anywhere close sign-up to every address, the code's owner too.
    for (let a = 2; a <= 6; a++) {
      for (let i = 0; i < 5; i++) {
        const address = `198.51.100.${a}`
        const { ticket } = await start(address)
        await submit(address, ticket, { invite: wrong, username: 'gina' })
      }
    }
    const elsewhere = await start('203.0.113.9')
    const shut = await submit('203.0.113.9', elsewhere.ticket, { invite: code, username: 'gina' })
    expect(shut.status).toBe(429)
    // Sign-in is untouched by it.
    nextStep()
    const owner = await start('203.0.113.9', null)
    const signedIn = await signInSteps(
      (fields) => post('203.0.113.9', fields),
      { ticket: owner.ticket, action: 'allow', password: PASSWORD },
      totp(ownerSecret),
    )
    expect(signedIn.status).toBe(302)
    clock += 61 * 60 * 1000
    const reopened = await start('203.0.113.9')
    expect(
      (await submit('203.0.113.9', reopened.ticket, { invite: code, username: 'gina' })).status,
    ).toBe(302)
  })
})

describe('resetting an account', () => {
  it('signs it out at once, and its reset invite sets a new password for it alone', async () => {
    const code = invite()
    const { tokens, cookie: before } = await signUp('192.0.2.20', code, 'henry')
    const henry = parts.store.findAccount('henry')!
    // As a friend who bound two-step verification before sign-up stopped asking for it.
    const secret = newTotpSecret()
    parts.store.updateAccount(henry.id, {
      totp: secret,
      recovery: [sha256Hex('aaaaa-bbbbb')],
    })
    const asked = await start('192.0.2.20', null)
    const page = await post('192.0.2.20', {
      ticket: asked.ticket,
      action: 'allow',
      username: 'henry',
      password: PASSWORD,
    })
    expect(page.status).toBe(200)
    expect(stepOf(await page.text())).not.toBeNull()

    const reset = runAdmin(parts.admin, { op: 'reset', username: 'henry', days: 2 })
    if (!reset.ok) throw new Error(reset.error)
    expect(reset.answer.signedOut).toBeGreaterThanOrEqual(1)
    expect(parts.store.account(henry.id)).toMatchObject({
      password: null,
      totp: null,
      recovery: [],
    })
    const api = new AccountApi(base, fetch, now)
    await expect(api.me(tokens.accessToken)).rejects.toMatchObject({ status: 401 })
    await expect(api.refresh(DESKTOP_CLIENT, tokens.refreshToken)).rejects.toMatchObject({
      code: 'invalid_grant',
    })
    // The old password no longer signs in, and is answered as any wrong one.
    nextStep()
    const old = await start('192.0.2.20', null)
    const refused = await post('192.0.2.20', {
      ticket: old.ticket,
      action: 'allow',
      username: 'henry',
      password: PASSWORD,
    })
    expect(refused.status).toBe(401)
    expect(await refused.text()).toContain('用户名或密码不对')
    // The reset code makes no other account, and sets this one's password anew.
    const { ticket } = await start('192.0.2.21')
    const other = await submit('192.0.2.21', ticket, {
      invite: reset.answer.code!,
      username: 'ivan',
    })
    expect(other.html).toContain('这个邀请码用来重设账号「henry」')
    const again = await signUp('192.0.2.21', reset.answer.code!, 'henry', NEW_PASSWORD)
    const me = await api.me(again.tokens.accessToken)
    expect(me.account.id).toBe(henry.id)
    expect(lines).toContain('huli-cloud: reset account henry')
    // Without two-step verification now: the new password alone signs in.
    expect(parts.store.account(henry.id)).toMatchObject({ totp: null, recovery: [] })
    const later = await start('192.0.2.21', null)
    const signedIn = await post('192.0.2.21', {
      ticket: later.ticket,
      action: 'allow',
      username: 'henry',
      password: NEW_PASSWORD,
    })
    expect(signedIn.status).toBe(302)
    // A web session from before the reset does not come back with the account.
    const devices = (cookie: string) =>
      fetch(new URL('/account/devices/', base), { headers: { cookie } }).then((r) => r.text())
    expect(await devices(before)).toContain('登录后管理设备')
    expect(await devices(again.cookie)).toContain('账号 henry')
  })
})

describe('the owner’s page', () => {
  async function webLogin(address: string, fields: Record<string, string>, code: string) {
    nextStep()
    const answer = await signInSteps(
      (form) =>
        fetch(new URL('/web/login', base), {
          method: 'POST',
          body: new URLSearchParams(form),
          redirect: 'manual',
          headers: { 'x-real-ip': address },
        }),
      { next: '/account/admin/', ...fields },
      code,
    )
    expect(answer.status).toBe(302)
    expect(answer.headers.get('location')).toBe('/account/admin/')
    return answer.headers.get('set-cookie')!.split(';')[0]!
  }

  const page = (cookie: string) => fetch(new URL('/account/admin/', base), { headers: { cookie } })
  const send = (cookie: string, fields: Record<string, string>) =>
    fetch(new URL('/account/admin/', base), {
      method: 'POST',
      body: new URLSearchParams(fields),
      redirect: 'manual',
      headers: { cookie },
    })

  it('is the owner’s alone, and makes, shows once, and revokes invites', async () => {
    const { cookie: memberCookie } = await signUp('192.0.2.30', invite(), 'judy')
    const refused = await page(memberCookie)
    expect(refused.status).toBe(403)
    expect((await fetch(new URL('/account/admin/', base))).status).toBe(200)
    // A member's own web sign-in, with the password alone, reaches no further.
    const memberLogin = await webLogin('192.0.2.32', { username: 'judy', password: PASSWORD }, '')
    expect((await page(memberLogin)).status).toBe(403)

    const owner = await webLogin('192.0.2.31', { password: PASSWORD }, totp(ownerSecret))
    const html = await (await page(owner)).text()
    expect(html).toContain('<b>judy</b> · 正常 · 仅密码')
    expect(html).toContain('<b>owner</b> · 机主 · 两步验证')
    const csrf = field(html, 'csrf')!
    const opened = () => parts.store.invites().filter((i) => parts.store.inviteStatus(i) === 'open')
    const before = opened().length
    // Without the session's CSRF token nothing is made.
    expect((await send(owner, { csrf: 'forged', action: 'invite', days: '7' })).status).toBe(302)
    expect(opened()).toHaveLength(before)
    // A member's session makes nothing either.
    const memberHtml = await (
      await fetch(new URL('/account/devices/', base), { headers: { cookie: memberCookie } })
    ).text()
    const memberCsrf = field(memberHtml, 'csrf')!
    expect(
      (await send(memberCookie, { csrf: memberCsrf, action: 'invite', days: '7' })).status,
    ).toBe(403)
    expect(opened()).toHaveLength(before)

    const made = await (await send(owner, { csrf, action: 'invite', days: '3' })).text()
    const code = /<code>([A-Z2-9]{4}(?:-[A-Z2-9]{4}){3})<\/code>/.exec(made)![1]!
    expect(parts.store.openInvite(code)).not.toBeNull()
    // Listed by its id alone afterwards.
    expect(await (await page(owner)).text()).not.toContain(code)
    const id = parts.store.openInvite(code)!.id
    expect((await send(owner, { csrf, action: 'revoke', invite: id })).status).toBe(302)
    expect(parts.store.openInvite(code)).toBeNull()
    expect(await (await send(owner, { csrf, action: 'invite', days: '99' })).text()).toContain(
      '这个操作不对',
    )

    // Disabling from the page ends the member's web session too.
    expect((await send(owner, { csrf, action: 'disable', username: 'judy' })).status).toBe(302)
    expect(await (await page(memberCookie)).text()).toContain('机主登录后管理账号')
    expect((await send(owner, { csrf, action: 'disable', username: 'owner' })).status).toBe(400)
    expect((await send(owner, { csrf, action: 'enable', username: 'judy' })).status).toBe(302)
  })
})
