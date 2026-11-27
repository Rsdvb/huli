// The keepalive on a slow connection with a large send on its way: a side's ping waits behind what
// it sent before, and the other side cannot read it, or answer, until all of that arrived. Neither
// side may take that wait for a silence, while a connection that really went is still given up.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PortChannel } from '@shared/port-channel'
import type { KeepaliveTimings } from '@shared/remote/keepalive'
import { hello, HostLink, type LinkState } from '@shared/remote/link'
import { generateKeyPair, type KeyPair } from '@shared/remote/noise'
import { PROTOCOL_VERSION, type DirectAddress } from '@shared/remote/protocol'
import { ActivityLog } from './activity'
import { HostClient } from './client'
import { DeviceStore } from './devices'
import { DiscoveryRequests } from './discovery'
import { HostStore } from './hosts'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { connectDevice } from './testing/device'
import { memoryPorts, slowTransports, type SlowTransports } from './testing/memory'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-keepalive-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * How fast the host's sends reach the device: a large send takes seconds, as through a proxy, while
 * each of its transport messages, 64 KiB at most, comes well within a ping's wait.
 */
const RATE = 400 * 1024
/** A large send: about two seconds on the way, ten times a ping's wait and more. */
const BIG = 1024 * 1024

/** An event of about `bytes` that deflate cannot shrink much, so it takes its time on the way. */
function bigEvent(bytes: number): { type: 'event'; event: { type: string; data: string } } {
  return {
    type: 'event',
    event: { type: 'test.big', data: randomBytes(Math.ceil((bytes * 3) / 4)).toString('base64') },
  }
}

const isBig = (message: unknown): boolean =>
  (message as { event?: { type?: unknown } } | null)?.event?.type === 'test.big'

/**
 * A host that knows `device`, whose sessions' agent ports the test drives, and whose log the test
 * reads; it pings by `keepalive`.
 */
async function startHost(device: KeyPair, keepalive?: KeepaliveTimings) {
  const dir = tempDir()
  const hostKey = await generateKeyPair()
  const devices = await DeviceStore.load(dir, () => {})
  await devices.add({
    publicKey: Buffer.from(device.publicKey).toString('base64'),
    name: 'Laptop',
    kind: 'desktop',
    platform: 'darwin',
    model: '',
  })
  const logs: string[] = []
  const agents: PortChannel[] = []
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity: await ActivityLog.load(dir, () => {}),
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    discovery: new DiscoveryRequests({ send: () => {} }),
    host: { name: 'Studio', platform: 'win32', version: '0.0.0-test' },
    uploads: path.join(dir, 'uploads'),
    openAgentPort: async () => {
      const [remote, agent] = memoryPorts()
      agents.push(agent)
      return remote
    },
    changed: () => {},
    log: (_level, message) => logs.push(message),
    ...(keepalive ? { keepalive } : {}),
  })
  cleanups.push(() => server.stop('stopping'))
  const dropped = (): boolean => logs.some((line) => line.includes('stopped answering'))
  return { server, hostKey, agents, logs, dropped }
}

describe("the host's keepalive behind its own large send", () => {
  const timings: KeepaliveTimings = { quietMs: 200, answerMs: 150, stallMs: 1_000 }

  it('keeps a device that answers once the send ahead of the ping arrived', async () => {
    const key = await generateKeyPair()
    const host = await startHost(key, timings)
    const link = slowTransports(RATE)
    host.server.accept(link.host, 'relay')
    // A device that only answers: it says nothing more while a message is still coming.
    const device = await connectDevice({
      transport: link.device,
      hostKey: host.hostKey.publicKey,
      key,
      hello: { protocol: { min: 1, max: PROTOCOL_VERSION } },
      acks: true,
    })
    await device.first
    await expect.poll(() => host.agents.length).toBe(1)

    // All of it ahead of the host's ping.
    host.agents[0]!.send(bigEvent(BIG))
    await expect.poll(() => device.messages.some(isBig), { timeout: 15_000 }).toBe(true)
    expect(host.dropped()).toBe(false)
    expect(host.server.online()).toHaveLength(1)
    // A ping went meanwhile, and its answer kept the connection.
    expect(device.keepalive).toContain('ping')
  })

  it('still gives up a device whose network went in the middle of the send', async () => {
    const key = await generateKeyPair()
    const host = await startHost(key, timings)
    const link = slowTransports(RATE)
    host.server.accept(link.host, 'relay')
    const device = await connectDevice({
      transport: link.device,
      hostKey: host.hostKey.publicKey,
      key,
      hello: { protocol: { min: 1, max: PROTOCOL_VERSION } },
      acks: true,
    })
    await device.first
    await expect.poll(() => host.agents.length).toBe(1)

    host.agents[0]!.send(bigEvent(BIG))
    await new Promise((resolve) => setTimeout(resolve, 300))
    link.cut()
    const cutAt = Date.now()
    await expect.poll(host.dropped, { timeout: 10_000 }).toBe(true)
    // Once nothing left for the stall's length, not once the whole send could have.
    expect(Date.now() - cutAt).toBeLessThan(timings.quietMs + timings.stallMs! + 1_500)
  })

  it('gives up a device that hangs on an idle connection as soon as before', async () => {
    const key = await generateKeyPair()
    const host = await startHost(key, timings)
    const link = slowTransports(RATE)
    host.server.accept(link.host, 'relay')
    const device = await connectDevice({
      transport: link.device,
      hostKey: host.hostKey.publicKey,
      key,
      hello: { protocol: { min: 1, max: PROTOCOL_VERSION } },
      acks: true,
      pongs: false,
    })
    await device.first
    const welcomedAt = Date.now()
    await expect.poll(host.dropped, { timeout: 5_000 }).toBe(true)
    expect(Date.now() - welcomedAt).toBeLessThan(timings.quietMs + timings.answerMs + 700)
  })
})

