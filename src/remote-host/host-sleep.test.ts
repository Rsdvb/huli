// Huli: a computer that goes to sleep lets its connections go at once, so the other side hears it
// then rather than once its pings go unanswered, and a client tries no host until the computer
// wakes for the user: a Mac's dark wakes (Power Nap) run its timers, and a host reached then would
// only drop again as it sleeps. After the wake the session resumes as after any drop.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostConnection } from '@shared/remote/hosts'
import { generateKeyPair } from '@shared/remote/noise'
import type { DirectAddress } from '@shared/remote/protocol'
import { ActivityLog } from './activity'
import { HostClient } from './client'
import { DeviceStore } from './devices'
import { DiscoveryRequests } from './discovery'
import { HostStore } from './hosts'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { memoryPorts, memoryTransports } from './testing/memory'

const LAN: DirectAddress = { host: '192.168.1.8', port: 47821 }
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-host-sleep-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A host at LAN and a laptop that knows it, which tries again 10 ms after a failure. */
async function setup() {
  const hostDir = tempDir()
  const hostKey = await generateKeyPair()
  const laptopKey = await generateKeyPair()
  const devices = await DeviceStore.load(hostDir, () => {})
  const laptop = (await devices.add({
    publicKey: Buffer.from(laptopKey.publicKey).toString('base64'),
    name: 'Laptop',
    kind: 'desktop',
    platform: 'darwin',
    model: '',
  }))!
  const logs: string[] = []
  const log = (_level: string, message: string): void => void logs.push(message)
  const counts = { agentPorts: 0, mainPorts: 0, tries: 0 }
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity: await ActivityLog.load(hostDir, () => {}),
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    discovery: new DiscoveryRequests({ send: () => {} }),
    host: { name: 'Studio', platform: 'win32', version: '0.0.0-test' },
    uploads: path.join(hostDir, 'uploads'),
    openAgentPort: async () => {
      counts.agentPorts++
      return memoryPorts()[0]
    },
    changed: () => {},
    log,
  })
  cleanups.push(() => server.stop('stopping'))

  const hosts = await HostStore.load(tempDir(), () => {})
  const host = (await hosts.add({
    publicKey: Buffer.from(hostKey.publicKey).toString('base64'),
    name: 'Studio',
    platform: 'win32',
    version: '0.0.0-test',
    addresses: [LAN],
    deviceName: 'Laptop',
  }))!
  const lan = { up: true }
  let now = 1_000_000
  const client: HostClient = new HostClient({
    key: laptopKey,
    hosts,
    client: { kind: 'desktop', version: '1.0.0', platform: 'macOS 26.1' },
    name: () => 'Laptop',
    openMainPort: async () => {
      counts.mainPorts++
      return memoryPorts()[0]
    },
    changed: () => {},
    pairing: () => {},
    log,
    connect: async () => {
      counts.tries++
      if (!lan.up) throw new Error('No route to the host')
      const [deviceEnd, hostEnd] = memoryTransports()
      server.accept(hostEnd)
      return deviceEnd
    },
    timeoutMs: 5000,
    retryDelay: () => 10,
    now: () => now,
    networkCheckMs: null,
  })
  cleanups.push(() => client.stop())
  const state = (): HostConnection['state'] =>
    client.list().find((known) => known.id === host.id)!.connection.state
  const online = (): boolean => server.online().includes(laptop.id)
  const later = (ms: number): void => void (now += ms)
  return { server, client, host, lan, counts, logs, state, online, later }
}

describe('a computer that goes to sleep', () => {
  it('lets each host go at once, tries none while asleep, and resumes on the wake', async () => {
    const t = await setup()
    t.client.start()
    await expect.poll(t.state).toBe('online')
    await expect.poll(t.online).toBe(true)
    expect(t.counts).toMatchObject({ agentPorts: 1, mainPorts: 1, tries: 1 })

    t.client.suspend()
    expect(t.client.asleep).toBe(true)
    // Reconnecting in place once it wakes, so the window shows no host as offline meanwhile.
    expect(t.state()).toBe('connecting')
    // The host hears the close at once, with no ping to go unanswered first.
    await expect.poll(t.online).toBe(false)

    // A dark wake runs the timers, may bring the relay back and sync what changed; still nothing
    // is tried.
    await wait(100)
    t.later(60_000)
    t.client.nudge()
    t.client.retryAll()
    t.client.setAddresses(t.host.id, [LAN])
    await wait(50)
    expect(t.counts.tries).toBe(1)
    expect(t.state()).toBe('connecting')

    // Woken for the user: the host is tried at once and the session it kept goes on.
    t.client.resume()
    expect(t.client.asleep).toBe(false)
    await expect.poll(t.state).toBe('online')
    await expect.poll(t.online).toBe(true)
    expect(t.counts).toMatchObject({ agentPorts: 1, mainPorts: 1, tries: 2 })
    expect(t.logs.join('\n')).not.toMatch(/stopped answering/)
  })

  it('waits for the wake when the network is not back yet, then keeps trying', async () => {
    const t = await setup()
    t.client.start()
    await expect.poll(t.state).toBe('online')

    t.client.suspend()
    t.lan.up = false
    t.client.resume()
    await expect.poll(t.state).toBe('offline')
    const tries = t.counts.tries
    await expect.poll(() => t.counts.tries).toBeGreaterThan(tries + 1)

    t.lan.up = true
    await expect.poll(t.state).toBe('online')
    expect(t.counts.agentPorts).toBe(1)
  })

  it('takes a reconnect the user asks for as the wake', async () => {
    const t = await setup()
    t.client.start()
    await expect.poll(t.state).toBe('online')

    t.client.suspend()
    await t.client.reconnect(t.host.id)
    expect(t.client.asleep).toBe(false)
    await expect.poll(t.state).toBe('online')
    expect(t.counts.agentPorts).toBe(1)
  })
})

describe('a host that goes to sleep', () => {
  it('lets its devices go at once, and they resume their sessions once it is back', async () => {
    const t = await setup()
    t.client.start()
    await expect.poll(t.state).toBe('online')
    await expect.poll(t.online).toBe(true)

    t.lan.up = false
    t.server.suspend()
    // The laptop hears it at once and reconnects in place, rather than after its pings.
    await expect.poll(t.state).not.toBe('online')
    expect(t.online()).toBe(false)

    t.lan.up = true
    await expect.poll(t.state).toBe('online')
    await expect.poll(t.online).toBe(true)
    // The same session, resumed: the host opened no other port to its agents.
    expect(t.counts).toMatchObject({ agentPorts: 1, mainPorts: 1 })
    expect(t.logs.join('\n')).not.toMatch(/stopped answering/)
  })
})
