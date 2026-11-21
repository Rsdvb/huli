// A device's link moving its session to a faster route after the host let the session go, as when
// a phone's Tailscale path went silent and the host stopped waiting: the host begins a new session
// on the new route, and the link tells its listeners as a reconnect, with a new session number,
// so what the device watched on the old session it watches again.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hello, HostLink, type LinkRoute, type LinkState } from '@shared/remote/link'
import { generateKeyPair } from '@shared/remote/noise'
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

/** The host hears what comes on `transport` `ms` late, as over a slow path. */
function late(transport: Transport, ms: number): Transport {
  return {
    ...transport,
    onMessage: (listener) =>
      transport.onMessage((message) => void setTimeout(() => listener(message), ms)),
  }
}

/**
 * The host's end of a connection that can go silent: once cut, the host hears it close and nothing
 * more passes either way, while the device's end never hears of it.
 */
function cuttable(transport: Transport) {
  let cut = false
  const closers: (() => void)[] = []
  return {
    transport: {
      ...transport,
      send: (message: Uint8Array) => {
        if (!cut) transport.send(message)
      },
      onMessage: (listener: (message: Uint8Array) => void) =>
        transport.onMessage((message) => {
          if (!cut) listener(message)
        }),
      onClose: (listener: () => void) => {
        closers.push(listener)
        transport.onClose(listener)
      },
      close: () => {
        if (!cut) transport.close()
      },
    } satisfies Transport,
    cut: () => {
      cut = true
      for (const close of closers.splice(0)) close()
    },
  }
}

describe('a link moving to a route after the host let its session go', () => {
  it('is heard as a reconnect, with a new session number', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-link-moves-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const hostKey = await generateKeyPair()
    const phoneKey = await generateKeyPair()
    const devices = await DeviceStore.load(dir, log)
    await devices.add({
      publicKey: Buffer.from(phoneKey.publicKey).toString('base64'),
      name: 'Phone',
      kind: 'ios',
      platform: 'ios',
      model: 'iPhone 17 Pro',
    })
    const server = new RemoteServer({
      staticKey: hostKey,
      devices,
      activity: await ActivityLog.load(dir, log),
      pairing: new PairingCodes({
        hostKey: hostKey.publicKey,
        addresses: () => [],
        send: () => {},
      }),
      discovery: new DiscoveryRequests({ send: () => {} }),
      host: { name: 'Studio', platform: 'darwin', version: '0.0.0-test' },
      uploads: path.join(dir, 'uploads'),
      openAgentPort: async () => memoryPorts()[0],
      changed: () => {},
      log,
      resumeMs: 30,
    })
    cleanups.push(() => server.stop('stopping'))

    // The slow route answers first, the fast one only later; the slow one's connection can go silent.
    let fastUp = false
    const silent: (() => void)[] = []
    const routes: LinkRoute[] = [
      {
        key: 'slow',
        relay: false,
        dial: async () => {
          const [deviceEnd, hostEnd] = memoryTransports()
          const host = cuttable(hostEnd)
          silent.push(host.cut)
          server.accept(late(host.transport, 60))
          return deviceEnd
        },
      },
      {
        key: 'fast',
        relay: false,
        dial: async () => {
          if (!fastUp) throw new Error('No route to the host')
          const [deviceEnd, hostEnd] = memoryTransports()
          server.accept(hostEnd)
          return deviceEnd
        },
      },
    ]
    const link = new HostLink({
      dial: () => routes[0]!.dial(),
      routes: () => routes,
      hostKey: hostKey.publicKey,
      key: phoneKey,
      hello: hello({ kind: 'ios', version: '1.0.0', platform: 'iOS 26' }),
      retryDelay: () => 0,
      // The device does not notice the silent connection by itself within the test.
      keepalive: { quietMs: 60_000, answerMs: 60_000 },
    })
    cleanups.push(() => link.stop())
    const states: LinkState[] = []
    link.onState((state) => states.push(state))
    link.start()
    await expect.poll(() => link.state.kind).toBe('connected')
    expect(link.state).toMatchObject({ kind: 'connected', session: 1 })

    // The host stops hearing the slow route and, once its wait is over, ends the session.
    silent[0]!()
    await expect.poll(() => server.online()).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 100))

    // The fast route comes up and the link moves there, where the host has no session to resume.
    fastUp = true
    const before = states.length
    link.wake()
    await expect.poll(() => states.length - before).toBeGreaterThanOrEqual(2)
    await expect.poll(() => link.state.kind).toBe('connected')
    expect(states.slice(before).map((state) => state.kind)).toEqual(['reconnecting', 'connected'])
    expect(link.state).toMatchObject({ kind: 'connected', session: 2 })
    expect(server.online()).toHaveLength(1)
  })
})