describe("a device's keepalive while a large message from its host comes", () => {
  const timings: KeepaliveTimings = { quietMs: 400, answerMs: 300, stallMs: 1_000 }

  it('keeps the link of a phone, which hears the message as it comes', async () => {
    const key = await generateKeyPair()
    const host = await startHost(key)
    const links: SlowTransports[] = []
    const route = {
      key: 'relay',
      relay: true,
      dial: async () => {
        const link = slowTransports(RATE)
        links.push(link)
        host.server.accept(link.host, 'relay')
        return link.device
      },
    }
    const phone = new HostLink({
      dial: route.dial,
      routes: () => [route],
      hostKey: host.hostKey.publicKey,
      key,
      hello: hello({ kind: 'ios', version: '1.0.0', platform: 'iOS 26' }),
      retryDelay: () => 5,
      keepalive: timings,
    })
    cleanups.push(() => phone.stop())
    const states: LinkState[] = []
    phone.onState((state) => states.push(state))
    let big = false
    phone.onHostEvent((event) => {
      if ((event as { type?: unknown }).type === 'test.big') big = true
    })
    phone.start()
    await expect.poll(() => phone.state.kind, { timeout: 15_000 }).toBe('connected')
    await expect.poll(() => host.agents.length).toBe(1)

    host.agents[0]!.send(bigEvent(BIG))
    await expect.poll(() => big, { timeout: 15_000 }).toBe(true)
    expect(states.map((state) => state.kind)).not.toContain('reconnecting')
    expect(links).toHaveLength(1)
  })

  it('keeps a host that cannot see its own backlog hearing it, as an older host', async () => {
    const key = await generateKeyPair()
    // Its ping's wait starts as the ping is written, however much waits ahead of it.
    const host = await startHost(key, { quietMs: 400, answerMs: 300 })
    const route = {
      key: 'relay',
      relay: true,
      dial: async () => {
        const link = slowTransports(RATE)
        host.server.accept({ ...link.host, buffered: () => 0 }, 'relay')
        return link.device
      },
    }
    const phone = new HostLink({
      dial: route.dial,
      routes: () => [route],
      hostKey: host.hostKey.publicKey,
      key,
      hello: hello({ kind: 'ios', version: '1.0.0', platform: 'iOS 26' }),
      retryDelay: () => 5,
      keepalive: { quietMs: 250, answerMs: 300, stallMs: 1_000 },
    })
    cleanups.push(() => phone.stop())
    let big = false
    phone.onHostEvent((event) => {
      if ((event as { type?: unknown }).type === 'test.big') big = true
    })
    phone.start()
    await expect.poll(() => phone.state.kind, { timeout: 15_000 }).toBe('connected')
    await expect.poll(() => host.agents.length).toBe(1)

    host.agents[0]!.send(bigEvent(BIG))
    await expect.poll(() => big, { timeout: 15_000 }).toBe(true)
    expect(host.dropped()).toBe(false)
  })

  it('keeps the session of a computer, which hears the message as it comes', async () => {
    const key = await generateKeyPair()
    const host = await startHost(key)
    const lan: DirectAddress = { host: '192.168.1.8', port: 47821 }
    const hosts = await HostStore.load(tempDir(), () => {})
    await hosts.add({
      publicKey: Buffer.from(host.hostKey.publicKey).toString('base64'),
      name: 'Studio',
      platform: 'win32',
      version: '0.0.0-test',
      addresses: [lan],
      deviceName: 'Laptop',
    })
    const logs: string[] = []
    const main: unknown[] = []
    let dials = 0
    const client = new HostClient({
      key,
      hosts,
      client: { kind: 'desktop', version: '1.0.0', platform: 'macOS 26.1' },
      name: () => 'Laptop',
      openMainPort: async () => {
        const [ours, theirs] = memoryPorts()
        theirs.onMessage((message) => main.push(message))
        return ours
      },
      changed: () => {},
      pairing: () => {},
      log: (_level, message) => logs.push(message),
      connect: async () => {
        dials++
        const link = slowTransports(RATE)
        host.server.accept(link.host)
        return link.device
      },
      timeoutMs: 5_000,
      networkCheckMs: null,
      keepalive: timings,
    })
    cleanups.push(() => client.stop())
    client.start()
    await expect.poll(() => host.agents.length, { timeout: 15_000 }).toBe(1)
    await expect.poll(() => client.list()[0]?.connection.state, { timeout: 15_000 }).toBe('online')

    host.agents[0]!.send(bigEvent(BIG))
    await expect.poll(() => main.some(isBig), { timeout: 15_000 }).toBe(true)
    expect(logs.filter((line) => line.includes('stopped answering'))).toEqual([])
    expect(dials).toBe(1)
  })
})
