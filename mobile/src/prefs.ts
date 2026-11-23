// The phone's own preferences, kept in the Keychain beside the pairing: the theme, the app lock,
// whether notifications show what they are about, whether plan limits alert, and how the home list
// is shown. Read once at start; every screen subscribes.

import { useSyncExternalStore } from 'react'
import { Appearance, AppState } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { isToolCallView, type ToolCallView } from '@shared/zen-view'

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
  /**
   * 额度提醒: a plan window crossed 90% or ran out, as a notification from the computer, which it
   * is told, and as a banner while the app is in front.
   */
  limitAlerts: boolean
  /** A session's sub-agent list keeps the ones that finished, as the desktop's switch does. */
  showFinishedSubagents: boolean
  /** Home: every paired computer's sessions together, or the active computer's alone. */
  homeScope: HomeScope
  /** Home: sessions in groups by folder and project, or one list by time. */
  homeGrouping: HomeGrouping
  /** Home: archived sessions listed with the others. */
  homeShowArchived: boolean
  /** Home: the project groups shown closed, by key. */
  homeCollapsed: string[]
  /**
   * A session's queued messages shown open or folded to their count, as last chosen; null until
   * then, when a single one shows open and more fold.
   */
  queueOpen: boolean | null
  /** Huli: each session's own choice of how much of its agent's work it shows (简洁视图). */
  threadViews: Record<string, ToolCallView>
}

export type HomeScope = 'all' | 'one'
export type HomeGrouping = 'project' | 'time'

/** The most closed project groups kept. */
const COLLAPSED_KEPT = 200

const DEFAULTS: Prefs = {
  theme: 'system',
  lock: false,
  lockAfter: 0,
  hidePreviews: false,
  liveActivities: true,
  limitAlerts: true,
  showFinishedSubagents: false,
  homeScope: 'one',
  homeGrouping: 'project',
  homeShowArchived: false,
  homeCollapsed: [],
  queueOpen: null,
  threadViews: {},
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
      limitAlerts: raw.limitAlerts !== false,
      showFinishedSubagents: raw.showFinishedSubagents === true,
      homeScope: raw.homeScope === 'all' ? 'all' : 'one',
      homeGrouping: raw.homeGrouping === 'time' ? 'time' : 'project',
      homeShowArchived: raw.homeShowArchived === true,
      homeCollapsed: Array.isArray(raw.homeCollapsed)
        ? raw.homeCollapsed
            .filter((key): key is string => typeof key === 'string')
            .slice(0, COLLAPSED_KEPT)
        : [],
      queueOpen: typeof raw.queueOpen === 'boolean' ? raw.queueOpen : null,
      threadViews: threadViewsOf(raw.threadViews),
    }
  } catch {
    return DEFAULTS
  }
}

/** The kept choices that read, at most the newest few hundred. */
function threadViewsOf(value: unknown): Record<string, ToolCallView> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, ToolCallView] => isToolCallView(entry[1]))
      .slice(-200),
  )
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

/** How long changes gather before they are written; a run of them makes one write. */
const SAVE_AFTER = 400
let saveTimer: ReturnType<typeof setTimeout> | null = null

function saveNow(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  void SecureStore.setItemAsync(ITEM, JSON.stringify(prefs), OPTIONS).catch(() => {})
}

// What is still to be written goes before the app may be suspended.
AppState.addEventListener('change', (next) => {
  if (next !== 'active' && saveTimer) saveNow()
})

export function setPrefs(change: Partial<Prefs>): void {
  const keys = Object.keys(change) as (keyof Prefs)[]
  if (keys.every((key) => Object.is(change[key], prefs[key]))) return
  const next = { ...prefs, ...change }
  if (change.theme !== undefined && change.theme !== prefs.theme) applyTheme(change.theme)
  publish(next)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, SAVE_AFTER)
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Every preference; re-renders on any change. Prefer usePref for one. */
export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, () => prefs)
}

/** One preference; re-renders only when it changes. */
export function usePref<K extends keyof Prefs>(key: K): Prefs[K] {
  return useSyncExternalStore(subscribePrefs, () => prefs[key])
}
