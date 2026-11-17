// What the phone keeps, in the iOS Keychain: its own X25519 key, which every computer knows it by,
// and the computer it is paired with.

import * as SecureStore from 'expo-secure-store'
import type { DirectAddress } from '@shared/remote/protocol'

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
}
const KEY_ITEM = 'huli.device.key'
const HOST_ITEM = 'huli.host'

export interface SavedHost {
  /** The computer's X25519 public key, in base64. */
  hostKey: string
  name: string
  /** This phone's name there. */
  deviceName: string
  addresses: DirectAddress[]
  /** The computer's OS as Node.js names it ('win32', 'darwin', 'linux'), once a welcome said. */
  platform?: string
}

export function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}

export async function loadDeviceKey(): Promise<Uint8Array | null> {
  const text = await SecureStore.getItemAsync(KEY_ITEM, OPTIONS)
  return text ? fromBase64(text) : null
}

export async function saveDeviceKey(privateKey: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(KEY_ITEM, toBase64(privateKey), OPTIONS)
}

export async function loadHost(): Promise<SavedHost | null> {
  const text = await SecureStore.getItemAsync(HOST_ITEM, OPTIONS)
  if (!text) return null
  try {
    return JSON.parse(text) as SavedHost
  } catch {
    return null
  }
}

export async function saveHost(host: SavedHost | null): Promise<void> {
  if (host) await SecureStore.setItemAsync(HOST_ITEM, JSON.stringify(host), OPTIONS)
  else await SecureStore.deleteItemAsync(HOST_ITEM, OPTIONS)
}
