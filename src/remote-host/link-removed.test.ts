// What makes a device's link stop for good as removed, so the phone forgets the computer: only the
// host's own `closing: removed`, which comes inside the channel its key opened. Dropped handshakes
// and timeouts, from a host too busy to answer, a relay, a proxy or a host with another key, are
// only a computer that cannot be reached now, however often they come.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hello, HostLink, type LinkRoute, type LinkState } from '@shared/remote/link'
import { generateKeyPair, type KeyPair } from '@shared/remote/noise'
import type { Transport } from '@shared/remote/transport'
import { ActivityLog } from './activity'
import { DeviceStore } from './devices'
import { DiscoveryRequests } from './discovery'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { memoryPorts, memoryTransports } from './testing/memory'

const log = (): void => {}
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The closing a host sends a removed device, as bytes anyone on the path could write. */
const FORGED = new TextEncoder().encode(JSON.stringify({ type: 'closing', reason: 'removed' }))

/** A host with this key that knows `phone`, unless `removed`, when it remembers it was removed. */
async function host(
  key: KeyPair,
  phone: KeyPair,
  options: { removed?: boolean; helloMs?: number },
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-link-removed-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const devices = await DeviceStore.load(dir, log)
  const added = await devices.add({
    publicKey: Buffer.from(phone.publicKey).toString('base64'),
    name: 'Phone',
    kind: 'ios',
    platform: 'ios',
    model: 'iPhone 17 Pro',
  })
  const server = new RemoteServer({
    staticKey: key,
    devices,
    activity: await ActivityLog.load(dir, log),
    pairing: new PairingCodes({ hostKey: key.publicKey, addresses: () => [], send: () => {} }),
    discovery: new DiscoveryRequests({ send: () => {} }),
    host: { name: 'Studio', platform: 'darwin', version: '0.0.0-test' },
    uploads: path.join(dir, 'uploads'),
    openAgentPort: async () => memoryPorts()[0],
    changed: () => {},
    log,
    ...(options.helloMs ? { helloTimeoutMs: options.helloMs } : {}),
  })
  cleanups.push(() => server.stop('stopping'))
  if (options.removed) await server.removeDevice(added!.id)
  return { server, id: added!.id }
}

/** The host hears what comes on `transport` `ms` late, as from a phone too busy to answer. */
function late(transport: Transport, ms: number): Transport {
  return {
    ...transport,
    onMessage: (listener) =>
      transport.onMessage((message) => void setTimeout(() => listener(message), ms)),
  }
}

type Way = 'host' | 'slow' | 'drop' | 'forge' | 'inject' | 'impostor' | 'forgot'

/**
 * A phone's link to a host, over the way `t.way` names at each dial: the host itself, the host too
 * slow for its hello timer, something that drops the handshake, a relay that answers with a forged
 * closing in place of the host or injects one into the host's channel, a host with another key
 * that remembers the phone as removed, or the host's key with a store that forgot the phone.
 */
async function setup() {
  const hostKey = await generateKeyPair()
  const phone = await generateKeyPair()
  const real = await host(hostKey, phone, {})
  const busy = await host(hostKey, phone, { helloMs: 100 })
  const impostor = await host(await generateKeyPair(), phone, { removed: true })
  const forgot = await host(hostKey, await generateKeyPair(), {})
  const t = { way: 'host' as Way, dials: 0, injected: 0 }
  const route: LinkRoute = {
    key: 'host',
    relay: false,
    dial: async () => {
      t.dials++
      const [device, far] = memoryTransports()
      switch (t.way) {
        case 'host':
          real.server.accept(far)
          return device
        case 'slow':
          busy.server.accept(late(far, 400))
          return device
        case 'drop':
          far.onMessage(() => far.close())
          return device
        case 'forge':
          far.onMessage(() => {
            far.send(FORGED)
            far.close()
          })
          return device
        case 'inject':
          real.server.accept(far)
          return injecting(device, () => t.injected++)
        case 'impostor':
          impostor.server.accept(far)
          return device
        case 'forgot':
          forgot.server.accept(far)
          return device
      }
    },
  }
  const link = new HostLink({
    dial: route.dial,
    routes: () => [route],
    hostKey: hostKey.publicKey,
    key: phone,
    hello: hello({ kind: 'ios', version: '1.0.0', platform: 'iOS 26' }),
    retryDelay: () => 5,
    keepalive: { quietMs: 60_000, answerMs: 60_000 },
  })
  cleanups.push(() => link.stop())
  const states: LinkState[] = []
  link.onState((state) => states.push(state))
  return Object.assign(t, { link, states, real })
}

