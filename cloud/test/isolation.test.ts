// Two accounts on one service: nothing of one reaches the other's computers, devices or phones,
// whether through the account API, the relay (hosts, devices, relay tokens) or the push gateway;
// disabling or removing an account cuts its sign-ins and live relay connections at once; and one
// account's failed sign-ins never lock the other out. Driven by the clients' own code over real
// sockets.

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AccountApi, DESKTOP_CLIENT, WEB_CLIENT } from '@shared/account-api'
import { HuliCloudApi, MOBILE_CLIENT, type HuliClientInfo } from '@shared/huli-cloud'
import { pushRequestHeaders } from '@shared/remote/push'
import vectors from '@shared/remote/push-vectors.json'
import {
  hostProfile,
  importRelayKey,
  newRelaySeed,
  parseRelayHosts,
  RELAY_CLOSE,
  relayHostId,
  type RelayKey,
} from '@shared/remote/relay'
import { dialRelay } from '@shared/remote/relay-device'
import { RelayHost } from '@shared/remote/relay-host'
import { generateKeyPair } from '@shared/remote/noise'
import { runAdmin } from '../src/admin'
import type { ApnsMessage, ApnsResult } from '../src/apns'
import {
  base32Decode,
  hashPassword,
  hotp,
  newTotpSecret,
  pkceChallenge,
  randomToken,
  TOTP_PERIOD_S,
} from '../src/secrets'
import { makeServer, type ServerParts } from '../src/server'
import type { Account } from '../src/store'
import { makeMember, makeOwner } from './accounts'

const PC: HuliClientInfo = { kind: 'desktop', name: 'PC', os: 'win32', arch: 'x64', version: '1' }
const PHONE: HuliClientInfo = {
  kind: 'mobile',
  name: 'iPhone',
  os: 'iOS',
  arch: 'arm64',
  version: '1',
}

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'huli-isolation-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

interface TestHost {
  id: string
  key: RelayKey
  host: RelayHost
}

