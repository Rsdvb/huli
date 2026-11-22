// Huli: previewing a dev server of the computer on a paired phone. The phone asks its computer
// over the encrypted channel to open a preview of a port the computer lists (`ports.list`); the
// computer's remote host answers with a port of its own, on the address the phone's direct
// connection came in on, that proxies to that one port of the computer's loopback alone. The
// phone's web view opens the entry path once, which trades its one-time ticket for a cookie that
// lasts as long as the preview. Only a direct connection (the same network or Tailscale) opens
// one: through the relay the phone has no address of the computer to load a page from.

import { isPort, SYSTEM_PORTS } from './port-forwards'

export const PREVIEW_OPEN = 'preview.open'
export const PREVIEW_CLOSE = 'preview.close'

/** The path a preview's ticket comes in under, `/__kite_preview/<ticket>`, never proxied. */
export const PREVIEW_ENTRY = '/__kite_preview/'

/** 32 random bytes in base64url, as the tickets and tokens are. */
export const PREVIEW_SECRET = /^[A-Za-z0-9_-]{43}$/

/** A preview goes once nothing used it for this long, and after PREVIEW_MAX_MS in any case. */
export const PREVIEW_IDLE_MS = 30 * 60 * 1000
export const PREVIEW_MAX_MS = 8 * 60 * 60 * 1000

/** What `preview.open` answers. */
export interface PreviewOpened {
  /** The computer's port that serves the preview, on the address the phone reached it at. */
  port: number
  /** Where the web view starts: the entry path with its one-time ticket. */
  path: string
  /** How long the preview lasts unused. */
  idleMs: number
}

/** Error codes `preview.open` fails with, beyond the protocol's own. */
export type PreviewFailure =
  /** The phone is on the relay, which carries no web page. */
  | 'needs_direct'
  /** No program of the computer's user listens on the port now. */
  | 'not_found'
  /** The port listens on another address than the loopback. */
  | 'forbidden'
  /** The device has as many previews open as it may. */
  | 'busy'

/** A port a preview may be asked for: one a dev server takes, above the system's. */
export function isPreviewPort(value: unknown): value is number {
  return isPort(value) && value > SYSTEM_PORTS
}

/** The computer's answer to `preview.open`, checked; null when it is none. */
export function parsePreviewOpened(value: unknown): PreviewOpened | null {
  if (typeof value !== 'object' || value === null) return null
  const { port, path, idleMs } = value as Record<string, unknown>
  if (!isPort(port) || typeof path !== 'string' || !path.startsWith(PREVIEW_ENTRY)) return null
  if (!PREVIEW_SECRET.test(path.slice(PREVIEW_ENTRY.length))) return null
  const idle = typeof idleMs === 'number' && idleMs > 0 ? idleMs : PREVIEW_IDLE_MS
  return { port, path, idleMs: idle }
}

/** The loopback address a preview connects to for a port listening on `address`, or null. */
export function loopbackTarget(address: string): '127.0.0.1' | '::1' | null {
  const plain = address.toLowerCase().replace(/^::ffff:/, '')
  if (plain === '127.0.0.1' || plain === '0.0.0.0') return '127.0.0.1'
  if (plain === '::1' || plain === '::') return '::1'
  return null
}
