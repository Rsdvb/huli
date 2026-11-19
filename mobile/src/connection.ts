// The phone's way to its computer: Kettu's own device side (pairing, the encrypted channel and the
// host link) over WebSockets to the computer's direct port, on the local network or Tailscale, and
// through Huli Cloud's relay (relay.ts) when no direct address answers.

import { AppState } from 'react-native'
import * as Application from 'expo-application'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import { generateKeyPair, importKeyPair, type KeyPair } from '@shared/remote/noise'
import { hello, HostLink, type LinkRoute } from '@shared/remote/link'
import { pair, type Paired, type PairProgress } from '@shared/remote/pair'
import {
  pairWithAccountHost,
  type AccountPairFailure,
  type AccountPairing,
  type AccountPairProgress,
} from '@shared/remote/pair-account'
import { decodePairing, parsePairingLink, type PairingPayload } from '@shared/remote/pairing'
import type { DirectAddress } from '@shared/remote/protocol'
import { RELAY_URL, type HostRelay } from '@shared/remote/relay'
import type { Transport } from '@shared/remote/transport'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import { afterGrace, dialRelayTo, RelayUnavailable } from './relay'
import {
  computerIdOf,
  fromBase64,
  fromBase64Url,
  loadDeviceKey,
  saveDeviceKey,
  toBase64,
  type SavedHost,
} from './store'

/** This build's version, which the release run gives the phone and the desktop alike. */
export const APP_VERSION =
  Constants.expoConfig?.version || Application.nativeApplicationVersion || '0.1.0'

const CLIENT = {
  kind: 'ios',
  version: APP_VERSION,
  platform: `iOS ${Device.osVersion ?? ''}`.trim(),
}

/** This phone's key, made on first use and kept in the Keychain. */
export async function deviceKey(): Promise<KeyPair> {
  const saved = await loadDeviceKey()
  if (saved) return importKeyPair(saved)
  const key = await generateKeyPair()
  const raw = (key.privateKey as { x25519?: Uint8Array }).x25519
  if (!raw) throw new Error('The device key cannot be kept')
  await saveDeviceKey(raw)
  return key
}

/** A pairing code as the computer shows it: the app's link, a browser's link or the bare code. */
export function parseScanned(text: string): PairingPayload | null {
  const trimmed = text.trim()
  const app = parsePairingLink(trimmed)
  if (app) return app
  const at = trimmed.indexOf('#')
  if (at >= 0 && trimmed.slice(0, at).endsWith('/pair')) return decodePairing(trimmed.slice(at + 1))
  return decodePairing(trimmed)
}

function rank(address: DirectAddress): number {
  const parts = address.host.split('.').map(Number)
  if (parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) return 0 // Tailscale
  if (parts.length === 4 && (parts[0] === 10 || parts[0] === 192 || parts[0] === 172)) return 1
  return address.host.includes(':') ? 3 : 2
}

export type RouteKind = 'tailscale' | 'lan' | 'other'

export function routeKind(address: DirectAddress): RouteKind {
  const r = rank(address)
  return r === 0 ? 'tailscale' : r === 1 ? 'lan' : 'other'
}

// HostLink does not say which route it is on, so each open socket notes when it last heard the
// computer; the link's own connection is the one heard from most recently. A link to a computer
// other than the active one (fleet.ts) keeps its sockets in a map of its own, so they never pass
// for the active link's route nor keep its relay from dialing. The relay's socket is noted with no
// address, so a link on it says so instead of passing for none.
type Heard = Map<Transport, { address: DirectAddress | null; at: number }>
const heard: Heard = new Map()

function tracked(address: DirectAddress | null, transport: Transport, into: Heard): Transport {
  const entry = { address, at: 0 }
  into.set(transport, entry)
  transport.onClose(() => into.delete(transport))
  return {
    ...transport,
    onMessage: (listener) =>
      transport.onMessage((message) => {
        entry.at = Date.now()
        listener(message)
      }),
  }
}

/** Whether a direct connection is open now, which the relay then leaves alone. */
function directOpen(into: Heard): boolean {
  for (const entry of into.values()) if (entry.address) return true
  return false
}

/**
 * The relay as a route: dialed a moment after the direct addresses, unless one of them is open by
 * then; at once for a computer the phone has no usable address of.
 */
