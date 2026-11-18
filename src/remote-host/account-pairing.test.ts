// Pairing with a host of the same Kettu account end to end: the host on the test relay with its
// profile, this computer's client listing it and pairing with it through the relay.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Channel } from '@shared/remote/channel'
import {
  DISCOVER_PROLOGUE,
  discoveryNonce,
  type DiscoveryRequestEvent,
} from '@shared/remote/discovery'
import { FakeRelays } from '@shared/remote/fake-relay'
import type { HostPairingState } from '@shared/remote/hosts'
import { generateKeyPair, Handshake } from '@shared/remote/noise'
import { pairWithAccountHost, type AccountPairProgress } from '@shared/remote/pair-account'
import {
  encodeRelayBytes,
  hostProfile,
  importRelayKey,
  newRelaySeed,
  relayHostId,
} from '@shared/remote/relay'
import { dialRelay } from '@shared/remote/relay-device'
import { RelayHost } from '@shared/remote/relay-host'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import { ActivityLog } from './activity'
import { HostClient } from './client'
import { DeviceStore } from './devices'
import { DiscoveryRequests } from './discovery'
import { HostStore } from './hosts'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { memoryPorts, memoryTransports } from './testing/memory'

const MAIN = 'https://relay.test'
const log = (): void => {}
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-account-pairing-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function setup(laptopToken = 'laptop-token') {
  const relays = new FakeRelays()
  relays.accounts.set('host-token', 'account')
  relays.accounts.set('laptop-token', 'account')
  relays.accounts.set('stranger-token', 'another account')

  const hostDir = tempDir()
  const hostKey = await generateKeyPair()
  const relayKey = await importRelayKey(await newRelaySeed())
  const relayId = await relayHostId(relayKey.publicKey)
  const events: DiscoveryRequestEvent[] = []
  const discovery = new DiscoveryRequests({ send: (event) => events.push(event) })
  const server: RemoteServer = new RemoteServer({
    staticKey: hostKey,
    devices: await DeviceStore.load(hostDir, log),
    activity: await ActivityLog.load(hostDir, log),
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    discovery,
    host: { name: 'Studio', platform: 'darwin', version: '0.0.0-test' },
    uploads: path.join(hostDir, 'uploads'),
    openAgentPort: async () => memoryPorts()[0],
    relay: () => ({ id: relayId, urls: [MAIN] }),
    changed: () => {},
    log,
  })
  const relay = new RelayHost({
    main: MAIN,
    id: relayId,
    key: relayKey,
    openSocket: relays.openSocket,
    fetchInfo: relays.fetchInfo,
    accepted: (socket) =>
      void webSocketTransport(socket, true).then((transport) => server.accept(transport, 'relay')),
    profile: () => (discovery.on ? hostProfile(hostKey.publicKey, 'Studio', 'darwin') : null),
    changed: () => {},
    log,
  })
  relay.start()
  relay.setToken('host-token')
  discovery.setEnabled(true)
  relay.profileChanged()
  cleanups.push(async () => {
    relay.stop()
    await server.stop('stopping')
  })

  const states: HostPairingState[] = []
  const client = new HostClient({
    key: await generateKeyPair(),
    hosts: await HostStore.load(tempDir(), log),
    client: { kind: 'desktop', version: '1.0.0', platform: 'macOS 26.1' },
    name: () => 'Laptop',
    changed: () => {},
    pairing: (_, state) => states.push(state),
    log,
    relay: {
      main: MAIN,
      token: () => laptopToken,
      openSocket: relays.openSocket,
      fetchJson: relays.fetchJson,
    },
    timeoutMs: 5000,
  })
  cleanups.push(() => client.stop())
  await expect.poll(() => relays.relay(MAIN).hosts.get(relayId)?.profile).toBeTruthy()
  return { relays, relay, relayId, hostKey, server, discovery, events, client, states }
}

