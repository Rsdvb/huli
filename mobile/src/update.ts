// The phone's update notice. CI puts latest.json on Huli's own update channel, in android/ for the
// APK and in ios/ for the build signed for the team's registered iPhones (ad hoc); the app compares
// its build number with the release's and, when newer, offers it. On iOS only a build that carries
// a device profile (ad hoc, or development) takes it: TestFlight's and the App Store's carry none
// and update there.

import { useSyncExternalStore } from 'react'
import { AppState, Platform } from 'react-native'
import * as Application from 'expo-application'
import * as SecureStore from 'expo-secure-store'
import { RELEASES_URL, UPDATE_CHANNEL_READY } from '@shared/updates'
import { openUrl } from './system/openUrl'

export interface Release {
  version: string
  /** Android's versionCode, iOS's CFBundleVersion: the run number of the build that made it. */
  build: number
  /** Android: the APK. iOS: the manifest an itms-services link installs from. */
  url: string
}

export interface UpdateSnapshot {
  checkedAt: number
  /** A release newer than this build, or null. */
  latest: Release | null
  /** The version whose banner the user closed. */
  dismissed: string | null
}

const IOS = Platform.OS === 'ios'
// A build without the channel's path (tools/huli/update-path.mjs) never checks.
const CHANNEL = UPDATE_CHANNEL_READY && (Platform.OS === 'android' || IOS)

const ITEM = 'huli.update'
const INTERVAL = 6 * 60 * 60 * 1000
const TIMEOUT = 15_000
const MANIFEST = `${RELEASES_URL}/${IOS ? 'ios' : 'android'}/latest.json`

let snapshot: UpdateSnapshot = { checkedAt: 0, latest: null, dismissed: null }
// iOS learns it from the build's profile, a moment after start.
let supported = CHANNEL && !IOS
let probing: Promise<boolean> | null = null
let loading: Promise<void> | null = null
let running: Promise<Release | null> | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether this build installs its updates from the channel. */
function probe(): Promise<boolean> {
  probing ??=
    CHANNEL && IOS
      ? Application.getIosApplicationReleaseTypeAsync().then(
          (type) => {
            const { AD_HOC, DEVELOPMENT } = Application.ApplicationReleaseType
            supported = type === AD_HOC || type === DEVELOPMENT
            if (supported) notify()
            return supported
          },
          () => false,
        )
      : Promise.resolve(supported)
  return probing
}

function release(version: unknown, build: unknown, url: unknown): Release | null {
  if (typeof version !== 'string' || typeof build !== 'number' || !Number.isInteger(build)) {
    return null
  }
  if (typeof url !== 'string' || !url.startsWith(`${RELEASES_URL}/`)) return null
  return { version, build, url }
}

/** Android's latest.json names the APK; iOS's, `{ version, build, manifest }`, the manifest. */
function fromChannel(value: unknown): Release | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  return IOS ? release(v.version, v.build, v.manifest) : release(v.version, v.versionCode, v.url)
}

function fromSaved(value: unknown): Release | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  return release(v.version, v.build, v.url)
}

function newer(release: Release | null): Release | null {
  const code = Number(Application.nativeBuildVersion)
  return release && Number.isInteger(code) && release.build > code ? release : null
}

function update(next: Partial<UpdateSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  notify()
  void SecureStore.setItemAsync(ITEM, JSON.stringify(snapshot)).catch(() => {})
}

function load(): Promise<void> {
  loading ??= SecureStore.getItemAsync(ITEM)
    .then((text) => {
      if (!text) return
      const saved = JSON.parse(text) as Partial<UpdateSnapshot>
      snapshot = {
        checkedAt: typeof saved.checkedAt === 'number' ? saved.checkedAt : 0,
        latest: newer(fromSaved(saved.latest)),
        dismissed: typeof saved.dismissed === 'string' ? saved.dismissed : null,
      }
      notify()
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
    const release = fromChannel(await response.json())
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
  if (!CHANNEL) return () => {}
  const checkIfDue = () =>
    void probe()
      .then((yes) => (yes ? load().then(() => snapshot.checkedAt) : null))
      .then((checkedAt) =>
        checkedAt !== null && Date.now() - checkedAt >= INTERVAL ? checkForUpdate() : null,
      )
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
  // Android: the browser downloads the APK, and Android's installer accepts it only if it is signed
  // with this app's key. iOS: the system asks before it installs the IPA the manifest names, and
  // the IPA runs only on a device its profile lists. Neither needs a signature check here.
  const url = IOS
    ? `itms-services://?action=download-manifest&url=${encodeURIComponent(release.url)}`
    : release.url
  openUrl(url)
}

/** Whether this build updates from the channel; on iOS false until its profile is read. */
export function useUpdatesSupported(): boolean {
  return useSyncExternalStore(subscribe, () => supported)
}

export function useUpdate(): UpdateSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}