describe('two accounts on one service', () => {
  let parts: ServerParts
  let base: string
  let cloud: HuliCloudApi
  let owner: Account
  let friend: Account
  const lines: string[] = []
  const hosts: RelayHost[] = []
  const sent: ApnsMessage[] = []
  let apnsAnswer: ApnsResult = { ok: true }

  beforeAll(async () => {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    parts = makeServer(
      { origin: base, dataDir: tempDir(), trustProxy: false },
      {
        topic: 'com.example.huli',
        send: async (message) => {
          sent.push(message)
          return apnsAnswer
        },
      },
      // No periodic check within a test: what is cut, the change itself cut.
      { log: (line) => lines.push(line), relayLimits: { tokenCheckMs: 10 * 60_000 } },
    )
    owner = makeOwner(parts.store)
    friend = makeMember(parts.store, 'friend')
    cloud = new HuliCloudApi(base, fetch)
    await new Promise<void>((resolve) => parts.server.listen(port, '127.0.0.1', resolve))
  })

  afterEach(() => {
    for (const host of hosts.splice(0)) host.stop()
  })

  afterAll(() => {
    parts.relay.close()
    parts.server.close()
  })

  const issue = (account: Account, client: string, info: HuliClientInfo | null = null) =>
    parts.store.issue(account.id, client, info)!.access_token
  const familyOf = (token: string) => parts.store.checkAccess(token)!.id

  async function startHost(token: string, key?: RelayKey): Promise<TestHost> {
    const relayKey = key ?? (await importRelayKey(await newRelaySeed()))
    const id = await relayHostId(relayKey.publicKey)
    const channel = await generateKeyPair()
    const host = new RelayHost({
      main: base,
      id,
      key: relayKey,
      openSocket: (url) => new WebSocket(url),
      fetchInfo: async (url) => (await fetch(url)).json(),
      accepted: () => {},
      profile: () => hostProfile(channel.publicKey, 'Studio', 'win32'),
      changed: () => {},
      log: () => {},
      timings: { retryMs: 50, maxRetryMs: 200, refusedMs: 200 },
    })
    host.setToken(token)
    host.start()
    hosts.push(host)
    return { id, key: relayKey, host }
  }

  const state = (t: TestHost) => () => t.host.status[0]?.connection.state
  const dial = (id: string, token: string) =>
    dialRelay({
      relays: [base],
      id,
      token,
      openSocket: (url) => new WebSocket(url),
      timeoutMs: 5000,
    })
  const relayList = async (token: string) => {
    const answer = await fetch(`${base}/v1/hosts`, {
      headers: { authorization: `Bearer ${token}` },
    })
    return parseRelayHosts(await answer.json())?.map((h) => h.id) ?? []
  }

  it('lists, and signs out, only the asker’s own account’s devices and computers', async () => {
    const ownerPc = await startHost(issue(owner, DESKTOP_CLIENT, PC))
    const friendPc = await startHost(issue(friend, DESKTOP_CLIENT, PC))
    await expect.poll(state(ownerPc)).toBe('connected')
    await expect.poll(state(friendPc)).toBe('connected')
    const ownerPhone = issue(owner, MOBILE_CLIENT, PHONE)
    const friendPhone = issue(friend, MOBILE_CLIENT, PHONE)
    const friendWeb = issue(friend, WEB_CLIENT)

    await expect
      .poll(async () => (await cloud.devices(ownerPhone)).computers.map((c) => c.id))
      .toEqual([ownerPc.id])
    expect((await cloud.devices(friendPhone)).computers.map((c) => c.id)).toEqual([friendPc.id])
    const ownerDevices = (await cloud.devices(ownerPhone)).devices.map((d) => d.id)
    for (const token of [friendPhone, friendWeb]) {
      expect(ownerDevices).not.toContain(familyOf(token))
    }
    await expect.poll(() => relayList(ownerPhone)).toEqual([ownerPc.id])
    await expect.poll(() => relayList(friendPhone)).toEqual([friendPc.id])

    // Another account's device is no device of this one, alone or among "every other".
    await expect(cloud.revoke(ownerPhone, { device: familyOf(friendWeb) })).rejects.toMatchObject({
      status: 404,
    })
    await cloud.revoke(ownerPhone, { others: true })
    expect(parts.store.checkAccess(friendWeb)).not.toBeNull()
    expect(parts.store.checkAccess(friendPhone)).not.toBeNull()
    await expect.poll(state(friendPc)).toBe('connected')

    const api = new AccountApi(base, fetch)
    expect((await api.me(friendPhone)).account).toMatchObject({ id: friend.id, email: 'friend' })
    const ownerAgain = issue(owner, MOBILE_CLIENT, PHONE)
    expect((await api.me(ownerAgain)).account).toMatchObject({ id: owner.id })
  })

  it('never joins a device to another account’s computer, by access or relay token', async () => {
    const ownerPc = await startHost(issue(owner, DESKTOP_CLIENT, PC))
    const friendPc = await startHost(issue(friend, DESKTOP_CLIENT, PC))
    await expect.poll(state(ownerPc)).toBe('connected')
    await expect.poll(state(friendPc)).toBe('connected')
    const api = new AccountApi(base, fetch)
    const ownerPhone = issue(owner, MOBILE_CLIENT, PHONE)
    const friendPhone = issue(friend, MOBILE_CLIENT, PHONE)
    const ownerRelay = (await api.relayToken(ownerPhone)).token
    const friendRelay = (await api.relayToken(friendPhone)).token
    for (const token of [ownerPhone, ownerRelay]) {
      expect((await dial(friendPc.id, token)).kind).toBe('forbidden')
    }
    for (const token of [friendPhone, friendRelay]) {
      expect((await dial(ownerPc.id, token)).kind).toBe('forbidden')
    }
    const joined = await dial(friendPc.id, friendRelay)
    expect(joined.kind).toBe('joined')
    if (joined.kind === 'joined') joined.socket.close()
  })

  it('refuses a host that renews with another account’s token', async () => {
    const ownerPc = await startHost(issue(owner, DESKTOP_CLIENT, PC))
    await expect.poll(state(ownerPc)).toBe('connected')
    ownerPc.host.setToken(issue(friend, DESKTOP_CLIENT, PC))
    await expect.poll(state(ownerPc), { timeout: 3000 }).not.toBe('connected')
    expect(lines.join('\n')).toContain('renewed with a token refused')
  })

  it('moves a computer to another account only with its own key, and then off the first', async () => {
    const ownerPhone = issue(owner, MOBILE_CLIENT, PHONE)
    const first = await startHost(issue(owner, DESKTOP_CLIENT, PC))
    await expect.poll(state(first)).toBe('connected')
    first.host.stop()
    // The same computer, its own key and all, signed in to the other account now.
    const moved = await startHost(issue(friend, DESKTOP_CLIENT, PC), first.key)
    await expect.poll(state(moved)).toBe('connected')
    expect(parts.store.computer(moved.id)?.account).toBe(friend.id)
    expect((await cloud.devices(ownerPhone)).computers.map((c) => c.id)).not.toContain(moved.id)
    expect((await dial(moved.id, ownerPhone)).kind).toBe('forbidden')
  })

  describe('push', () => {
    const TOKEN_A = 'a1'.repeat(32)
    const TOKEN_B = 'b2'.repeat(32)

    async function push(access: string, key: RelayKey, token: string) {
      const id = await relayHostId(key.publicKey)
      const body = JSON.stringify({
        time: Date.now(),
        token,
        environment: 'sandbox',
        push: { type: 'alert', sealed: vectors.sealed[0]!.envelope, collapse: randomToken(8) },
      })
      const headers = await pushRequestHeaders(key, base, id, body, access)
      return fetch(`${base}/v1/push`, { method: 'POST', headers, body })
    }

    it('reaches a phone from the account that first reached it, and from no other', async () => {
      const ownerKey = await importRelayKey(await newRelaySeed())
      const friendKey = await importRelayKey(await newRelaySeed())
      const ownerPc = issue(owner, DESKTOP_CLIENT, PC)
      const friendPc = issue(friend, DESKTOP_CLIENT, PC)
      expect((await push(ownerPc, ownerKey, TOKEN_A)).status).toBe(200)
      const before = sent.length
      const refused = await push(friendPc, friendKey, TOKEN_A)
      expect(refused.status).toBe(401)
      expect(await refused.json()).toEqual({ error: 'unauthorized' })
      // Apple never heard of it.
      expect(sent.length).toBe(before)
      expect(lines).toContain("huli-cloud: a push to another account's device was refused")

      expect((await push(friendPc, friendKey, TOKEN_B)).status).toBe(200)
      expect((await push(ownerPc, ownerKey, TOKEN_B)).status).toBe(401)
      expect((await push(ownerPc, ownerKey, TOKEN_A)).status).toBe(200)
    })

    it('frees a target Apple no longer takes', async () => {
      const ownerKey = await importRelayKey(await newRelaySeed())
      const friendKey = await importRelayKey(await newRelaySeed())
      const token = 'c3'.repeat(32)
      const ownerPc = issue(owner, DESKTOP_CLIENT, PC)
      expect((await push(ownerPc, ownerKey, token)).status).toBe(200)
      apnsAnswer = { ok: false, status: 410, reason: 'Unregistered', gone: true }
      expect((await push(ownerPc, ownerKey, token)).status).toBe(410)
      apnsAnswer = { ok: true }
      // A reinstall's token that happened to come back is nobody's now.
      expect((await push(issue(friend, DESKTOP_CLIENT, PC), friendKey, token)).status).toBe(200)
    })

    it('keeps no phone of a removed account: its targets are anybody’s again', async () => {
      const gone = makeMember(parts.store, 'leaving')
      const key = await importRelayKey(await newRelaySeed())
      const token = 'd4'.repeat(32)
      expect((await push(issue(gone, DESKTOP_CLIENT, PC), key, token)).status).toBe(200)
      expect(parts.store.pushAccount(`sandbox:${token}`)).toBe(gone.id)
      expect(runAdmin(parts.admin, { op: 'remove', username: 'leaving' }).ok).toBe(true)
      expect(parts.store.pushAccount(`sandbox:${token}`)).toBeNull()
    })
  })

  it('cuts a disabled account off at once, relay connections and all, and lets it back on', async () => {
    const other = makeMember(parts.store, 'other')
    const otherPc = await startHost(issue(other, DESKTOP_CLIENT, PC))
    const ownerPc = await startHost(issue(owner, DESKTOP_CLIENT, PC))
    await expect.poll(state(otherPc)).toBe('connected')
    await expect.poll(state(ownerPc)).toBe('connected')
    const phone = parts.store.issue(other.id, MOBILE_CLIENT, PHONE)!
    const joined = await dial(otherPc.id, phone.access_token)
    if (joined.kind !== 'joined') throw new Error(joined.kind)
    const closed = new Promise<number>((resolve) =>
      joined.socket.addEventListener('close', (event) => resolve(event.code), { once: true }),
    )

    expect(runAdmin(parts.admin, { op: 'disable', username: 'other' }).ok).toBe(true)
    // Checked as the change is made, not at the next minute's check.
    expect(await closed).toBe(RELAY_CLOSE.unauthorized)
    await expect.poll(state(otherPc), { timeout: 1000 }).toBe('refused')
    expect(state(ownerPc)()).toBe('connected')
    const api = new AccountApi(base, fetch)
    await expect(api.me(phone.access_token)).rejects.toMatchObject({ status: 401 })
    await expect(api.relayToken(phone.access_token)).rejects.toMatchObject({ status: 401 })
    expect(parts.store.refresh(MOBILE_CLIENT, phone.refresh_token)).toEqual({
      ok: false,
      reason: 'unknown',
    })
    expect(await relayList(phone.access_token)).toEqual([])
    expect(parts.store.issue(other.id, MOBILE_CLIENT, PHONE)).toBeNull()
    // The owner is never disabled.
    expect(runAdmin(parts.admin, { op: 'disable', username: 'owner' })).toMatchObject({ ok: false })

    expect(runAdmin(parts.admin, { op: 'enable', username: 'other' }).ok).toBe(true)
    expect((await api.me(phone.access_token)).account.id).toBe(other.id)
  })

  it('removes an account with everything of it, its live relay connections too', async () => {
    const gone = makeMember(parts.store, 'gone')
    const pc = await startHost(issue(gone, DESKTOP_CLIENT, PC))
    await expect.poll(state(pc)).toBe('connected')
    const phone = issue(gone, MOBILE_CLIENT, PHONE)
    const joined = await dial(pc.id, phone)
    if (joined.kind !== 'joined') throw new Error(joined.kind)
    const closed = new Promise<number>((resolve) =>
      joined.socket.addEventListener('close', (event) => resolve(event.code), { once: true }),
    )
    const reset = runAdmin(parts.admin, { op: 'reset', username: 'gone', days: 1 })
    expect(reset.ok).toBe(true)
    expect(await closed).toBe(RELAY_CLOSE.unauthorized)
    await expect.poll(state(pc), { timeout: 1000 }).toBe('refused')
    expect(runAdmin(parts.admin, { op: 'remove', username: 'gone' })).toMatchObject({ ok: true })
    expect(parts.store.account(gone.id)).toBeNull()
    expect(parts.store.families(gone.id)).toEqual([])
    expect(parts.store.computer(pc.id)).toBeNull()
    // Its reset invite went with it.
    const listed = runAdmin(parts.admin, { op: 'list' })
    expect(listed.ok && listed.answer.invites?.some((i) => i.resets === 'gone')).toBe(false)
    expect(runAdmin(parts.admin, { op: 'remove', username: 'owner' })).toMatchObject({ ok: false })
  })
})

