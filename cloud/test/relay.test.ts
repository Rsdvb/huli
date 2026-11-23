// The relay end to end, driven by the clients' own code (RelayHost for the host, dialRelay for a
// device, AccountApi for the relay token) over real WebSockets, so a change on either side that
// breaks the other fails here. Also the signed region list as deployed, and the hosted clients'
// sign-in and CORS.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AccountApi, WEB_CLIENT, type ClientInfo } from '@shared/account-api'
import { MOBILE_CLIENT, MOBILE_REDIRECT, WEB_CALLBACK_PATH } from '@shared/huli-cloud'
import {
  MAX_DEVICE_CONNECTIONS,
  MAX_RELAY_MESSAGE,
  RELAY_CLOSE,
  RELAY_URL,
  RELAY_TOKENS_FEATURE,
  connectSocketPath,
  hostSocketPath,
  importRelayKey,
  newRelaySeed,
  parseRelayHosts,
  parseRelayInfo,
  relayHostId,
  relaySocketUrl,
  type RelayKey,
} from '@shared/remote/relay'
import { dialRelay, type RelayDialResult } from '@shared/remote/relay-device'
import { RelayHost } from '@shared/remote/relay-host'
import { REGION_KEYS, verifyRegionList } from '@shared/remote/relay-regions'
import { pkceChallenge, randomToken } from '../src/secrets'
import { makeServer, regionIdOf, type ServerParts } from '../src/server'
import type { Account } from '../src/store'
import { makeOwner } from './accounts'

const INFO: ClientInfo = {
  kind: 'desktop',
  name: 'Test PC',
  os: 'win32',
  arch: 'x64',
  version: '0.1.0',
}
const WEB_ORIGIN = 'http://app.localhost:5999'
const SIGNED = readFileSync(
  path.join(import.meta.dirname, '..', 'deploy', 'regions.signed.json'),
  'utf8',
).trim()

let parts: ServerParts
let base: string
let dir: string
let owner: Account
const lines: string[] = []

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'huli-relay-'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  parts = makeServer(
    { origin: base, dataDir: dir, trustProxy: false, webOrigin: WEB_ORIGIN, regions: SIGNED },
    null,
    { log: (line) => lines.push(line), relayLimits: { tokenCheckMs: 200 } },
  )
  owner = makeOwner(parts.store)
  await new Promise<void>((resolve) => parts.server.listen(port, '127.0.0.1', resolve))
})

afterAll(() => {
  parts.relay.close()
  parts.server.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A signed-in client's access token, and the family behind it. */
function signedIn(): string {
  return parts.store.issue(owner.id, 'kettu-desktop', INFO)!.access_token
}

function openSocket(url: string): WebSocket {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  return socket
}

const fetchInfo = async (url: string): Promise<unknown> => (await fetch(url)).json()

interface TestHost {
  host: RelayHost
  id: string
  key: RelayKey
  accepted: WebSocket[]
  stop(): void
}

async function startHost(token: string, key?: RelayKey): Promise<TestHost> {
  const own = key ?? (await importRelayKey(await newRelaySeed()))
  const id = await relayHostId(own.publicKey)
  const accepted: WebSocket[] = []
  const host = new RelayHost({
    main: base,
    id,
    key: own,
    openSocket,
    fetchInfo,
    accepted: (socket) => {
      socket.binaryType = 'arraybuffer'
      accepted.push(socket)
    },
    profile: () => ({
      key: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
      name: 'Studio',
      platform: 'win32',
    }),
    changed: () => {},
    log: () => {},
    timings: { retryMs: 50, maxRetryMs: 200, refusedMs: 200 },
  })
  host.setToken(token)
  host.start()
  return { host, id, key: own, accepted, stop: () => host.stop() }
}

const connected = (t: TestHost) => () => t.host.status[0]?.connection.state

function dial(id: string, token: string): Promise<RelayDialResult> {
  return dialRelay({ relays: [base], id, token, openSocket, timeoutMs: 5000 })
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    socket.addEventListener('message', (event) => resolve(event.data), { once: true }),
  )
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (socket.readyState === socket.CLOSED) return resolve(-1)
    socket.addEventListener('close', (event) => resolve(event.code), { once: true })
  })
}