function relayRoute(relay: HostRelay, addresses: DirectAddress[], into: Heard): LinkRoute {
  return {
    key: 'relay',
    relay: true,
    dial: afterGrace(() => dialRelayTo(relay).then((t) => tracked(null, t, into)), {
      now: usableAddresses(addresses).length === 0,
      direct: () => directOpen(into),
    }),
  }
}

/** The direct addresses first; the relay, when the computer named one, after them. */
function dialAny(
  addresses: DirectAddress[],
  relay: HostRelay | undefined,
  into: Heard = heard,
): Promise<Transport> {
  if (!relay) return dialFirst(addresses, undefined, into)
  const viaRelay = relayRoute(relay, addresses, into).dial
  return new Promise((resolve, reject) => {
    let left = 2
    let won = false
    const fail = (error: unknown) => {
      if (--left === 0 && !won) reject(error)
    }
    for (const dial of [() => dialFirst(addresses, undefined, into), viaRelay]) {
      dial().then((transport) => {
        if (won) return transport.close()
        won = true
        resolve(transport)
      }, fail)
    }
  })
}

/** The route a link is on: one of the computer's addresses, or the relay. */
export type CurrentRoute = { kind: 'direct'; address: DirectAddress } | { kind: 'relay' }

/** The route the computer was last heard on, among the connections still open. */
export function currentRoute(): CurrentRoute | null {
  let best: { address: DirectAddress | null; at: number } | null = null
  for (const entry of heard.values()) {
    if (entry.at > 0 && (!best || entry.at > best.at)) best = entry
  }
  if (!best) return null
  return best.address ? { kind: 'direct', address: best.address } : { kind: 'relay' }
}

/** The address the computer was last heard on; null on the relay. */
export function currentAddress(): DirectAddress | null {
  const route = currentRoute()
  return route?.kind === 'direct' ? route.address : null
}

/** The addresses to try, Tailscale's first, without the IPv6 ones a WebSocket URL cannot name. */
export function usableAddresses(addresses: DirectAddress[]): DirectAddress[] {
  return addresses.filter((a) => !a.host.includes('%')).sort((a, b) => rank(a) - rank(b))
}

function socketUrl(address: DirectAddress): string {
  const host = address.host.includes(':') ? `[${address.host}]` : address.host
  return `ws://${host}:${address.port}/channel`
}

/**
 * A transport to one address, noted `into` the link's sockets. React Native's WebSocket may not
 * count what it has buffered.
 */
function openSocket(address: DirectAddress, timeoutMs = 8000, into = heard): Promise<Transport> {
  const socket = new WebSocket(socketUrl(address))
  if (typeof socket.bufferedAmount !== 'number') {
    Object.defineProperty(socket, 'bufferedAmount', { value: 0 })
  }
  const timer = setTimeout(() => socket.close(), timeoutMs)
  return webSocketTransport(socket)
    .then((transport) => tracked(address, transport, into))
    .finally(() => clearTimeout(timer))
}

/** The first address that opens; the others are closed. */
function dialFirst(
  addresses: DirectAddress[],
  timeoutMs?: number,
  into = heard,
): Promise<Transport> {
  const list = usableAddresses(addresses)
  if (list.length === 0) return Promise.reject(new Error('The computer named no address'))
  return new Promise((resolve, reject) => {
    let left = list.length
    let won = false
    for (const address of list) {
      openSocket(address, timeoutMs, into).then(
        (transport) => {
          if (won) return transport.close()
          won = true
          resolve(transport)
        },
        () => {
          left -= 1
          if (left === 0 && !won) reject(new Error('No address of the computer answered'))
        },
      )
    }
  })
}

/**
 * Whether any address of a computer answers now, for a computer the phone keeps no link to. The
 * socket closes before a handshake, so the computer sees only a connection that went away.
 */
export function probe(addresses: DirectAddress[]): Promise<boolean> {
  return dialFirst(addresses, 4000).then(
    (transport) => {
      transport.close()
      return true
    },
    () => false,
  )
}

