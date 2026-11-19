// The phone's Huli Cloud account (src/shared/huli-signin.ts does the sign-in itself): the system's
// web authentication session, the Keychain for the refresh token, and the relay's tokens, which go
// to relay.ts once signed in. Also the account's devices and computers, which the account page and
// the computer sheet list, and signing devices out.

import { useEffect, useSyncExternalStore } from 'react'
import * as Device from 'expo-device'
import * as SecureStore from 'expo-secure-store'
import * as WebBrowser from 'expo-web-browser'
import { AccountApi, ACCOUNT_URL, type AccountFetch } from '@shared/account-api'
import {
  ACCOUNT_PAGE_PATH,
  HuliCloudApi,
  type AccountComputer,
  type AccountDevices,
} from '@shared/huli-cloud'
import { CloudSession, type CloudStatus, type SignInResult } from '@shared/huli-signin'
import { currentPrimitives } from '@shared/remote/primitives'
import { APP_VERSION } from './connection'
import { relayTokens } from './relay'
import { createStore, useSelector } from './select'
import { fromBase64Url, toBase64, type SavedHost } from './store'

const VAULT_ITEM = 'huli.cloud.signin'
// This device only, never in a backup or on another iPhone; readable while locked after the first
// unlock, so a reconnect in the background can still get a relay token.
const VAULT_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
}

/** Form bodies as text, whatever React Native's fetch makes of URLSearchParams. */
const fetchText: AccountFetch = (url, init) =>
  fetch(
    url,
    init.body instanceof URLSearchParams
      ? {
          ...init,
          body: init.body.toString(),
          headers: {
            ...(init.headers as Record<string, string>),
            'content-type': 'application/x-www-form-urlencoded',
          },
        }
      : init,
  )

const accountApi = new AccountApi(ACCOUNT_URL, fetchText)
const cloudApi = new HuliCloudApi(ACCOUNT_URL, fetchText)

export const session = new CloudSession({
  api: accountApi,
  vault: {
    read: () => SecureStore.getItemAsync(VAULT_ITEM, VAULT_OPTIONS),
    write: (text) => SecureStore.setItemAsync(VAULT_ITEM, text, VAULT_OPTIONS),
    clear: () => SecureStore.deleteItemAsync(VAULT_ITEM, VAULT_OPTIONS),
  },
  authenticate: async (url, redirect) => {
    // Its own cookie jar each time: nothing of the sign-in stays in Safari.
    const result = await WebBrowser.openAuthSessionAsync(url, redirect, {
      preferEphemeralSession: true,
    })
    return result.type === 'success' ? result.url : null
  },
  random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
  sha256: (bytes) => currentPrimitives().sha256(bytes),
  info: {
    name: Device.deviceName ?? Device.modelName ?? 'iPhone',
    os: `iOS ${Device.osVersion ?? ''}`.trim(),
    arch: Device.modelName ?? 'iPhone',
    version: APP_VERSION,
  },
})

let status: CloudStatus = { state: 'signed-out', reason: null }
let loaded = false
const listeners = new Set<() => void>()

session.onChanged((next) => {
  status = next
  for (const listener of listeners) listener()
})

/** Reads the sign-in from the Keychain once; the relay gets its tokens from then on. */
export function startCloud(): void {
  if (loaded) return
  loaded = true
  relayTokens(() => session.relayToken())
  void session.load()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useCloudStatus(): CloudStatus {
  return useSyncExternalStore(subscribe, () => status)
}

/** Huli: `register` signs up with an invite code first, then signs in the same way. */
export function signIn(mode?: 'register'): Promise<SignInResult> {
  return session.signIn(mode)
}

export function signOut(): Promise<void> {
  return session.signOut()
}

/** The account's web page, where devices are managed and how passwords are changed is said. */
export const ACCOUNT_PAGE_URL = `${ACCOUNT_URL}${ACCOUNT_PAGE_PATH}`

export const SIGN_IN_FAILURES: Record<Exclude<SignInResult, 'signed-in' | 'cancelled'>, string> = {
  denied: '登录被取消了。',
  failed: '登录没有完成，请再试一次。',
  network: '连不上 Kite Cloud，检查网络后再试。',
}

/** The account's devices and computers now; null while signed out. */
export function listAccount(): Promise<AccountDevices | null> {
  return session.withAccess((token) => cloudApi.devices(token))
}

export type DevicesState =
  | { state: 'loading' }
  | { state: 'ready'; devices: AccountDevices }
  | { state: 'failed' }
  | { state: 'signed-out' }

/** What every screen that lists the account shows, read once for all of them. */
const devicesStore = createStore<{ list: DevicesState; at: number }>({
  list: { state: 'loading' },
  at: 0,
})
/** A list read this recently is shown again as it is when another screen opens. */
const FRESH_MS = 15_000
let reading: Promise<void> | null = null

/** Reads the account's devices and computers again, once at a time. */
export function reloadAccount(): Promise<void> {
  reading ??= (async () => {
    try {
      const devices = session.status().state === 'signed-in' ? await listAccount() : null
      const list: DevicesState =
        session.status().state !== 'signed-in'
          ? { state: 'signed-out' }
          : devices
            ? { state: 'ready', devices }
            : { state: 'failed' }
      devicesStore.set({ list, at: Date.now() })
    } catch {
      devicesStore.set({ list: { state: 'failed' }, at: Date.now() })
    } finally {
      reading = null
    }
  })()
  return reading
}

const selectList = (value: { list: DevicesState }) => value.list

/** The account's devices and computers, read when a screen shows them, and on `reload`. */
export function useAccountDevices(): { list: DevicesState; reload(): Promise<void> } {
  const cloud = useCloudStatus()
  const list = useSelector(devicesStore, selectList)
  useEffect(() => {
    if (cloud.state === 'signing-in') return
    const { list: shown, at } = devicesStore.get()
    const stale = Date.now() - at > FRESH_MS
    const wrong = (cloud.state === 'signed-in') !== (shown.state !== 'signed-out')
    if (stale || wrong || shown.state === 'failed') void reloadAccount()
  }, [cloud])
  return { list, reload: reloadAccount }
}

/** Signs out one of the account's devices, or all but this phone. */
export async function revokeDevices(which: { device: string } | { others: true }): Promise<void> {
  const revoked = await session.withAccess((token) => cloudApi.revoke(token, which))
  if (revoked === null) throw new Error('没有登录 Kite Cloud。')
  await reloadAccount()
}

/** Whether a computer of the account is one this phone is paired with. */
export function pairedWith(computer: AccountComputer, hosts: SavedHost[]): SavedHost | null {
  if (!computer.key) return null
  const key = toBase64(fromBase64Url(computer.key))
  return hosts.find((h) => h.hostKey === key || h.relay?.id === computer.id) ?? null
}