describe('relay info and region list', () => {
  it('names itself, its region and what it offers', async () => {
    const info = parseRelayInfo(await fetchInfo(`${base}/v1`))
    expect(info?.features).toEqual(['hosts', 'regions', RELAY_TOKENS_FEATURE])
    expect(info?.regions).toEqual([{ id: 'main', url: base }])
    expect((await fetch(`${base}/v1/ping`)).status).toBe(204)
    expect((await fetch(`${base}/v1/reports`, { method: 'POST' })).status).toBe(404)
  })

  it('serves the deployed list, which verifies against the built-in keys for the main relay', async () => {
    const answer = await fetch(`${base}/v1/regions`)
    expect(answer.status).toBe(200)
    const etag = answer.headers.get('etag')
    const list = await verifyRegionList(await answer.json(), RELAY_URL, REGION_KEYS)
    expect(list?.regions.map((region) => region.url)).toEqual([RELAY_URL])
    expect(list?.regions[0]?.state).toBe('active')
    expect(regionIdOf(SIGNED, RELAY_URL)).toBe(list?.regions[0]?.id)
    const again = await fetch(`${base}/v1/regions`, { headers: { 'if-none-match': etag! } })
    expect(again.status).toBe(304)
  })
})

describe('joining a device to a host', () => {
  it('signs a host in and passes bytes both ways unchanged', async () => {
    const token = signedIn()
    const t = await startHost(token)
    await expect.poll(connected(t)).toBe('connected')
    const result = await dial(t.id, signedIn())
    expect(result.kind).toBe('joined')
    if (result.kind !== 'joined') return
    const device = result.socket
    device.binaryType = 'arraybuffer'
    await expect.poll(() => t.accepted.length).toBe(1)
    const host = t.accepted[0]!
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff)
    const atHost = nextMessage(host)
    device.send(bytes)
    expect(new Uint8Array((await atHost) as ArrayBuffer)).toEqual(bytes)
    const atDevice = nextMessage(device)
    host.send(bytes.slice(0, 10))
    expect(new Uint8Array((await atDevice) as ArrayBuffer)).toEqual(bytes.slice(0, 10))
    // The relay answers ping on a joined socket and passes no other text.
    const pong = nextMessage(device)
    device.send('ping')
    expect(await pong).toBe('pong')
    const ended = closed(host)
    device.send('{"type":"anything"}')
    expect(await ended).toBe(RELAY_CLOSE.malformed)
    t.stop()
  })

  it('works with relay tokens from the account service', async () => {
    const access = signedIn()
    const api = new AccountApi(base, fetch)
    const relay = await api.relayToken(access)
    expect(relay.token.startsWith('hr1.')).toBe(true)
    const t = await startHost(relay.token)
    await expect.poll(connected(t)).toBe('connected')
    const device = await api.relayToken(signedIn())
    expect((await dial(t.id, device.token)).kind).toBe('joined')
    // A token with its signature changed is refused. The second-to-last character carries six
    // whole bits of the signature, and always becomes a different one.
    const flip = device.token.at(-2) === 'A' ? 'B' : 'A'
    const forged = `${device.token.slice(0, -2)}${flip}${device.token.at(-1)}`
    expect((await dial(t.id, forged)).kind).toBe('forbidden')
    t.stop()
  })

  it('refuses a key that is not the id, and a token that is none', async () => {
    const t = await startHost('not-a-token-of-this-service')
    await expect.poll(connected(t)).toBe('refused')
    t.stop()
    const other = await importRelayKey(await newRelaySeed())
    const id = await relayHostId(other.publicKey)
    const wrongKey = await importRelayKey(await newRelaySeed())
    const socket = openSocket(relaySocketUrl(base, hostSocketPath(id)))
    const challenge = JSON.parse((await nextMessage(socket)) as string) as { nonce: string }
    const { signInMessage } = await import('@shared/remote/relay')
    socket.send(
      JSON.stringify(await signInMessage(wrongKey, base, id, challenge.nonce, signedIn())),
    )
    expect(await closed(socket)).toBe(RELAY_CLOSE.unauthorized)
  })

  it('says offline for a host not signed in, forbidden for a device without a valid token', async () => {
    const seed = await importRelayKey(await newRelaySeed())
    const id = await relayHostId(seed.publicKey)
    expect((await dial(id, signedIn())).kind).toBe('offline')
    const t = await startHost(signedIn())
    await expect.poll(connected(t)).toBe('connected')
    expect((await dial(t.id, 'no-such-token')).kind).toBe('forbidden')
    t.stop()
  })

  it('closes a message over the limit with 1009, on both sides', async () => {
    const t = await startHost(signedIn())
    await expect.poll(connected(t)).toBe('connected')
    const result = await dial(t.id, signedIn())
    if (result.kind !== 'joined') throw new Error(result.kind)
    await expect.poll(() => t.accepted.length).toBe(1)
    const atHost = closed(t.accepted[0]!)
    const atDevice = closed(result.socket)
    result.socket.send(new Uint8Array(MAX_RELAY_MESSAGE + 1))
    expect(await atDevice).toBe(RELAY_CLOSE.tooBig)
    expect(await atHost).toBe(RELAY_CLOSE.tooBig)
    t.stop()
  })

  it('joins no more than its limit of devices to one host', async () => {
    const t = await startHost(signedIn())
    await expect.poll(connected(t)).toBe('connected')
    const token = signedIn()
    const joined: WebSocket[] = []
    for (let i = 0; i < MAX_DEVICE_CONNECTIONS; i++) {
      const result = await dial(t.id, token)
      if (result.kind === 'joined') joined.push(result.socket)
    }
    expect(joined).toHaveLength(MAX_DEVICE_CONNECTIONS)
    expect(await dial(t.id, token)).toEqual({ kind: 'refused', reason: 'too_many' })
    for (const socket of joined) socket.close()
    t.stop()
  })

  it('takes a host off once its client is signed out', async () => {
    const access = signedIn()
    const t = await startHost(access)
    await expect.poll(connected(t)).toBe('connected')
    parts.store.revokeToken(access)
    await expect.poll(connected(t), { timeout: 3000 }).toBe('refused')
    t.stop()
  })

  it('keeps the second copy of a host and tells the first it was replaced', async () => {
    const key = await importRelayKey(await newRelaySeed())
    const first = await startHost(signedIn(), key)
    await expect.poll(connected(first)).toBe('connected')
    const second = await startHost(signedIn(), key)
    await expect.poll(connected(second)).toBe('connected')
    await expect.poll(connected(first)).not.toBe('connected')
    first.stop()
    second.stop()
  })

  it('refuses a page of another origin, and takes the web client', async () => {
    const t = await startHost(signedIn())
    await expect.poll(connected(t)).toBe('connected')
    const url = relaySocketUrl(base, connectSocketPath(t.id))
    const { WebSocket: Ws } = await import('ws')
    const evil = new Ws(url, { origin: 'https://evil.example' })
    const refused = await new Promise<number>((resolve) => {
      evil.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
      evil.on('error', () => resolve(-1))
    })
    expect(refused).toBe(403)
    const web = new Ws(url, { origin: WEB_ORIGIN })
    await new Promise((resolve, reject) => {
      web.on('open', resolve)
      web.on('error', reject)
    })
    web.close()
    t.stop()
  })

  it('lists the account hosts that gave a profile', async () => {
    const t = await startHost(signedIn())
    await expect.poll(connected(t)).toBe('connected')
    const list = async () => {
      const answer = await fetch(`${base}/v1/hosts`, {
        headers: { authorization: `Bearer ${signedIn()}` },
      })
      return parseRelayHosts(await answer.json())?.map((host) => host.id) ?? []
    }
    await expect.poll(list).toContain(t.id)
    expect((await fetch(`${base}/v1/hosts`)).status).toBe(401)
    t.stop()
  })

  it('logs events without tokens or what passes', () => {
    const text = lines.join('\n')
    expect(text).toContain('signed in')
    expect(text).not.toMatch(/hr1\./)
  })
})

