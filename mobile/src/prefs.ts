// The phone's own preferences, kept in the Keychain beside the pairing: the theme, the app lock and
// whether notifications show what they are about. Read once at start; every screen subscribes.

import { useSyncExternalStore } from 'react'
import { Appearance } from 'react-native'
import * as SecureStore from 'expo-secure-store'

export type ThemePref = 'system' | 'light' | 'dark'

/** Seconds away from the app before it locks; 0 locks as soon as it leaves. */
export const LOCK_DELAYS = [0, 60, 300, 900, 3600] as const
export type LockDelay = (typeof LOCK_DELAYS)[number]

export interface Prefs {
  theme: ThemePref
  lock: boolean
  lockAfter: LockDelay
  /** Notifications say only what kind of thing happened, never a session's title or text. */
  hidePreviews: boolean
  /** Live Activities on the Lock Screen and in the Dynamic Island (iOS). */
  liveActivities: boolean
  /** A session's sub-agent list keeps the ones that finished, as the desktop's switch does. */
  showFinishedSubagents: boolean
}

const DEFAULTS: Prefs = {
  theme: 'system',
  lock: false,
  lockAfter: 0,
  hidePreviews: false,
  liveActivities: true,
  showFinishedSubagents: false,
}

const ITEM = 'huli.prefs'
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
}

let prefs: Prefs = DEFAULTS
let loaded = false
const listeners = new Set<() => void>()
const waiting: (() => void)[] = []

function parse(text: string | null): Prefs {
  if (!text) return DEFAULTS
  try {
    const raw = JSON.parse(text) as Partial<Prefs>
    return {
      theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
      lock: raw.lock === true,
      lockAfter: LOCK_DELAYS.includes(raw.lockAfter as LockDelay)
        ? (raw.lockAfter as LockDelay)
        : 0,
      hidePreviews: raw.hidePreviews === true,
      liveActivities: raw.liveActivities !== false,
      showFinishedSubagents: raw.showFinishedSubagents === true,
    }
  } catch {
    return DEFAULTS
  }
}

function applyTheme(theme: ThemePref): void {
  // Native views (blur, alerts, the keyboard) follow the override as well as the palette does.
  Appearance.setColorScheme(theme === 'system' ? 'auto' : theme)
}

function publish(next: Prefs): void {
  prefs = next
  for (const listener of listeners) listener()
}

void SecureStore.getItemAsync(ITEM, OPTIONS)
  .catch(() => null)
  .then((text) => {
    const read = parse(text)
    if (read.theme !== 'system') applyTheme(read.theme)
    loaded = true
    publish(read)
    for (const resolve of waiting.splice(0)) resolve()
  })

/** Resolves once the stored preferences have been read. */
export function prefsReady(): Promise<void> {
  return loaded ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve))
}

export function getPrefs(): Prefs {
  return prefs
}

export function prefsLoaded(): boolean {
  return loaded
}

export function setPrefs(change: Partial<Prefs>): void {
  const next = { ...prefs, ...change }
  if (change.theme !== undefined && change.theme !== prefs.theme) applyTheme(change.theme)
  publish(next)
  void SecureStore.setItemAsync(ITEM, JSON.stringify(next), OPTIONS).catch(() => {})
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, () => prefs)
}