/** The device's end, with the forged closing put among what the host sent once a welcome came. */
function injecting(transport: Transport, injected: () => void): Transport {
  return {
    ...transport,
    onMessage: (listener) => {
      let heard = 0
      transport.onMessage((message) => {
        listener(message)
        // The host's answer to the handshake, then its welcome: the session is up.
        if (++heard === 2) {
          injected()
          listener(FORGED)
        }
      })
    },
  }
}

async function connected(t: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await expect.poll(() => t.link.state.kind, { timeout: 15_000 }).toBe('connected')
}

/** Lets the link try `tries` more times over the way it is on, then takes it back to the host. */
async function triesThenBack(t: Awaited<ReturnType<typeof setup>>, tries: number): Promise<void> {
  const from = t.dials
  t.link.reconnectNow()
  await expect.poll(() => t.dials - from, { timeout: 15_000 }).toBeGreaterThanOrEqual(tries)
  expect(t.link.state.kind).not.toBe('stopped')
  t.way = 'host'
  t.link.reconnectNow()
  await connected(t)
  expect(t.states.some((state) => state.kind === 'stopped')).toBe(false)
}

describe('a link the host never said was removed', () => {
  it('keeps trying through handshakes that are dropped, however many in a row', async () => {
    const t = await setup()
    t.way = 'drop'
    t.link.start()
    await triesThenBack(t, 6)
  })

  it('keeps trying while the phone is too slow for the host to wait for its handshake', async () => {
    const t = await setup()
    t.way = 'slow'
    t.link.start()
    await triesThenBack(t, 4)
  })

  it('keeps trying a host that forgot this device without saying so', async () => {
    const t = await setup()
    t.way = 'forgot'
    t.link.start()
    await triesThenBack(t, 4)
  })
})

describe('a forged removal', () => {
  it('is no answer to the handshake when the relay writes it', async () => {
    const t = await setup()
    t.way = 'forge'
    t.link.start()
    await triesThenBack(t, 4)
  })

  it('ends only the connection it was put into, which the link then reconnects', async () => {
    const t = await setup()
    t.way = 'inject'
    t.link.start()
    await expect.poll(() => t.injected, { timeout: 15_000 }).toBeGreaterThanOrEqual(3)
    expect(t.link.state.kind).not.toBe('stopped')
    t.way = 'host'
    t.link.reconnectNow()
    await connected(t)
    expect(t.states.some((state) => state.kind === 'stopped')).toBe(false)
  })

  it('stops nothing when a host with another key remembers this device as removed', async () => {
    const t = await setup()
    t.way = 'impostor'
    t.link.start()
    await triesThenBack(t, 4)
  })
})

describe('a link the host removed', () => {
  it('stops as removed when the host removes the device while connected', async () => {
    const t = await setup()
    t.link.start()
    await connected(t)
    expect(await t.real.server.removeDevice(t.real.id)).toBe(true)
    await expect
      .poll(() => t.link.state, { timeout: 15_000 })
      .toEqual({ kind: 'stopped', reason: 'removed' })
  })

  it('stops as removed when the host says so at its next connection', async () => {
    const t = await setup()
    t.way = 'drop'
    t.link.start()
    await expect.poll(() => t.dials, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    // Removed while away: the host still knows its key and says why inside the channel.
    expect(await t.real.server.removeDevice(t.real.id)).toBe(true)
    t.way = 'host'
    t.link.reconnectNow()
    await expect
      .poll(() => t.link.state, { timeout: 15_000 })
      .toEqual({ kind: 'stopped', reason: 'removed' })
    const dials = t.dials
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(t.dials).toBe(dials)
  })
})
