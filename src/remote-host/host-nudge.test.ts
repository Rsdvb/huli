// Huli: a host this computer could not reach, tried again at once when something says it may be
// back (the user returned, a window was focused, the relay was reached again) instead of at the
// end of a backoff that reaches a minute, while a host that stays away is not tried more often.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
const log = (): void => {}
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-host-nudge-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A host at LAN, answering only while `up`; the device's backoff waits an hour between tries. */
async function setup() {
  const hostDir = tempDir()
  const hostKey = await generateKeyPair()
  const laptopKey = await generateKeyPair()
  const devices = await DeviceStore.load(hostDir, log)
  await devices.add({
    publicKey: Buffer.from(laptopKey.publicKey).toString('base64'),
    name: 'Laptop',
    kind: 'desktop',
    platform: 'darwin',
    model: '',
  })
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity: await ActivityLog.load(hostDir, log),
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    discovery: new DiscoveryRequests({ send: () => {} }),
    host: { name: 'Studio', platform: 'win32', version: '0.0.0-test' },
    uploads: path.join(hostDir, 'uploads'),
    openAgentPort: async () => memoryPorts()[0],
    changed: () => {},
    log,
  })
  cleanups.push(() => server.stop('stopping'))

  const hosts = await HostStore.load(tempDir(), log)
  const host = (await hosts.add({
    publicKey: Buffer.from(hostKey.publicKey).toString('base64'),
    name: 'Studio',
    platform: 'win32',
    version: '0.0.0-test',
    addresses: [LAN],
    deviceName: 'Laptop',
  }))!
  const lan = { up: false, tries: 0 }
  let now = 1_000_000
  const retryDelay = vi.fn((_failures: number) => 3_600_000)
  const client: HostClient = new HostClient({
    key: laptopKey,
    hosts,
    client: { kind: 'desktop', version: '1.0.0', platform: 'macOS 26.1' },
    name: () => 'Laptop',
    openMainPort: async () => memoryPorts()[0],
    changed: () => {},
    pairing: () => {},
    log,
    connect: async () => {
      lan.tries++
      if (!lan.up) throw new Error('No route to the host')
      const [deviceEnd, hostEnd] = memoryTransports()
      server.accept(hostEnd)
      return deviceEnd
    },
    timeoutMs: 5000,
    retryDelay,
    now: () => now,
    networkCheckMs: null,
  })
  cleanups.push(() => client.stop())
  const state = (): HostConnection['state'] =>
    client.list().find((known) => known.id === host.id)!.connection.state
  return { client, lan, state, retryDelay, later: (ms: number) => void (now += ms) }
}

describe('a host tried again when nudged', () => {
  it('connects at once once it is back, without starting the backoff over', async () => {
    const t = await setup()
    t.client.start()
    await expect.poll(t.state).toBe('offline')
    expect(t.lan.tries).toBe(1)
    expect(t.retryDelay).toHaveBeenLastCalledWith(1)

    // Just tried: a nudge leaves it to its backoff.
    t.client.nudge()
    expect(t.lan.tries).toBe(1)

    // Still away: tried once, and the next wait is the one after the last, not the first again.
    t.later(6000)
    t.client.nudge()
    await expect.poll(() => t.retryDelay.mock.calls.length).toBe(2)
    expect(t.lan.tries).toBe(2)
    expect(t.retryDelay).toHaveBeenLastCalledWith(2)
    expect(t.state()).toBe('offline')

    // Back: the next nudge connects, long before the hour the backoff would wait.
    t.lan.up = true
    t.later(6000)
    t.client.nudge()
    await expect.poll(t.state).toBe('online')
    expect(t.lan.tries).toBe(3)

    // Connected: a nudge leaves it be.
    t.later(6000)
    t.client.nudge()
    expect(t.lan.tries).toBe(3)
  })
})