export async function pairWith(
  payload: PairingPayload,
  progress: (state: PairProgress) => void,
): Promise<{ paired: Paired; host: SavedHost; key: KeyPair } | null> {
  const key = await deviceKey()
  const paired = await pair(
    {
      dial: () => dialAny(payload.addresses, payload.relay),
      payload,
      key,
      client: CLIENT,
      device: { name: Device.deviceName ?? 'iPhone', model: Device.modelName ?? 'iPhone' },
    },
    progress,
  )
  if (!paired) return null
  const { welcome } = paired
  const hostKey = toBase64(payload.hostKey)
  return {
    paired,
    key,
    host: {
      id: computerIdOf(hostKey),
      hostKey,
      name: welcome.host.name,
      deviceName: welcome.device.name,
      addresses: welcome.addresses.length > 0 ? welcome.addresses : payload.addresses,
      platform: welcome.host.platform,
      lastSeen: Date.now(),
      ...((welcome.relay ?? payload.relay) ? { relay: welcome.relay ?? payload.relay } : {}),
    },
  }
}

/** Why the relay did not join a computer, as a pairing request with it says. */
function relayFailure(error: unknown): AccountPairFailure | null {
  if (!(error instanceof RelayUnavailable)) return null
  switch (error.reason) {
    case 'offline':
      return 'host_offline'
    case 'forbidden':
    case 'signed_out':
      return 'wrong_account'
    default:
      return 'unreachable'
  }
}

/**
 * Asks a computer of the phone's Huli Cloud account to add it, through the relay alone, to the key
 * the account lists for it; the computer's owner allows it there and the phone's user compares the
 * code. Saved like a computer paired by its code once it welcomes the phone.
 */
export async function pairWithAccount(
  computer: { id: string; key: string },
  progress: (state: AccountPairProgress) => void,
): Promise<{
  pairing: AccountPairing
  finished: Promise<{ paired: Paired; host: SavedHost; key: KeyPair } | null>
}> {
  const key = await deviceKey()
  const hostKey = fromBase64Url(computer.key)
  const listed: HostRelay = { id: computer.id, urls: [RELAY_URL] }
  const pairing = pairWithAccountHost(
    {
      dial: () => dialRelayTo(listed),
      hostKey,
      key,
      client: CLIENT,
      device: { name: Device.deviceName ?? 'iPhone', model: Device.modelName ?? 'iPhone' },
      dialFailure: relayFailure,
    },
    progress,
  )
  const finished = pairing.result.then((paired) => {
    if (!paired) return null
    const { welcome } = paired
    const saved = toBase64(hostKey)
    const host: SavedHost = {
      id: computerIdOf(saved),
      hostKey: saved,
      name: welcome.host.name,
      deviceName: welcome.device.name,
      addresses: welcome.addresses,
      platform: welcome.host.platform,
      lastSeen: Date.now(),
      relay: welcome.relay ?? listed,
    }
    return { paired, host, key }
  })
  return { pairing, finished }
}

const routeKey = (address: DirectAddress) => `${address.host}:${address.port}`

/**
 * The addresses to try, the one the computer was last reached on first. Every route is dialed at
 * once, so this puts it first in line rather than making the others wait.
 */
export function triedAddresses(host: SavedHost): DirectAddress[] {
  const list = usableAddresses(host.addresses)
  const last = host.lastAddress ? routeKey(host.lastAddress) : null
  const at = last ? list.findIndex((a) => routeKey(a) === last) : -1
  return at > 0 ? [list[at]!, ...list.slice(0, at), ...list.slice(at + 1)] : list
}

/**
 * The kept link to the computer, which reconnects by itself while the app is in front. `current`
 * reads the computer as saved now, so a try takes the addresses its last welcome named. A link
 * that is not the active computer's (`side`) keeps its sockets out of `currentAddress`.
 */
export function linkTo(
  host: SavedHost,
  key: KeyPair,
  adopt?: Paired,
  current: () => SavedHost = () => host,
  side = false,
): HostLink {
  const into: Heard = side ? new Map() : heard
  const routes = (): LinkRoute[] => {
    const saved = current()
    const direct: LinkRoute[] = triedAddresses(saved).map((address) => ({
      key: routeKey(address),
      relay: false,
      dial: () => openSocket(address, undefined, into),
    }))
    return saved.relay ? [...direct, relayRoute(saved.relay, saved.addresses, into)] : direct
  }
  return new HostLink({
    dial: () => dialAny(current().addresses, current().relay, into),
    routes,
    hostKey: fromBase64(host.hostKey),
    key,
    hello: hello(CLIENT),
    ...(adopt ? { adopt } : {}),
    visible: () => AppState.currentState === 'active',
  })
}