describe('sockets not signed in', () => {
  let small: ServerParts
  let origin: string
  let smallDir: string
  let smallOwner: Account

  beforeAll(async () => {
    smallDir = mkdtempSync(path.join(tmpdir(), 'huli-relay-small-'))
    const port = await freePort()
    origin = `http://127.0.0.1:${port}`
    small = makeServer({ origin, dataDir: smallDir, trustProxy: true }, null, {
      log: () => {},
      relayLimits: { maxUnsignedSockets: 3, maxUnsignedSocketsPerAddress: 2 },
    })
    smallOwner = makeOwner(small.store)
    await new Promise<void>((resolve) => small.server.listen(port, '127.0.0.1', resolve))
  })

  afterAll(() => {
    small.relay.close()
    small.server.close()
    rmSync(smallDir, { recursive: true, force: true })
  })

  it('have a cap of their own, in all and from one address, apart from signed-in hosts', async () => {
    const { WebSocket: Ws } = await import('ws')
    // A host signed in takes none of their room.
    const key = await importRelayKey(await newRelaySeed())
    const id = await relayHostId(key.publicKey)
    const signedHost = new RelayHost({
      main: origin,
      id,
      key,
      openSocket,
      fetchInfo,
      accepted: () => {},
      profile: () => null,
      changed: () => {},
      log: () => {},
    })
    signedHost.setToken(small.store.issue(smallOwner.id, 'kettu-desktop', INFO)!.access_token)
    signedHost.start()
    await expect.poll(() => signedHost.status[0]?.connection.state).toBe('connected')
    const opened: InstanceType<typeof Ws>[] = []
    const open = (address: string): Promise<'challenged' | number> => {
      const socket = new Ws(relaySocketUrl(origin, hostSocketPath(id)), {
        headers: { 'x-real-ip': address },
      })
      opened.push(socket)
      return new Promise((resolve) => {
        socket.once('message', () => resolve('challenged'))
        socket.once('close', (code) => resolve(code))
      })
    }
    expect(await open('198.51.100.1')).toBe('challenged')
    expect(await open('198.51.100.1')).toBe('challenged')
    expect(await open('198.51.100.1')).toBe(RELAY_CLOSE.tooMany)
    expect(await open('198.51.100.2')).toBe('challenged')
    expect(await open('198.51.100.3')).toBe(RELAY_CLOSE.tooMany)
    expect(signedHost.status[0]?.connection.state).toBe('connected')
    for (const socket of opened) socket.close()
    await expect.poll(() => small.relay.counts().sockets).toBe(1)
    expect(await open('198.51.100.3')).toBe('challenged')
    for (const socket of opened) socket.close()
    signedHost.stop()
    // Gone before the folder is, as the host's leaving is written down.
    await expect.poll(() => small.relay.counts().sockets).toBe(0)
  })
})

