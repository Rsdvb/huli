// The account's computers and devices: the registry in the store, which sign-ins may register a
// computer, the account API that lists and signs out, and the relay's authorization tied to the
// registry; tokens of an account that was replaced reach nothing. Driven by the clients' own code
// (RelayHost, dialRelay, HuliCloudApi) over real sockets.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountApi, DAEMON_CLIENT, DESKTOP_CLIENT, WEB_CLIENT } from '@shared/account-api'
import {
  ACCOUNT_DEVICES_PATH,
  HuliCloudApi,
  MOBILE_CLIENT,
  parseAccountDevices,
  type HuliClientInfo,
} from '@shared/huli-cloud'
import { generateKeyPair } from '@shared/remote/noise'
import {
  encodeRelayBytes,
  hostProfile,
  importRelayKey,
  newRelaySeed,
  parseRelayHosts,
  relayHostId,
  type RelayHostProfile,
} from '@shared/remote/relay'
import { dialRelay } from '@shared/remote/relay-device'
import { RelayHost } from '@shared/remote/relay-host'
import { makeServer, type ServerParts } from '../src/server'
import { MAX_COMPUTERS, Store, type Account } from '../src/store'

const ACCOUNT: Account = {
  id: 'acct-1',
  email: 'me@example.com',
  name: 'Me',
  password: 'unused',
  totp: 'unused',
  totpLastStep: -1,
  recovery: [],
}
const PHONE: HuliClientInfo = {
  kind: 'mobile',
  name: 'iPhone',
  os: 'iOS 26',
  arch: 'arm64',
  version: '0.1.0',
}
const PC: HuliClientInfo = {
  kind: 'desktop',
  name: 'Studio',
  os: 'win32',
  arch: 'x64',
  version: '1',
}
const SIGN_KEY = encodeRelayBytes(new Uint8Array(32).fill(7))

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'huli-account-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('the registry in the store', () => {
  let clock = 1_000_000
  const now = () => clock
  let store: Store
  let dir: string

  beforeEach(() => {
    dir = tempDir()
    store = new Store(dir, now)
    store.setAccount(ACCOUNT)
  })

  const familyOf = (token: string) => store.checkAccess(token)!.id

  it('registers a computer only under a live sign-in of the account, and keeps it on disk', () => {
    expect(store.registerComputer('a'.repeat(26), 'no-such-family', SIGN_KEY)).toBeNull()
    const family = familyOf(store.issue(DESKTOP_CLIENT, PC).access_token)
    const id = 'b'.repeat(26)
    expect(store.registerComputer(id, family, SIGN_KEY)).toMatchObject({
      id,
      account: ACCOUNT.id,
      family,
      signKey: SIGN_KEY,
      key: null,
      pairable: false,
    })
    const key = encodeRelayBytes(new Uint8Array(32).fill(1))
    store.setComputerProfile(id, { key, name: 'Studio', platform: 'win32', pairable: true })
    const again = new Store(dir, now)
    expect(again.computers()).toEqual([
      expect.objectContaining({ id, key, name: 'Studio', platform: 'win32', pairable: true }),
    ])
  })

  it('starts a computer over when the same id comes with another key', () => {
    const family = familyOf(store.issue(DESKTOP_CLIENT, PC).access_token)
    const id = 'c'.repeat(26)
    store.registerComputer(id, family, SIGN_KEY)
    const key = encodeRelayBytes(new Uint8Array(32).fill(1))
    store.setComputerProfile(id, { key, name: 'Studio', platform: 'win32', pairable: true })
    const other = encodeRelayBytes(new Uint8Array(32).fill(9))
    expect(store.registerComputer(id, family, other)).toMatchObject({ signKey: other, key: null })
  })

  it('drops a computer with its sign-in, and when its sign-in lapses', () => {
    const token = store.issue(DESKTOP_CLIENT, PC)
    const family = familyOf(token.access_token)
    store.registerComputer('d'.repeat(26), family, SIGN_KEY)
    store.revokeToken(token.refresh_token)
    expect(store.computers()).toEqual([])
    expect(store.computer('d'.repeat(26))).toBeNull()
  })

  it('keeps at most MAX_COMPUTERS, dropping the one seen longest ago', () => {
    const family = familyOf(store.issue(DESKTOP_CLIENT, PC).access_token)
    const ids = Array.from(
      { length: MAX_COMPUTERS + 1 },
      (_, i) => String.fromCharCode(97 + (i % 26)).repeat(20) + String(100000 + i),
    )
    for (const id of ids) {
      clock += 1000
      store.registerComputer(id, family, SIGN_KEY)
    }
    const kept = store.computers().map((c) => c.id)
    expect(kept).toHaveLength(MAX_COMPUTERS)
    expect(kept).not.toContain(ids[0])
  })

  it('takes nothing of an account that was replaced', () => {
    const tokens = store.issue(MOBILE_CLIENT, PHONE)
    const family = familyOf(store.issue(DESKTOP_CLIENT, PC).access_token)
    store.registerComputer('e'.repeat(26), family, SIGN_KEY)
    store.setAccount({ ...ACCOUNT, id: 'acct-2' })
    expect(store.checkAccess(tokens.access_token)).toBeNull()
    expect(store.refresh(MOBILE_CLIENT, tokens.refresh_token)).toEqual({
      ok: false,
      reason: 'unknown',
    })
    expect(store.families()).toEqual([])
    expect(store.computers()).toEqual([])
    expect(store.registerComputer('f'.repeat(26), family, SIGN_KEY)).toBeNull()
  })

  it('reads a file from before the registry, its sign-ins the one account’s', () => {
    const old = tempDir()
    writeFileSync(
      path.join(old, 'state.json'),
      JSON.stringify({
        v: 1,
        account: ACCOUNT,
        families: [
          {
            id: 'fam',
            clientId: DESKTOP_CLIENT,
            info: null,
            createdAt: 1,
            lastUsedAt: 1,
            refresh: 'x',
            refreshExpiresAt: Number.MAX_SAFE_INTEGER,
            previous: [],
          },
        ],
        access: [],
      }),
    )
    const read = new Store(old, now)
    expect(read.families()).toEqual([expect.objectContaining({ id: 'fam', account: ACCOUNT.id })])
    expect(read.computers()).toEqual([])
  })
})

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

