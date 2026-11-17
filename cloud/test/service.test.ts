// The service end to end, driven by Kettu's own client code (AccountApi, pushRequestHeaders), so
// a change on either side that breaks the other fails here.

import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AccountApi, AccountServiceError, type ClientInfo } from '@shared/account-api'
import { pushRequestHeaders, pushRequestText } from '@shared/remote/push'
import vectors from '@shared/remote/push-vectors.json'
import {
  decodeRelayBytes,
  importRelayKey,
  relayHostId,
  verifyRelaySignature,
} from '@shared/remote/relay'
import type { ApnsMessage, ApnsResult } from '../src/apns'
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

const ORIGIN = 'http://127.0.0.1'
const PASSWORD = 'correct horse battery staple'
const INFO: ClientInfo = {
  kind: 'desktop',
  name: 'Test PC',
  os: 'win32',
  arch: 'x64',
  version: '0.1.0',
}

let clock = Date.UTC(2026, 10, 17, 12, 0, 0)
const now = () => clock
/** Moves to the next TOTP step, since each code works once. */
const nextStep = () => (clock += TOTP_PERIOD_S * 1000)

let parts: ServerParts
let base: string
let api: AccountApi
let dir: string
let secret: string
const lines: string[] = []
const sent: ApnsMessage[] = []
let apnsAnswer: ApnsResult = { ok: true }

