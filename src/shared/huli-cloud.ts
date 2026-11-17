// Huli's own clients of Huli Cloud beside Kettu's: the phone app, which signs in through the
// system browser with PKCE and comes back on the app's URL scheme (RFC 8252 7.1); and Huli Cloud's
// account API beyond Kettu's: the account's signed-in devices and its computers, which hosts
// signed in to the relay register. Imports nothing of Node.js, since the phone and the hosted web
// client speak it too.

import {
  AccountNetworkError,
  AccountServiceError,
  DAEMON_CLIENT,
  DESKTOP_CLIENT,
  WEB_CLIENT,
  type AccountFetch,
  type ClientInfo,
} from './account-api'
import { MAX_LISTED_HOSTS, MAX_PROFILE_NAME, decodeRelayBytes, isRelayHostId } from './remote/relay'

/** The phone app's OAuth client. */
export const MOBILE_CLIENT = 'huli-mobile'

/** Where the sign-in page sends the phone's browser back with the code. */
export const MOBILE_REDIRECT = 'huli://signin'

/** The path the hosted web client takes the sign-in's code back on, as CALLBACK_PATH. */
export const WEB_CALLBACK_PATH = '/signin/callback'

/** How a client is described when it signs in: Kettu's kinds, and the phone. */
export type HuliClientInfo = Omit<ClientInfo, 'kind'> & { kind: ClientInfo['kind'] | 'mobile' }

/**
 * The clients whose sign-in may put a computer on the relay as a host: the desktop app and the
 * daemon. A phone's or a browser's token reaches computers as a device, never as one.
 */
export const HOST_CLIENTS: readonly string[] = [DESKTOP_CLIENT, DAEMON_CLIENT]

/** Lists the account's devices and computers; revokes devices. Bearer access tokens only. */
export const ACCOUNT_DEVICES_PATH = '/api/v1/account/devices'
export const ACCOUNT_REVOKE_PATH = '/api/v1/account/devices/revoke'
/** The web page where the account's password and two-step verification are changed. */
export const ACCOUNT_PAGE_PATH = '/account/devices/'

export type DeviceKind = 'desktop' | 'daemon' | 'web' | 'mobile' | 'other'

/** A signed-in client of the account. */
export interface AccountDevice {
  /** The sign-in's id, which revoking names. */
  id: string
  kind: DeviceKind
  /** What it said of itself when it signed in; null when it said nothing readable. */
  name: string | null
  os: string | null
  version: string | null
  createdAt: number
  lastUsedAt: number
  /** The sign-in that asked. */
  current: boolean
}

/** A computer of the account: a host that signed in to the relay. */
export interface AccountComputer {
  /** Its relay host id. */
  id: string
  /** Null until it sent its profile. */
  name: string | null
  platform: string | null
  /** Its channel's X25519 public key, in base64url, as it said over the relay; null before. */
  key: string | null
  /** Its Ed25519 public key, in base64url, which its relay sign-in proved. */
  signKey: string
  /** The sign-in it registered with, an AccountDevice's id. */
  device: string
  firstSeen: number
  lastSeen: number
  /** Signed in to the relay now. */
  online: boolean
  /** It takes pairing requests from the account's devices now. */
  pairable: boolean
  /** Registered by the sign-in that asked: the asking computer itself. */
  current: boolean
}

export interface AccountDevices {
  devices: AccountDevice[]
  computers: AccountComputer[]
}

/** The most devices the list carries. */
const MAX_DEVICES = 256
const MAX_TEXT = 100
const PLATFORM = /^[a-z0-9_-]{1,32}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const DEVICE_KINDS: readonly DeviceKind[] = ['desktop', 'daemon', 'web', 'mobile', 'other']

