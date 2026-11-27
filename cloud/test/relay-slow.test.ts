// The relay between a host sending a lot and a device that reads it slowly, as a Mac through a
// proxy. The relay stops reading the host while more than its high water waits toward the device,
// so it cannot read the host's pong meanwhile, and its own ping to the device waits behind what
// goes there; the device still speaks now and then, as Kite's devices do. The pair stays while the
// device answers, and goes once it falls silent, as one gone to sleep.

import { mkdtempSync, rmSync } from 'node:fs'
import {
  connect,
  createServer as createNetServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { importRelayKey, newRelaySeed, relayHostId } from '@shared/remote/relay'
import { dialRelay } from '@shared/remote/relay-device'
import { RelayHost } from '@shared/remote/relay-host'
import { makeServer, type ServerParts } from '../src/server'
import type { Account } from '../src/store'
import { makeOwner } from './accounts'

/** How often the relay pings every socket here; one without its pong by the next is cut. */
const PING_MS = 400
/** What the device reads a second while it is slow. */
const SLOW_RATE = 512 * 1024
/** One message of the host's long send. */
const CHUNK = 16 * 1024

let parts: ServerParts
let relayPort: number
let base: string
let dir: string
let owner: Account

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'huli-relay-slow-'))
  relayPort = await freePort()
  base = `http://127.0.0.1:${relayPort}`
  parts = makeServer({ origin: base, dataDir: dir, trustProxy: false }, null, {
    log: () => {},
    relayLimits: { pingMs: PING_MS },
  })
  owner = makeOwner(parts.store)
  await new Promise<void>((resolve) => parts.server.listen(relayPort, '127.0.0.1', resolve))
})

afterAll(async () => {
  parts.relay.close()
  parts.server.close()
  // The sockets' ends still write to the store a moment later.
  await wait(200)
  rmSync(dir, { recursive: true, force: true })
})

function signedIn(): string {
  return parts.store.issue(owner.id, 'kettu-desktop', {
    kind: 'desktop',
    name: 'Test PC',
    os: 'win32',
    arch: 'x64',
    version: '0.1.0',
  })!.access_token
}

function openSocket(url: string): WebSocket {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  return socket
}

/**
 * A TCP proxy in front of the relay for the device, whose way back to it carries `rate` bytes a
 * second once set, as a slow network does: TCP then holds the relay's writes back.
 */
async function slowProxy(): Promise<{
  url: string
  setRate(rate: number): void
  close(): Promise<void>
}> {
  let rate = Infinity
  const links: { relay: Socket; budget: number }[] = []
  const server: Server = createNetServer((device) => {
    const relay = connect(relayPort, '127.0.0.1')
    const link = { relay, budget: 0 }
    links.push(link)
    device.pipe(relay)
    relay.on('data', (chunk: Buffer) => {
      device.write(chunk)
      link.budget -= chunk.length
      if (rate !== Infinity && link.budget < 0) relay.pause()
    })
    relay.on('close', () => device.destroy())
    device.on('close', () => relay.destroy())
    relay.on('error', () => {})
    device.on('error', () => {})
  })
  const tick = setInterval(() => {
    for (const link of links) {
      if (rate === Infinity) link.budget = 0
      else link.budget = Math.min(link.budget + rate / 20, rate / 20)
      if (link.budget >= 0 && rate > 0) link.relay.resume()
    }
  }, 50)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    setRate: (next) => {
      rate = next
      if (rate === 0) for (const link of links) link.relay.pause()
    },
    close: async () => {
      clearInterval(tick)
      for (const link of links) link.relay.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function startHost(token: string) {
  const key = await importRelayKey(await newRelaySeed())
  const id = await relayHostId(key.publicKey)
  const accepted: WebSocket[] = []
  const host = new RelayHost({
    main: base,
    id,
    key,
    openSocket,
    fetchInfo: async (url) => (await fetch(url)).json(),
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
  await expect.poll(() => host.status[0]?.connection.state).toBe('connected')
  return { host, id, accepted }
}

describe('a device that reads slowly', () => {
  it('keeps the host it stopped reading while the device answers, and cuts both once it stops', async () => {
    const t = await startHost(signedIn())
    const proxy = await slowProxy()
    let speaking: ReturnType<typeof setInterval> | undefined
    try {
      const result = await dialRelay({
        relays: [proxy.url],
        id: t.id,
        token: signedIn(),
        openSocket,
        timeoutMs: 5000,
      })
      if (result.kind !== 'joined') throw new Error(result.kind)
      const device = result.socket
      device.binaryType = 'arraybuffer'
      let received = 0
      device.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) received += event.data.byteLength
      })
      await expect.poll(() => t.accepted.length).toBe(1)
      const host = t.accepted[0]!
      let hostClosed = false
      host.addEventListener('close', () => (hostClosed = true))

      proxy.setRate(SLOW_RATE)
      // As a device's keepalive does, which speaks after a while without writing.
      speaking = setInterval(() => device.send(new Uint8Array(8)), PING_MS / 4)
      // Far more than the relay holds, which then waits at the host: its pong waits behind it.
      const chunk = new Uint8Array(CHUNK)
      for (let sent = 0; sent < 24 * 1024 * 1024; sent += CHUNK) host.send(chunk)

      // Several of the relay's pings go by while the device takes its time: the pair stays.
      await wait(PING_MS * 7)
      expect(hostClosed).toBe(false)
      expect(device.readyState).toBe(WebSocket.OPEN)
      expect(parts.relay.counts().joined).toBe(1)
      const before = received
      expect(before).toBeGreaterThan(SLOW_RATE)
      await expect.poll(() => received, { timeout: PING_MS * 5 }).toBeGreaterThan(before)

      // The device stops reading and speaking, as one gone to sleep: the pair goes.
      clearInterval(speaking)
      proxy.setRate(0)
      await expect.poll(() => hostClosed, { timeout: PING_MS * 8 }).toBe(true)
      expect(parts.relay.counts().joined).toBe(0)
    } finally {
      clearInterval(speaking)
      t.host.stop()
      await proxy.close()
    }
  }, 20_000)
})