describe('pairing with a host of the account through the relay', () => {
  it('lists the host, shows the same code on both sides, and adds it once both say yes', async () => {
    const t = await setup()
    const publicKey = Buffer.from(t.hostKey.publicKey).toString('base64')
    expect(await t.client.discover(null)).toEqual({
      state: 'ok',
      hosts: [{ relayId: t.relayId, publicKey, name: 'Studio', platform: 'darwin' }],
    })
    // This computer's own host is not one to pair with.
    expect(await t.client.discover(publicKey)).toEqual({ state: 'ok', hosts: [] })

    t.client.pairDiscovered(1, t.relayId, null, 'MacBook Air')
    await expect.poll(() => t.states.at(-1)?.state).toBe('compare')
    await expect.poll(() => t.events.length).toBe(1)
    const asked = t.events[0]!.request
    const compared = t.states.at(-1)!
    if (asked.state !== 'confirm' || compared.state !== 'compare') throw new Error('Not asked')
    expect(compared).toEqual({ state: 'compare', code: asked.code, matched: false })
    expect(asked.device).toMatchObject({ name: 'Laptop', model: 'MacBook Air', kind: 'desktop' })

    t.client.matchPairing(1, true)
    expect(t.states.at(-1)).toEqual({ state: 'compare', code: asked.code, matched: true })
    t.discovery.answer(1, true, 'Laptop')
    await expect.poll(() => t.states.at(-1)?.state).toBe('added')
    const added = t.states.at(-1)!
    expect(added).toMatchObject({
      state: 'added',
      host: { publicKey, name: 'Studio', relay: { id: t.relayId, urls: [MAIN] } },
    })
    // Paired now, it is no longer listed.
    expect(await t.client.discover(null)).toEqual({ state: 'ok', hosts: [] })
  })

  it('ends when this computer says the codes differ, and the host hears it', async () => {
    const t = await setup()
    t.client.pairDiscovered(1, t.relayId, null, 'MacBook Air')
    await expect.poll(() => t.states.at(-1)?.state).toBe('compare')
    t.client.matchPairing(1, false)
    expect(t.states.at(-1)).toEqual({ state: 'failed', reason: 'void' })
    await expect
      .poll(() => t.events.at(-1)?.request)
      .toEqual({
        state: 'closed',
        reason: 'cancelled',
      })
  })

  it("lists nothing of another account's hosts, and a host off the list is offline", async () => {
    const t = await setup('stranger-token')
    expect(await t.client.discover(null)).toEqual({ state: 'ok', hosts: [] })
    t.client.pairDiscovered(1, t.relayId, null, 'MacBook Air')
    await expect.poll(() => t.states.at(-1)).toEqual({ state: 'failed', reason: 'host_offline' })
  })

  it('takes the host off the list once it no longer lets devices find it', async () => {
    const t = await setup()
    t.discovery.setEnabled(false)
    t.relay.profileChanged()
    await expect.poll(() => t.relays.relay(MAIN).hosts.get(t.relayId)?.profile).toBeNull()
    expect(await t.client.discover(null)).toEqual({ state: 'ok', hosts: [] })
  })
})