describe('room of its own on the relay for each account', () => {
  let parts: ServerParts
  let base: string
  const hosts: RelayHost[] = []

  beforeAll(async () => {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    parts = makeServer({ origin: base, dataDir: tempDir(), trustProxy: false }, null, {
      log: () => {},
      relayLimits: { maxHostsPerAccount: 2, maxSocketsPerAccount: 3 },
    })
    await new Promise<void>((resolve) => parts.server.listen(port, '127.0.0.1', resolve))
  })

  afterAll(() => {
    for (const host of hosts) host.stop()
    parts.relay.close()
    parts.server.close()
  })

  async function startHost(token: string) {
    const key = await importRelayKey(await newRelaySeed())
    const id = await relayHostId(key.publicKey)
    const host = new RelayHost({
      main: base,
      id,
      key,
      openSocket: (url) => new WebSocket(url),
      fetchInfo: async (url) => (await fetch(url)).json(),
      accepted: () => {},
      profile: () => null,
      changed: () => {},
      log: () => {},
      timings: { retryMs: 50, maxRetryMs: 200, refusedMs: 5000 },
    })
    host.setToken(token)
    host.start()
    hosts.push(host)
    return { id, state: () => host.status[0]?.connection.state }
  }

  it('lets one account fill only its own share of hosts and sockets', async () => {
    const owner = makeOwner(parts.store)
    const friend = makeMember(parts.store, 'friend')
    const issue = (account: Account, client: string) =>
      parts.store.issue(account.id, client, null)!.access_token
    const friendHosts = [
      await startHost(issue(friend, DESKTOP_CLIENT)),
      await startHost(issue(friend, DESKTOP_CLIENT)),
    ]
    for (const h of friendHosts) await expect.poll(h.state).toBe('connected')
    const third = await startHost(issue(friend, DESKTOP_CLIENT))
    await expect.poll(third.state).toBe('refused')
    // Two hosts and a device fill the friend's three sockets: the accept the device waits for
    // has no room, and the device is refused.
    const dial = (id: string, token: string) =>
      dialRelay({ relays: [base], id, token, openSocket: (u) => new WebSocket(u), timeoutMs: 5000 })
    const first = await dial(friendHosts[0]!.id, issue(friend, MOBILE_CLIENT))
    expect(first).toEqual({ kind: 'refused', reason: 'too_many' })
    // The owner's computer and phone still have all of their room.
    const ownerHost = await startHost(issue(owner, DESKTOP_CLIENT))
    await expect.poll(ownerHost.state).toBe('connected')
    expect(parts.relay.accountSockets(friend.id)).toBe(2)
    expect(parts.relay.accountSockets(owner.id)).toBe(1)
  })
})