describe('the account API and the relay with the registry', () => {
  let parts: ServerParts
  let base: string
  let cloud: HuliCloudApi
  const lines: string[] = []
  const hosts: RelayHost[] = []

  beforeAll(async () => {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    parts = makeServer({ origin: base, dataDir: tempDir(), trustProxy: false }, null, {
      log: (line) => lines.push(line),
      relayLimits: { tokenCheckMs: 200 },
    })
    parts.store.setAccount(ACCOUNT)
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

  const signIn = (client: string, info: HuliClientInfo | null = null) =>
    parts.store.issue(client, info)

  interface TestHost {
    id: string
    host: RelayHost
    key: string
    setProfile(next: RelayHostProfile | null): void
  }

  async function startHost(token: string): Promise<TestHost> {
    const relayKey = await importRelayKey(await newRelaySeed())
    const id = await relayHostId(relayKey.publicKey)
    const channelKey = await generateKeyPair()
    let profile = hostProfile(channelKey.publicKey, 'Studio', 'win32')
    const host = new RelayHost({
      main: base,
      id,
      key: relayKey,
      openSocket: (url) => new WebSocket(url),
      fetchInfo: async (url) => (await fetch(url)).json(),
      accepted: () => {},
      profile: () => profile,
      changed: () => {},
      log: () => {},
      timings: { retryMs: 50, maxRetryMs: 200, refusedMs: 200 },
    })
    host.setToken(token)
    host.start()
    hosts.push(host)
    return {
      id,
      host,
      key: encodeRelayBytes(channelKey.publicKey),
      setProfile: (next) => {
        profile = next
        host.profileChanged()
      },
    }
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

  it('refuses a phone’s or a browser’s sign-in as a host, relay token or not', async () => {
    for (const client of [MOBILE_CLIENT, WEB_CLIENT]) {
      const access = signIn(client).access_token
      const relayToken = (await new AccountApi(base, fetch).relayToken(access)).token
      for (const token of [access, relayToken]) {
        const t = await startHost(token)
        await expect.poll(state(t)).toBe('refused')
        t.host.stop()
        expect(parts.store.computer(t.id)).toBeNull()
      }
    }
    expect(lines.join('\n')).toContain("not a computer's sign-in")
  })

  it('registers a computer that signs in, with its profile, and lists it to the account', async () => {
    const desktop = signIn(DESKTOP_CLIENT, PC)
    const t = await startHost(desktop.access_token)
    await expect.poll(state(t)).toBe('connected')
    const phone = signIn(MOBILE_CLIENT, PHONE).access_token
    await expect
      .poll(async () => (await cloud.devices(phone)).computers.find((c) => c.id === t.id)?.key)
      .toBe(t.key)
    const listed = await cloud.devices(phone)
    expect(listed.computers.find((c) => c.id === t.id)).toMatchObject({
      name: 'Studio',
      platform: 'win32',
      online: true,
      pairable: true,
      current: false,
      device: parts.store.checkAccess(desktop.access_token)!.id,
    })
    expect(listed.devices.find((d) => d.current)).toMatchObject({ kind: 'mobile', name: 'iPhone' })
    // The computer itself sees its own registration as its own.
    const own = await cloud.devices(desktop.access_token)
    expect(own.computers.find((c) => c.id === t.id)?.current).toBe(true)
    // Kettu's list on the relay has it too, as one that takes pairing requests.
    const relayList = await fetch(`${base}/v1/hosts`, {
      headers: { authorization: `Bearer ${phone}` },
    })
    expect(parseRelayHosts(await relayList.json())?.map((h) => h.id)).toContain(t.id)
  })

  it('keeps a computer that takes no pairing requests off the relay list, not off the account', async () => {
    const t = await startHost(signIn(DAEMON_CLIENT, PC).access_token)
    await expect.poll(state(t)).toBe('connected')
    t.setProfile(hostProfile(new Uint8Array(32).fill(3), 'Quiet', 'linux', false))
    const phone = signIn(MOBILE_CLIENT, PHONE).access_token
    await expect
      .poll(async () => (await cloud.devices(phone)).computers.find((c) => c.id === t.id))
      .toMatchObject({ name: 'Quiet', pairable: false, online: true })
    const relayList = await fetch(`${base}/v1/hosts`, {
      headers: { authorization: `Bearer ${phone}` },
    })
    expect(parseRelayHosts(await relayList.json())?.map((h) => h.id)).not.toContain(t.id)
  })

  it('joins a device of the account to a registered computer, and no longer once it signs out', async () => {
    const desktop = signIn(DESKTOP_CLIENT, PC)
    const t = await startHost(desktop.access_token)
    await expect.poll(state(t)).toBe('connected')
    const phone = signIn(MOBILE_CLIENT, PHONE).access_token
    const joined = await dial(t.id, phone)
    expect(joined.kind).toBe('joined')
    if (joined.kind === 'joined') joined.socket.close()
    // The phone signs the computer out through the API: off the list, off the relay at once.
    const device = parts.store.checkAccess(desktop.access_token)!.id
    expect(await cloud.revoke(phone, { device })).toBe(1)
    expect((await cloud.devices(phone)).computers.map((c) => c.id)).not.toContain(t.id)
    await expect.poll(state(t), { timeout: 3000 }).toBe('refused')
    expect((await dial(t.id, phone)).kind).toBe('offline')
  })

  it('signs out every other device and spares the one asking', async () => {
    const others = [signIn(DESKTOP_CLIENT, PC), signIn(WEB_CLIENT)]
    const phone = signIn(MOBILE_CLIENT, PHONE).access_token
    const revoked = await cloud.revoke(phone, { others: true })
    expect(revoked).toBeGreaterThanOrEqual(2)
    for (const other of others) expect(parts.store.checkAccess(other.access_token)).toBeNull()
    expect((await cloud.devices(phone)).devices.map((d) => d.current)).toEqual([true])
  })

  it('takes an access token alone: no relay token, nothing unsigned', async () => {
    const phone = signIn(MOBILE_CLIENT, PHONE).access_token
    const relayToken = (await new AccountApi(base, fetch).relayToken(phone)).token
    expect((await fetch(`${base}${ACCOUNT_DEVICES_PATH}`)).status).toBe(401)
    const withRelayToken = await fetch(`${base}${ACCOUNT_DEVICES_PATH}`, {
      headers: { authorization: `Bearer ${relayToken}` },
    })
    expect(withRelayToken.status).toBe(401)
    await expect(cloud.revoke(phone, { device: 'nobody' })).rejects.toMatchObject({ status: 404 })
    const parsed = parseAccountDevices(
      await (
        await fetch(`${base}${ACCOUNT_DEVICES_PATH}`, {
          headers: { authorization: `Bearer ${phone}` },
        })
      ).json(),
    )
    expect(parsed).not.toBeNull()
  })

  it('refuses a host that renews with a phone’s token', async () => {
    const t = await startHost(signIn(DESKTOP_CLIENT, PC).access_token)
    await expect.poll(state(t)).toBe('connected')
    t.host.setToken(signIn(MOBILE_CLIENT, PHONE).access_token)
    await expect.poll(state(t), { timeout: 3000 }).not.toBe('connected')
  })

  it('isolates the account that replaced another: its tokens reach none of the old one', async () => {
    const t = await startHost(signIn(DESKTOP_CLIENT, PC).access_token)
    await expect.poll(state(t)).toBe('connected')
    const oldPhone = signIn(MOBILE_CLIENT, PHONE).access_token
    parts.store.setAccount({ ...ACCOUNT, id: 'acct-2' })
    try {
      const newPhone = signIn(MOBILE_CLIENT, PHONE).access_token
      expect((await cloud.devices(newPhone)).computers).toEqual([])
      expect(['forbidden', 'offline']).toContain((await dial(t.id, newPhone)).kind)
      expect((await dial(t.id, oldPhone)).kind).toBe('forbidden')
      await expect(cloud.devices(oldPhone)).rejects.toMatchObject({ status: 401 })
      // The old account's host is taken off as its sign-in no longer holds.
      await expect.poll(state(t), { timeout: 3000 }).toBe('refused')
    } finally {
      parts.store.setAccount(ACCOUNT)
    }
  })
})