/** The kind of client an OAuth client id is. */
export function deviceKind(clientId: string): DeviceKind {
  switch (clientId) {
    case DESKTOP_CLIENT:
      return 'desktop'
    case DAEMON_CLIENT:
      return 'daemon'
    case WEB_CLIENT:
      return 'web'
    case MOBILE_CLIENT:
      return 'mobile'
    default:
      return 'other'
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const textOrNull = (value: unknown, max = MAX_TEXT): string | null | undefined =>
  value === null ? null : typeof value === 'string' && value.length <= max ? value : undefined

const isKey = (value: unknown): value is string =>
  typeof value === 'string' && decodeRelayBytes(value)?.length === 32

function parseDevice(value: unknown): AccountDevice | null {
  const entry = record(value)
  if (!entry || typeof entry.id !== 'string' || !ID.test(entry.id)) return null
  const kind = DEVICE_KINDS.find((k) => k === entry.kind)
  const name = textOrNull(entry.name)
  const os = textOrNull(entry.os)
  const version = textOrNull(entry.version)
  if (!kind || name === undefined || os === undefined || version === undefined) return null
  if (!isTime(entry.createdAt) || !isTime(entry.lastUsedAt) || typeof entry.current !== 'boolean') {
    return null
  }
  return {
    id: entry.id,
    kind,
    name,
    os,
    version,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    current: entry.current,
  }
}

function parseComputer(value: unknown): AccountComputer | null {
  const entry = record(value)
  if (!entry || !isRelayHostId(entry.id) || !isKey(entry.signKey)) return null
  if (typeof entry.device !== 'string' || !ID.test(entry.device)) return null
  const name = textOrNull(entry.name, MAX_PROFILE_NAME)
  const platform = entry.platform === null ? null : entry.platform
  if (name === undefined || (platform !== null && !PLATFORM.test(String(platform)))) return null
  if (entry.key !== null && !isKey(entry.key)) return null
  if (!isTime(entry.firstSeen) || !isTime(entry.lastSeen)) return null
  for (const flag of ['online', 'pairable', 'current'] as const) {
    if (typeof entry[flag] !== 'boolean') return null
  }
  return {
    id: entry.id,
    name,
    platform: platform as string | null,
    key: entry.key as string | null,
    signKey: entry.signKey,
    device: entry.device,
    firstSeen: entry.firstSeen,
    lastSeen: entry.lastSeen,
    online: entry.online as boolean,
    pairable: entry.pairable as boolean,
    current: entry.current as boolean,
  }
}

/** What ACCOUNT_DEVICES_PATH answered; null when any of it is not what the service lists. */
export function parseAccountDevices(value: unknown): AccountDevices | null {
  const body = record(value)
  if (!body || !Array.isArray(body.devices) || !Array.isArray(body.computers)) return null
  if (body.devices.length > MAX_DEVICES || body.computers.length > MAX_LISTED_HOSTS) return null
  const devices = body.devices.map(parseDevice)
  const computers = body.computers.map(parseComputer)
  if (devices.includes(null) || computers.includes(null)) return null
  return { devices: devices as AccountDevice[], computers: computers as AccountComputer[] }
}

/** Huli Cloud's account API beyond Kettu's, with an access token of the account. */
export class HuliCloudApi {
  constructor(
    readonly base: string,
    private readonly fetch: AccountFetch,
  ) {}

  async devices(accessToken: string): Promise<AccountDevices> {
    const body = await this.request(ACCOUNT_DEVICES_PATH, { method: 'GET' }, accessToken)
    const parsed = parseAccountDevices(body)
    if (!parsed) throw unexpected(ACCOUNT_DEVICES_PATH)
    return parsed
  }

  /**
   * Signs out one of the account's devices, or every one but the asking one; a computer's leaves
   * the relay within a minute. How many were signed out.
   */
  async revoke(accessToken: string, which: { device: string } | { others: true }): Promise<number> {
    const form: Record<string, string> =
      'device' in which ? { device: which.device } : { others: '1' }
    const body = await this.request(
      ACCOUNT_REVOKE_PATH,
      { method: 'POST', body: new URLSearchParams(form) },
      accessToken,
    )
    const revoked = record(body)?.revoked
    if (!isTime(revoked)) throw unexpected(ACCOUNT_REVOKE_PATH)
    return revoked
  }

  private async request(path: string, init: RequestInit, token: string): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetch(`${this.base}${path}`, {
        ...init,
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new AccountNetworkError(`Could not reach ${this.base}: ${(error as Error).message}`)
    }
    const text = await response.text().catch(() => '')
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      throw unexpected(path)
    }
    if (response.ok) return body
    const error = record(body)
    const code = typeof error?.error === 'string' ? error.error : 'server_error'
    const message = typeof error?.error_description === 'string' ? error.error_description : code
    throw new AccountServiceError(code, message, response.status)
  }
}

function unexpected(path: string): AccountServiceError {
  return new AccountServiceError('server_error', `${path} gave an answer Huli cannot read`, 200)
}