describe('hosted clients', () => {
  async function signInPage(clientId: string, redirectUri: string): Promise<Response> {
    const url = new URL('/signin/app/', base)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkceChallenge(randomToken(48)),
      code_challenge_method: 'S256',
      state: 's',
    }).toString()
    return fetch(url)
  }

  it('lets the web client sign in at its own origin alone', async () => {
    const ok = await signInPage(WEB_CLIENT, `${WEB_ORIGIN}${WEB_CALLBACK_PATH}`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-security-policy')).toContain(`form-action 'self'`)
    expect(ok.headers.get('content-security-policy')).toContain(WEB_ORIGIN)
    expect((await signInPage(WEB_CLIENT, `https://evil.example${WEB_CALLBACK_PATH}`)).status).toBe(
      400,
    )
    expect((await signInPage(WEB_CLIENT, `${WEB_ORIGIN}/elsewhere`)).status).toBe(400)
  })

  it('lets the phone sign in to its own URL alone', async () => {
    expect((await signInPage(MOBILE_CLIENT, MOBILE_REDIRECT)).status).toBe(200)
    expect((await signInPage(MOBILE_CLIENT, 'huli://elsewhere')).status).toBe(400)
    expect((await signInPage(MOBILE_CLIENT, 'http://127.0.0.1:5555/callback')).status).toBe(400)
  })

  it('answers the web client across origins, and no other page', async () => {
    const preflight = await fetch(`${base}/api/v1/me`, {
      method: 'OPTIONS',
      headers: { origin: WEB_ORIGIN, 'access-control-request-method': 'GET' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
    const other = await fetch(`${base}/api/v1/me`, { headers: { origin: 'https://evil.example' } })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
    const info = await fetch(`${base}/v1`, { headers: { origin: WEB_ORIGIN } })
    expect(info.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN)
    const regions = await fetch(`${base}/v1/regions`, { headers: { origin: WEB_ORIGIN } })
    expect(regions.headers.get('access-control-expose-headers')).toBe('etag')
  })
})