describe("a phone pairing with a computer of its Huli Cloud account (Huli's own side)", () => {
  const PHONE = { kind: 'ios', version: '0.1.0', platform: 'iOS 26' }

  async function phonePairing(t: Awaited<ReturnType<typeof setup>>, hostKey?: Uint8Array) {
    const states: AccountPairProgress[] = []
    const key = await generateKeyPair()
    const pairing = pairWithAccountHost(
      {
        dial: async () => {
          const result = await dialRelay({
            relays: [MAIN],
            id: t.relayId,
            token: 'laptop-token',
            openSocket: t.relays.openSocket,
            timeoutMs: 5000,
          })
          if (result.kind !== 'joined') throw new Error(result.kind)
          return webSocketTransport(result.socket, true)
        },
        hostKey: hostKey ?? t.hostKey.publicKey,
        key,
        client: PHONE,
        device: { name: 'iPhone', model: 'iPhone 17' },
      },
      (state) => states.push(state),
    )
    cleanups.push(() => pairing.cancel())
    return { pairing, states, key, last: () => states.at(-1) }
  }

  const compared = (p: { last: () => AccountPairProgress | undefined }) => () => p.last()?.state

  it('is added once the owner said yes there and the phone said the codes match', async () => {
    const t = await setup()
    const p = await phonePairing(t)
    await expect.poll(compared(p)).toBe('compare')
    await expect.poll(() => t.events.length).toBe(1)
    const asked = t.events[0]!.request
    const shown = p.last()!
    if (asked.state !== 'confirm' || shown.state !== 'compare') throw new Error('Not asked')
    expect(shown.code).toBe(asked.code)
    expect(asked.device).toMatchObject({ name: 'iPhone', model: 'iPhone 17', kind: 'ios' })

    // The owner's yes alone adds nothing.
    t.discovery.answer(t.events[0]!.requestId, true, 'iPhone')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(t.server.options.devices.list()).toEqual([])
    p.pairing.match(true)
    const paired = await p.pairing.result
    expect(paired?.welcome.host.name).toBe('Studio')
    const added = t.server.options.devices.list()
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      name: 'iPhone',
      kind: 'ios',
      publicKey: Buffer.from(p.key.publicKey).toString('base64'),
    })
  })

  it("is not added on the phone's yes alone, and not when the owner says no", async () => {
    const t = await setup()
    const p = await phonePairing(t)
    await expect.poll(compared(p)).toBe('compare')
    p.pairing.match(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(t.server.options.devices.list()).toEqual([])
    await expect.poll(() => t.events.length).toBe(1)
    t.discovery.answer(t.events[0]!.requestId, false, '')
    expect(await p.pairing.result).toBeNull()
    expect(p.last()).toEqual({ state: 'failed', reason: 'rejected' })
    expect(t.server.options.devices.list()).toEqual([])
  })

  it('ends when the phone says the codes differ, and the computer hears it', async () => {
    const t = await setup()
    const p = await phonePairing(t)
    await expect.poll(compared(p)).toBe('compare')
    p.pairing.match(false)
    expect(await p.pairing.result).toBeNull()
    expect(p.last()).toEqual({ state: 'failed', reason: 'cancelled' })
    await expect
      .poll(() => t.events.at(-1)?.request)
      .toEqual({ state: 'closed', reason: 'cancelled' })
    // Too late now: the owner's yes adds nothing.
    t.discovery.answer(t.events[0]!.requestId, true, 'iPhone')
    expect(t.server.options.devices.list()).toEqual([])
  })

  it('reaches nobody with a key that is not the computer’s, as a registry could list', async () => {
    const t = await setup()
    const other = await generateKeyPair()
    const p = await phonePairing(t, other.publicKey)
    expect(await p.pairing.result).toBeNull()
    expect(p.last()).toEqual({ state: 'failed', reason: 'refused' })
    expect(t.events).toEqual([])
  })

  it('takes no request while the computer is not discoverable', async () => {
    const t = await setup()
    t.discovery.setEnabled(false)
    const p = await phonePairing(t)
    expect(await p.pairing.result).toBeNull()
    expect(p.last()).toEqual({ state: 'failed', reason: 'refused' })
    expect(t.events).toEqual([])
  })
})

describe('a phone pairing with something that only claims to be the computer', () => {
  it('refuses a welcome before its user confirmed the codes', async () => {
    const [phoneSide, fakeSide] = memoryTransports()
    const fakeKey = await generateKeyPair()
    // A responder of the discovery handshake with a key of its own, as a cloud that listed it
    // would run: it answers the exchange and welcomes at once, with no owner to ask.
    const responder = await Handshake.create({
      pattern: 'IK',
      role: 'responder',
      staticKey: fakeKey,
      prologue: DISCOVER_PROLOGUE,
      accept: () => true,
    })
    let channel: Channel | null = null
    const send = (value: unknown) => channel!.send({ kind: 'json', value })
    fakeSide.onMessage((message) => {
      if (channel) return void channel.receive(message)
      void (async () => {
        await responder.readMessage(message)
        const reply = await responder.writeMessage()
        channel = new Channel(await responder.split(), {
          write: (frame) => fakeSide.send(frame),
          message: (received) => {
            if (received.kind !== 'json') return
            const value = received.value as { type?: string }
            if (value.type === 'pair-commit') {
              void send({ type: 'pair-nonce', nonce: encodeRelayBytes(discoveryNonce()) })
            }
            if (value.type === 'hello') {
              void send({
                type: 'welcome',
                protocol: 1,
                host: { name: 'Studio', platform: 'darwin', version: '1.0.0' },
                features: ['bytes'],
                role: 'owner',
                device: { id: 'a'.repeat(32), name: 'iPhone' },
                terminal: false,
                addresses: [],
              })
            }
          },
          end: () => fakeSide.close(),
        })
        fakeSide.send(reply)
      })()
    })
    const states: AccountPairProgress[] = []
    const pairing = pairWithAccountHost(
      {
        dial: async () => phoneSide,
        hostKey: fakeKey.publicKey,
        key: await generateKeyPair(),
        client: { kind: 'ios', version: '0.1.0', platform: 'iOS 26' },
        device: { name: 'iPhone', model: 'iPhone 17' },
      },
      (state) => states.push(state),
    )
    expect(await pairing.result).toBeNull()
    expect(states.at(-1)).toEqual({ state: 'failed', reason: 'void' })
  })
})
