// The Android build's update notice. CI puts latest.json beside Huli.apk on Huli's own update
// channel; the app compares its versionCode with this build's and, when newer, offers the APK.
// iOS updates through TestFlight, so none of this runs there.

import { useSyncExternalStore } from 'react'
import { AppState, Linking, Platform } from 'react-native'
import * as Application from 'expo-application'
import * as SecureStore from 'expo-secure-store'
import { RELEASES_URL, UPDATE_CHANNEL_READY } from '@shared/updates'

export interface Release {
  version: string
  versionCode: number
  url: string
}

export interface UpdateSnapshot {
  checkedAt: number
  /** A release newer than this build, or null. */
  latest: Release | null
  /** The version whose banner the user closed. */
  dismissed: string | null
}

// A build without the channel's path (tools/huli/update-path.mjs) never checks.
export const UPDATES_SUPPORTED = Platform.OS === 'android' && UPDATE_CHANNEL_READY

const ITEM = 'huli.update'
const INTERVAL = 6 * 60 * 60 * 1000
const TIMEOUT = 15_000
const MANIFEST = `${RELEASES_URL}/android/latest.json`

let snapshot: UpdateSnapshot = { checkedAt: 0, latest: null, dismissed: null }
let loading: Promise<void> | null = null
let running: Promise<Release | null> | null = null
const listeners = new Set<() => void>()

function parse(value: unknown): Release | null {
  if (typeof value !== 'object' || value === null) return null
  const { version, versionCode, url } = value as Record<string, unknown>
  if (typeof version !== 'string' || typeof versionCode !== 'number') return null
  if (!Number.isInteger(versionCode) || typeof url !== 'string') return null
  if (!url.startsWith(`${RELEASES_URL}/`)) return null
  return { version, versionCode, url }
}

function newer(release: Release | null): Release | null {
  const code = Number(Application.nativeBuildVersion)
  return release && Number.isInteger(code) && release.versionCode > code ? release : null
}

function update(next: Partial<UpdateSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
  void SecureStore.setItemAsync(ITEM, JSON.stringify(snapshot)).catch(() => {})
}

function load(): Promise<void> {
  loading ??= SecureStore.getItemAsync(ITEM)
    .then((text) => {
      if (!text) return
      const saved = JSON.parse(text) as Partial<UpdateSnapshot>
      snapshot = {
        checkedAt: typeof saved.checkedAt === 'number' ? saved.checkedAt : 0,
        latest: newer(parse(saved.latest)),
        dismissed: typeof saved.dismissed === 'string' ? saved.dismissed : null,
      }
      for (const listener of listeners) listener()
    })
    .catch(() => {})
  return loading
}

async function fetchRelease(): Promise<Release> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT)
  try {
    const response = await fetch(MANIFEST, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: abort.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const release = parse(await response.json())
    if (!release) throw new Error('Malformed latest.json')
    return release
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves with the newer release, or null when this build is the latest; rejects when unsure. */
export function checkForUpdate(): Promise<Release | null> {
  running ??= load()
    .then(fetchRelease)
    .then(
      (release) => {
        const latest = newer(release)
        update({ checkedAt: Date.now(), latest })
        return latest
      },
      (error: unknown) => {
        update({ checkedAt: Date.now() })
        throw error
      },
    )
    .finally(() => {
      running = null
    })
  return running
}

/** Checks at start and on each return to the foreground, at most once every six hours. */
export function watchUpdates(): () => void {
  if (!UPDATES_SUPPORTED) return () => {}
  const checkIfDue = () =>
    void load()
      .then(() => (Date.now() - snapshot.checkedAt >= INTERVAL ? checkForUpdate() : null))
      .catch(() => {})
  checkIfDue()
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') checkIfDue()
  })
  return () => subscription.remove()
}

export function dismissUpdate(version: string): void {
  update({ dismissed: version })
}

export function openUpdate(release: Release): void {
  // The browser downloads the APK and Android's installer accepts it only if it is signed with
  // this app's key, so the download needs no signature check here.
  void Linking.openURL(release.url).catch(() => {})
}

export function useUpdate(): UpdateSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
  )
}
