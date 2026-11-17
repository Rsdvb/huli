// What the phone keeps, in the iOS Keychain: its own X25519 key, which every computer knows it by,
// and the computers it is paired with, one of them active.

import * as SecureStore from 'expo-secure-store'
import type { DirectAddress } from '@shared/remote/protocol'
import type { HostRelay } from '@shared/remote/relay'

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
}
const KEY_ITEM = 'huli.device.key'
/** Before several computers: the one computer, as a bare SavedHost. Read once to migrate. */
const LEGACY_HOST_ITEM = 'huli.host'
const HOSTS_ITEM = 'huli.hosts'

export interface SavedHost {
  /** Short and stable, from the computer's key: links (`?host=`) and the cache name it by. */
  id: string
  /** The computer's X25519 public key, in base64. */
  hostKey: string
  name: string
  /** This phone's name there. */
  deviceName: string
  addresses: DirectAddress[]
  /** The computer's OS as Node.js names it ('win32', 'darwin', 'linux'), once a welcome said. */
  platform?: string
  /** The name the user gave it on this phone, shown over the computer's own. */
  label?: string
  /** When the phone last heard from it. */
  lastSeen?: number
  /** The address the link last connected on, tried first the next time. */
  lastAddress?: DirectAddress
  /** The id its notifications carry (its relay host id), once it said. */
  pushId?: string
  /** Its id on Huli Cloud's relay and the relays it signs in to, once a code or a welcome said. */
  relay?: HostRelay
}

export interface SavedComputers {
  active: string | null
  hosts: SavedHost[]
}

export function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}

/** A computer's id: the first 6 bytes of its public key in hex, the same on every pairing. */
export function computerIdOf(hostKey: string): string {
  let hex = ''
  for (const byte of fromBase64(hostKey).slice(0, 6)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** The name the app shows for a computer: the user's own, or the computer's. */
export function computerName(host: Pick<SavedHost, 'name' | 'label'> | null | undefined): string {
  return host?.label?.trim() || host?.name || '电脑'
}

export async function loadDeviceKey(): Promise<Uint8Array | null> {
  const text = await SecureStore.getItemAsync(KEY_ITEM, OPTIONS)
  return text ? fromBase64(text) : null
}

export async function saveDeviceKey(privateKey: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(KEY_ITEM, toBase64(privateKey), OPTIONS)
}

function withId(host: Omit<SavedHost, 'id'> & { id?: string }): SavedHost {
  return { ...host, id: host.id || computerIdOf(host.hostKey) }
}

function parse<T>(text: string | null): T | null {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** The paired computers; a phone paired before there could be several has its one moved over. */
export async function loadComputers(): Promise<SavedComputers> {
  const saved = parse<{ v: 1; active: string | null; hosts: SavedHost[] }>(
    await SecureStore.getItemAsync(HOSTS_ITEM, OPTIONS),
  )
  if (saved && Array.isArray(saved.hosts)) {
    const hosts = saved.hosts.filter((h) => typeof h?.hostKey === 'string').map(withId)
    const active = hosts.some((h) => h.id === saved.active) ? saved.active : (hosts[0]?.id ?? null)
    return { active, hosts }
  }
  const legacy = parse<Omit<SavedHost, 'id'>>(
    await SecureStore.getItemAsync(LEGACY_HOST_ITEM, OPTIONS),
  )
  if (!legacy || typeof legacy.hostKey !== 'string') return { active: null, hosts: [] }
  const host = withId(legacy)
  const migrated = { active: host.id, hosts: [host] }
  await saveComputers(migrated)
  await SecureStore.deleteItemAsync(LEGACY_HOST_ITEM, OPTIONS).catch(() => {})
  return migrated
}

export async function saveComputers(computers: SavedComputers): Promise<void> {
  if (computers.hosts.length === 0) {
    await SecureStore.deleteItemAsync(HOSTS_ITEM, OPTIONS)
    return
  }
  await SecureStore.setItemAsync(HOSTS_ITEM, JSON.stringify({ v: 1, ...computers }), OPTIONS)
}