describe('sign-in failures by account', () => {
  let parts: ServerParts
  let base: string
  let clock = Date.UTC(2026, 10, 19, 12, 0, 0)
  const now = () => clock
  const PASSWORD = 'correct horse battery staple'
  const ownerSecret = newTotpSecret()
  const friendSecret = newTotpSecret()
  const lines: string[] = []

  beforeAll(async () => {
    parts = makeServer({ origin: 'http://127.0.0.1', dataDir: tempDir(), trustProxy: true }, null, {
      now,
      log: (line) => lines.push(line),
    })
    const password = await hashPassword(PASSWORD)
    makeOwner(parts.store, { password, totp: ownerSecret, totpLastStep: -1, recovery: [] })
    makeMember(parts.store, 'friend', {
      password,
      totp: friendSecret,
      totpLastStep: -1,
      recovery: [],
    })
    await new Promise<void>((resolve) => parts.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(parts.server.address() as AddressInfo).port}`
  })

  afterAll(() => parts.server.close())

  const code = (secret: string) =>
    hotp(base32Decode(secret), Math.floor(clock / 1000 / TOTP_PERIOD_S))

  async function ticketFrom(address: string): Promise<string> {
    const url = new URL('/signin/app/', base)
    url.search = new URLSearchParams({
      client_id: 'kettu-desktop',
      redirect_uri: 'http://127.0.0.1:5555/callback',
      code_challenge: pkceChallenge(randomToken(48)),
      code_challenge_method: 'S256',
      state: 's',
    }).toString()
    const html = await (await fetch(url, { headers: { 'x-real-ip': address } })).text()
    return /name="ticket" value="([^"]+)"/.exec(html)![1]!
  }

  async function signIn(address: string, fields: Record<string, string>) {
    return fetch(new URL('/signin/app/', base), {
      method: 'POST',
      body: new URLSearchParams({ ticket: await ticketFrom(address), action: 'allow', ...fields }),
      redirect: 'manual',
      headers: { 'x-real-ip': address },
    })
  }

  it('locks one account out of an address, never the other', async () => {
    const shared = '198.51.100.7'
    for (let i = 0; i < 5; i++) {
      const answer = await signIn(shared, { username: 'friend', password: 'wrong', code: '000000' })
      expect(answer.status).toBe(401)
    }
    clock += TOTP_PERIOD_S * 1000
    const friend = await signIn(shared, {
      username: 'friend',
      password: PASSWORD,
      code: code(friendSecret),
    })
    expect(friend.status).toBe(401)
    expect(await friend.text()).toContain('尝试次数太多')
    // The owner, from the very same address, and with the username left out or given.
    expect((await signIn(shared, { password: PASSWORD, code: code(ownerSecret) })).status).toBe(302)
    clock += TOTP_PERIOD_S * 1000
    const named = await signIn(shared, {
      username: 'OWNER',
      password: PASSWORD,
      code: code(ownerSecret),
    })
    expect(named.status).toBe(302)
    // And the friend from elsewhere.
    expect(
      (
        await signIn('198.51.100.8', {
          username: 'friend',
          password: PASSWORD,
          code: code(friendSecret),
        })
      ).status,
    ).toBe(302)
  })

  it('locks the owner out of an address and leaves the friend in, the other way round', async () => {
    clock += 16 * 60 * 1000
    const shared = '198.51.100.9'
    for (let i = 0; i < 5; i++) {
      await signIn(shared, { password: 'wrong', code: '000000' })
    }
    clock += TOTP_PERIOD_S * 1000
    expect((await signIn(shared, { password: PASSWORD, code: code(ownerSecret) })).status).toBe(401)
    const friend = await signIn(shared, {
      username: 'friend',
      password: PASSWORD,
      code: code(friendSecret),
    })
    expect(friend.status).toBe(302)
  })

  it('caps what one address tries across usernames, ten failures in all', async () => {
    clock += 16 * 60 * 1000
    const sprayer = '203.0.113.50'
    for (let i = 0; i < 7; i++) {
      await signIn(sprayer, { username: `nobody${i}`, password: 'x'.repeat(1025), code: '000000' })
    }
    for (let i = 0; i < 5; i++) {
      await signIn(sprayer, { username: 'friend', password: 'wrong', code: '000000' })
    }
    // Five for the usernames nobody has, five for the friend: the address is spent, the owner
    // included; the owner from anywhere else is not.
    clock += TOTP_PERIOD_S * 1000
    const blocked = await signIn(sprayer, { password: PASSWORD, code: code(ownerSecret) })
    expect(blocked.status).toBe(401)
    expect(await blocked.text()).toContain('尝试次数太多')
    expect(
      (await signIn('203.0.113.51', { password: PASSWORD, code: code(ownerSecret) })).status,
    ).toBe(302)
    // Every failure checked is the line fail2ban counts, whichever username it named.
    expect(lines.filter((l) => l === `huli-cloud: login failed from ${sprayer}`)).toHaveLength(10)
  })

  it('refuses a disabled account’s right password with its own answer, and no lockout', async () => {
    clock += 16 * 60 * 1000
    expect(runAdmin(parts.admin, { op: 'disable', username: 'friend' }).ok).toBe(true)
    const refused = await signIn('198.51.100.20', {
      username: 'friend',
      password: PASSWORD,
      code: code(friendSecret),
    })
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain('已停用')
    const wrong = await signIn('198.51.100.20', {
      username: 'friend',
      password: 'wrong',
      code: '000000',
    })
    expect(await wrong.text()).toContain('用户名、密码或验证码不对')
    expect(runAdmin(parts.admin, { op: 'enable', username: 'friend' }).ok).toBe(true)
  })
})
