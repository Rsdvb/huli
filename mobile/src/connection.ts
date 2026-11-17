// The phone's way to its computer: Kettu's own device side (pairing, the encrypted channel and the
// host link) over WebSockets to the computer's direct port, on the local network or Tailscale.

import { AppState } from 'react-native'
import * as Device from 'expo-device'
import { generateKeyPair, importKeyPair, type KeyPair } from '@shared/remote/noise'
import { hello, HostLink, type LinkRoute } from '@shared/remote/link'
import { pair, type Paired, type PairProgress } from '@shared/remote/pair'
import { decodePairing, parsePairingLink, type PairingPayload } from '@shared/remote/pairing'
import type { DirectAddress } from '@shared/remote/protocol'
import type { Transport } from '@shared/remote/transport'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import {
  computerIdOf,
  fromBase64,
  loadDeviceKey,
  saveDeviceKey,
  toBase64,
  type SavedHost,
} from './store'

export const APP_VERSION = '0.1.0'

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
// computer; the link's own connection is the one heard from most recently.
const heard = new Map<Transport, { address: DirectAddress; at: number }>()

function tracked(address: DirectAddress, transport: Transport): Transport {
  const entry = { address, at: 0 }
  heard.set(transport, entry)
  transport.onClose(() => heard.delete(transport))
  return {
    ...transport,
    onMessage: (listener) =>
      transport.onMessage((message) => {
        entry.at = Date.now()
        listener(message)
      }),
  }
}

/** The address the computer was last heard on, among the connections still open. */
export function currentAddress(): DirectAddress | null {
  let best: { address: DirectAddress; at: number } | null = null
  for (const entry of heard.values()) {
    if (entry.at > 0 && (!best || entry.at > best.at)) best = entry
  }
  return best?.address ?? null
}

/** The addresses to try, Tailscale's first, without the IPv6 ones a WebSocket URL cannot name. */
export function usableAddresses(addresses: DirectAddress[]): DirectAddress[] {
  return addresses.filter((a) => !a.host.includes('%')).sort((a, b) => rank(a) - rank(b))
}

function socketUrl(address: DirectAddress): string {
  const host = address.host.includes(':') ? `[${address.host}]` : address.host
  return `ws://${host}:${address.port}/channel`
}

/** A transport to one address. React Native's WebSocket may not count what it has buffered. */
function openSocket(address: DirectAddress, timeoutMs = 8000): Promise<Transport> {
  const socket = new WebSocket(socketUrl(address))
  if (typeof socket.bufferedAmount !== 'number') {
    Object.defineProperty(socket, 'bufferedAmount', { value: 0 })
  }
  const timer = setTimeout(() => socket.close(), timeoutMs)
  return webSocketTransport(socket)
    .then((transport) => tracked(address, transport))
    .finally(() => clearTimeout(timer))
}

/** The first address that opens; the others are closed. */
function dialFirst(addresses: DirectAddress[], timeoutMs?: number): Promise<Transport> {
  const list = usableAddresses(addresses)
  if (list.length === 0) return Promise.reject(new Error('The computer named no address'))
  return new Promise((resolve, reject) => {
    let left = list.length
    let won = false
    for (const address of list) {
      openSocket(address, timeoutMs).then(
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
      dial: () => dialFirst(payload.addresses),
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
    },
  }
}

/** The kept link to the computer, which reconnects by itself while the app is in front. */
export function linkTo(host: SavedHost, key: KeyPair, adopt?: Paired): HostLink {
  const routes = (): LinkRoute[] =>
    usableAddresses(host.addresses).map((address) => ({
      key: `${address.host}:${address.port}`,
      relay: false,
      dial: () => openSocket(address),
    }))
  return new HostLink({
    dial: () => dialFirst(host.addresses),
    routes,
    hostKey: fromBase64(host.hostKey),
    key,
    hello: hello(CLIENT),
    ...(adopt ? { adopt } : {}),
    visible: () => AppState.currentState === 'active',
  })
}