const code = () => hotp(base32Decode(secret), Math.floor(clock / 1000 / TOTP_PERIOD_S))

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'huli-cloud-'))
  parts = makeServer(
    { origin: ORIGIN, dataDir: dir, trustProxy: false },
    {
      topic: 'com.example.huli',
      send: async (message) => {
        sent.push(message)
        return apnsAnswer
      },
    },
    { now, log: (line) => lines.push(line) },
  )
  secret = newTotpSecret()
  parts.store.setAccount({
    id: 'acct-1',
    email: 'me@example.com',
    name: 'Me',
    password: await hashPassword(PASSWORD),
    totp: secret,
    totpLastStep: -1,
    recovery: [sha256Hex('aaaaa-bbbbb')],
  })
  await new Promise<void>((resolve) => parts.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(parts.server.address() as AddressInfo).port}`
  api = new AccountApi(base, fetch, now)
})

afterAll(() => {
  parts.server.close()
  rmSync(dir, { recursive: true, force: true })
})

const REDIRECT = 'http://127.0.0.1:5555/callback'

async function startSignIn(verifier: string, redirectUri = REDIRECT) {
  const url = new URL('/signin/app/', base)
  url.search = new URLSearchParams({
    client_id: 'kettu-desktop',
    redirect_uri: redirectUri,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    state: 'state-1',
    client_info: JSON.stringify(INFO),
  }).toString()
  const response = await fetch(url)
  const html = await response.text()
  return { response, ticket: /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? null, html }
}

async function post(pathname: string, fields: Record<string, string>, cookie?: string) {
  return fetch(new URL(pathname, base), {
    method: 'POST',
    body: new URLSearchParams(fields),
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  })
}

async function signIn(): Promise<{ access: string; refresh: string; cookie: string }> {
  nextStep()
  const verifier = randomToken(48)
  const { ticket } = await startSignIn(verifier)
  const answer = await post('/signin/app/', {
    ticket: ticket!,
    password: PASSWORD,
    code: code(),
    action: 'allow',
  })
  expect(answer.status).toBe(302)
  const location = new URL(answer.headers.get('location')!)
  expect(location.origin + location.pathname).toBe(REDIRECT)
  expect(location.searchParams.get('state')).toBe('state-1')
  const tokens = await api.exchangeCode({
    code: location.searchParams.get('code')!,
    redirectUri: REDIRECT,
    verifier,
  })
  return {
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    cookie: answer.headers.get('set-cookie')!.split(';')[0]!,
  }
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AccountServiceError) return error.code
    throw error
  }
  throw new Error('It did not fail')
}

describe('browser sign-in', () => {
  it('signs a desktop client in and answers /me', async () => {
    const { access } = await signIn()
    const me = await api.me(access)
    expect(me.account).toEqual({
      id: 'acct-1',
      email: 'me@example.com',
      name: 'Me',
      avatarUrl: null,
    })
    expect(me.subscription).toBe('active')
  })

  it('refuses a code twice, a wrong verifier and a wrong redirect', async () => {
    nextStep()
    const verifier = randomToken(48)
    const { ticket } = await startSignIn(verifier)
    const answer = await post('/signin/app/', {
      ticket: ticket!,
      password: PASSWORD,
      code: code(),
      action: 'allow',
    })
    const issued = new URL(answer.headers.get('location')!).searchParams.get('code')!
    expect(
      await failure(
        api.exchangeCode({ code: issued, redirectUri: REDIRECT, verifier: randomToken(48) }),
      ),
    ).toBe('invalid_grant')
    // The failed try spent it.
    expect(await failure(api.exchangeCode({ code: issued, redirectUri: REDIRECT, verifier }))).toBe(
      'invalid_grant',
    )
  })

  it('serves the pages under a language prefix, as the desktop app opens them', async () => {
    const verifier = randomToken(48)
    const url = new URL('/zh-CN/signin/app/', base)
    url.search = new URLSearchParams({
      client_id: 'kettu-desktop',
      redirect_uri: REDIRECT,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state: 's',
    }).toString()
    const answer = await fetch(url)
    expect(answer.status).toBe(200)
    expect(await answer.text()).toContain('name="ticket"')
    expect((await fetch(new URL('/zh-CN/signin/app/?done=1', base))).status).toBe(200)
    expect((await fetch(new URL('/zh-CN/account/devices/', base))).status).toBe(200)
  })

  it('refuses a redirect that is not loopback', async () => {
    const { response, ticket } = await startSignIn(randomToken(48), 'https://evil.example/callback')
    expect(response.status).toBe(400)
    expect(ticket).toBeNull()
  })

  it('sends the user back with access_denied on Cancel', async () => {
    const { ticket } = await startSignIn(randomToken(48))
    const answer = await post('/signin/app/', { ticket: ticket!, action: 'deny' })
    const location = new URL(answer.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('access_denied')
  })

  it('asks a signed-in browser only to allow', async () => {
    const { cookie } = await signIn()
    const verifier = randomToken(48)
    const url = new URL('/signin/app/', base)
    url.search = new URLSearchParams({
      client_id: 'kettu-desktop',
      redirect_uri: REDIRECT,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state: 's',
    }).toString()
    const html = await (await fetch(url, { headers: { cookie } })).text()
    expect(html).toContain('允许这台设备登录')
    const ticket = /name="ticket" value="([^"]+)"/.exec(html)![1]!
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!
    const forged = await post('/signin/app/', { ticket, csrf: 'wrong', action: 'allow' }, cookie)
    expect(forged.status).toBe(403)
    const allowed = await post('/signin/app/', { ticket, csrf, action: 'allow' }, cookie)
    expect(allowed.status).toBe(302)
    expect(new URL(allowed.headers.get('location')!).searchParams.get('code')).toBeTruthy()
  })

  it('takes a recovery code once', async () => {
    nextStep()
    const first = await startSignIn(randomToken(48))
    const ok = await post('/signin/app/', {
      ticket: first.ticket!,
      password: PASSWORD,
      code: 'AAAAA-BBBBB',
      action: 'allow',
    })
    expect(ok.status).toBe(302)
    const second = await startSignIn(randomToken(48))
    const again = await post('/signin/app/', {
      ticket: second.ticket!,
      password: PASSWORD,
      code: 'aaaaa-bbbbb',
      action: 'allow',
    })
    expect(again.status).toBe(401)
  })
})

describe('tokens', () => {
  it('rotates refresh tokens and revokes the family when an old one comes back', async () => {
    const { access, refresh } = await signIn()
    const next = await api.refresh('kettu-desktop', refresh)
    expect(await failure(api.me(access))).toBe('unauthorized')
    await api.me(next.accessToken)
    expect(await failure(api.refresh('kettu-desktop', refresh))).toBe('invalid_grant')
    // The replay signed the whole family out, the newer tokens too.
    expect(await failure(api.me(next.accessToken))).toBe('unauthorized')
    expect(await failure(api.refresh('kettu-desktop', next.refreshToken))).toBe('invalid_grant')
  })

  it('refuses another client id', async () => {
    const { refresh } = await signIn()
    expect(await failure(api.refresh('kettu-daemon', refresh))).toBe('invalid_grant')
  })

  it('signs out on revoke', async () => {
    const { access, refresh } = await signIn()
    await api.revoke('kettu-desktop', refresh)
    expect(await failure(api.me(access))).toBe('unauthorized')
  })
})

describe('device codes', () => {
  it('waits for approval in the browser, then signs the daemon in', async () => {
    const { cookie } = await signIn()
    const device = await api.startDevice({ ...INFO, kind: 'daemon' })
    expect(device.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
    expect(await failure(api.pollDevice(device.deviceCode))).toBe('authorization_pending')
    expect(await failure(api.pollDevice(device.deviceCode))).toBe('slow_down')

    const page = await (
      await fetch(new URL(`/device?code=${device.userCode}`, base), { headers: { cookie } })
    ).text()
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!
    const approved = await post(
      '/device',
      { csrf, user_code: device.userCode, action: 'allow' },
      cookie,
    )
    expect(approved.status).toBe(200)

    clock += 60_000
    const tokens = await api.pollDevice(device.deviceCode)
    await api.me(tokens.accessToken)
    clock += 60_000
    expect(await failure(api.pollDevice(device.deviceCode))).toBe('expired_token')
  })
})

describe('brute force', () => {
  it('blocks an address after five failures, even with the right password', async () => {
    for (let i = 0; i < 5; i++) {
      const { ticket } = await startSignIn(randomToken(48))
      const answer = await post('/signin/app/', {
        ticket: ticket!,
        password: 'wrong password',
        code: '000000',
        action: 'allow',
      })
      expect(answer.status).toBe(401)
    }
    nextStep()
    const { ticket } = await startSignIn(randomToken(48))
    const blocked = await post('/signin/app/', {
      ticket: ticket!,
      password: PASSWORD,
      code: code(),
      action: 'allow',
    })
    expect(blocked.status).toBe(401)
    expect(await blocked.text()).toContain('尝试次数太多')
    expect(lines.filter((l) => l.includes('login failed from')).length).toBeGreaterThanOrEqual(5)
    // The window passes.
    clock += 16 * 60 * 1000
  })
})

describe('push gateway', () => {
  const TOKEN = 'a1'.repeat(32)

  it('agrees with the shared vectors on what a host signs', async () => {
    const { request, keys } = vectors
    const text = new TextDecoder().decode(pushRequestText(request.origin, request.id, request.body))
    expect(text).toBe(request.text)
    expect(await relayHostId(decodeRelayBytes(keys.hostPublicKey)!)).toBe(keys.hostId)
    expect(
      await verifyRelaySignature(
        decodeRelayBytes(keys.hostPublicKey)!,
        decodeRelayBytes(request.signature)!,
        pushRequestText(request.origin, request.id, request.body),
      ),
    ).toBe(true)
  })

  async function push(access: string | null, body: string, origin = ORIGIN) {
    const key = await importRelayKey(decodeRelayBytes(vectors.keys.hostSeed)!)
    const id = await relayHostId(key.publicKey)
    const headers = await pushRequestHeaders(key, origin, id, body, access ?? 'x'.repeat(43))
    if (!access) delete (headers as Record<string, string>).Authorization
    return fetch(new URL('/v1/push', base), { method: 'POST', headers, body })
  }

  const alert = () =>
    JSON.stringify({
      time: clock,
      token: TOKEN,
      environment: 'sandbox',
      push: { type: 'alert', sealed: vectors.sealed[0]!.envelope, collapse: 'tag-1' },
    })

  it('hands a signed push to APNs once', async () => {
    const { access } = await signIn()
    const body = alert()
    const answer = await push(access, body)
    expect(answer.status).toBe(200)
    const message = sent.at(-1)!
    expect(message.token).toBe(TOKEN)
    expect(message.environment).toBe('sandbox')
    expect(message.headers['apns-push-type']).toBe('alert')
    expect(message.headers['apns-collapse-id']).toBe('tag-1')
    expect(message.headers['apns-topic']).toBe('com.example.huli')
    expect(message.payload).toMatchObject({
      aps: { 'mutable-content': 1 },
      sealed: vectors.sealed[0]!.envelope,
    })
    expect((await push(access, body)).status).toBe(401)
  })

  it('refuses a signature for another gateway, an old request and no account', async () => {
    const { access } = await signIn()
    expect((await push(access, alert(), 'https://push.kettu.sh')).status).toBe(401)
    const old = JSON.parse(alert()) as { time: number }
    old.time -= 10 * 60 * 1000
    expect((await push(access, JSON.stringify(old))).status).toBe(401)
    expect((await push(null, alert())).status).toBe(403)
    expect((await push('not-a-real-token-but-long-enough-to-parse', alert())).status).toBe(403)
  })

  it('says unregistered when Apple no longer takes the token', async () => {
    const { access } = await signIn()
    apnsAnswer = { ok: false, status: 410, reason: 'Unregistered', gone: true }
    const answer = await push(access, alert())
    apnsAnswer = { ok: true }
    expect(answer.status).toBe(410)
    expect(await answer.json()).toEqual({ error: 'unregistered' })
  })

  it('times a Live Activity as the host asks, urgent unless it says it may wait', async () => {
    const { access } = await signIn()
    const sealed = vectors.sealed[0]!.envelope
    const activity = (fields: Record<string, unknown>) =>
      JSON.stringify({
        time: clock,
        token: TOKEN,
        environment: 'sandbox',
        push: { type: 'liveactivity', sealed, ...fields },
      })
    const at = Math.floor(clock / 1000)
    expect((await push(access, activity({ event: 'update', stale: 1800, low: true }))).status).toBe(
      200,
    )
    expect(sent.at(-1)!.headers['apns-priority']).toBe('5')
    expect(sent.at(-1)!.payload).toEqual({
      aps: { timestamp: at, event: 'update', 'content-state': { sealed }, 'stale-date': at + 1800 },
    })
    expect((await push(access, activity({ event: 'update' }))).status).toBe(200)
    expect(sent.at(-1)!.headers['apns-priority']).toBe('10')
    expect(sent.at(-1)!.payload).not.toHaveProperty('aps.stale-date')
    expect((await push(access, activity({ event: 'end', dismiss: 900, low: true }))).status).toBe(
      200,
    )
    expect(sent.at(-1)!.headers['apns-priority']).toBe('10')
    expect(sent.at(-1)!.payload).toMatchObject({
      aps: { event: 'end', 'dismissal-date': at + 900 },
    })
    expect((await push(access, activity({ event: 'end' }))).status).toBe(200)
    expect(sent.at(-1)!.payload).toMatchObject({ aps: { 'dismissal-date': at } })
    expect((await push(access, activity({ event: 'update', stale: -1 }))).status).toBe(400)
    expect((await push(access, activity({ event: 'end', dismiss: 5 * 60 * 60 }))).status).toBe(400)
    expect((await push(access, activity({ event: 'update', low: false }))).status).toBe(400)
  })
})
