// The phone's Live Activities, as the app keeps track of them (modules/huli-live): which of the
// computer's activities came from which computer, and the tokens that computer needs, which reach
// it in the push target of `notifications.set` (src/shared/remote/push.ts): `start` lets it start
// an activity by push while requests wait for the user, `update` reaches the one it started.

import { useSyncExternalStore } from 'react'
import { importKeyPair, type KeyPair } from '@shared/remote/noise'
import { decodeSealed, openPush, type PushTarget } from '@shared/remote/push'
import { decodeRelayBytes, verifyRelaySignature } from '@shared/remote/relay'
import {
  HuliLive,
  readSnapshot,
  type NativeActivity,
  type NativeSnapshot,
} from '../../modules/huli-live'
import { getPrefs } from '../prefs'
import { loadDeviceKey } from '../store'

/** Whether this build can show Live Activities at all: iOS, with the HuliLive module. */
export const LIVE_SUPPORTED = HuliLive !== null

export type ActivityTokens = NonNullable<PushTarget['activity']>

/** Which computer started one of its activities, from its sealed attributes. */
interface Origin {
  host: string
  /** When it started, in ms since the epoch. */
  at: number
  signature: Uint8Array
  signed: Uint8Array
  /** Whether the signature is the host's: unknown until checked against a key the host gave. */
  verified: boolean | null
}

export interface ComputerActivity extends NativeActivity {
  host: string
  at: number
}

let snapshot: NativeSnapshot = readSnapshot()
/** By activity id; null for one this phone's key does not open. */
const origins = new Map<string, Origin | null>()
/** The computer the link is paired with, as notifications.get named it. */
let current: { id: string; key: Uint8Array } | null = null
/** The tokens last handed to the computer, as JSON. */
let given: string | null = null
let device: KeyPair | null = null
const listeners = new Set<() => void>()

export function liveSnapshot(): NativeSnapshot {
  return snapshot
}

export function onLiveChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether the user allows Huli's Live Activities in the system's Settings. */
export function useLiveAllowed(): boolean {
  return useSyncExternalStore(onLiveChange, () => snapshot.enabled)
}

async function deviceKey(): Promise<KeyPair | null> {
  if (device) return device
  const key = await loadDeviceKey()
  device = key ? await importKeyPair(key) : null
  return device
}

async function originOf(sealed: string, key: KeyPair): Promise<Origin | null> {
  const envelope = decodeSealed(sealed)
  if (!envelope) return null
  const opened = await openPush(envelope, key)
  if (!opened) return null
  try {
    const content = JSON.parse(new TextDecoder().decode(opened.body)) as Record<string, unknown>
    if (content.v !== 1 || content.kind !== 'activity' || typeof content.host !== 'string') {
      return null
    }
    return {
      host: content.host,
      at: typeof content.at === 'number' ? content.at : 0,
      signature: opened.signature,
      signed: opened.signed,
      verified: null,
    }
  } catch {
    return null
  }
}

/** Reads the module's snapshot again and opens what it has not seen; then tells the listeners. */
export async function refreshLive(): Promise<void> {
  if (!HuliLive) return
  snapshot = readSnapshot()
  const key = await deviceKey().catch(() => null)
  for (const activity of snapshot.activities) {
    if (activity.local || !activity.sealed || origins.has(activity.id) || !key) continue
    origins.set(activity.id, await originOf(activity.sealed, key).catch(() => null))
  }
  const live = new Set(snapshot.activities.map((activity) => activity.id))
  for (const id of origins.keys()) if (!live.has(id)) origins.delete(id)
  for (const listener of listeners) listener()
}

const running = (activity: NativeActivity): boolean =>
  activity.state === 'active' || activity.state === 'stale'

/** The computer's activities on this phone that its key opens, by computer, newest first. */
export function computerActivities(): { mine: ComputerActivity[]; foreign: NativeActivity[] } {
  const mine: ComputerActivity[] = []
  const foreign: NativeActivity[] = []
  for (const activity of snapshot.activities) {
    if (activity.local || !running(activity)) continue
    const origin = origins.get(activity.id)
    if (origin === undefined) continue
    if (origin === null) foreign.push(activity)
    else mine.push({ ...activity, host: origin.host, at: origin.at })
  }
  mine.sort((a, b) => b.at - a.at)
  return { mine, foreign }
}

/** Activities of the paired computer whose signature checks out with the key it gave. */
async function verifiedFor(host: { id: string; key: Uint8Array }): Promise<ComputerActivity[]> {
  const result: ComputerActivity[] = []
  for (const activity of computerActivities().mine) {
    if (activity.host !== host.id) continue
    const origin = origins.get(activity.id)
    if (!origin) continue
    if (origin.verified === null) {
      origin.verified = await verifyRelaySignature(host.key, origin.signature, origin.signed).catch(
        () => false,
      )
    }
    if (origin.verified) result.push(activity)
  }
  return result
}

/** The paired computer's own activities on this phone, newest first. */
export async function currentActivities(): Promise<ComputerActivity[]> {
  return current ? verifiedFor(current) : []
}

async function tokensFor(host: {
  id: string
  key: Uint8Array
}): Promise<ActivityTokens | undefined> {
  if (!HuliLive || !getPrefs().liveActivities || !snapshot.enabled) return undefined
  const update = (await verifiedFor(host)).find((activity) => activity.token)?.token
  const start = snapshot.startToken
  if (!start && !update) return undefined
  return { ...(start ? { start } : {}), ...(update ? { update } : {}) }
}

/**
 * The Live Activity tokens for the computer's push target, by its id and key as
 * notifications.get gives them; remembers them as given, and the computer as the paired one.
 */
export async function liveActivityTokens(host: {
  id: string
  key: string
}): Promise<ActivityTokens | undefined> {
  const key = decodeRelayBytes(host.key)
  if (!key) return undefined
  current = { id: host.id, key }
  if (snapshot.activities.some((a) => !a.local && a.sealed && !origins.has(a.id))) {
    await refreshLive()
  }
  const tokens = await tokensFor(current)
  given = JSON.stringify(tokens ?? null)
  return tokens
}

/**
 * Ends the computer's activities nothing will update: those sealed to a key this phone no longer
 * has, the paired computer's older ones (it reaches only the newest, as after it restarted), all of
 * them once Live Activities are off, and the paired computer's last one when nothing waits, which
 * it ends by push only once it has the activity's token.
 */
export async function tidyComputerActivities(options: {
  enabled: boolean
  nothingWaits: boolean
}): Promise<void> {
  const live = HuliLive
  if (!live) return
  const end = (id: string): Promise<void> => live.end(id, '', 0).catch(() => {})
  const { mine, foreign } = computerActivities()
  for (const activity of foreign) await end(activity.id)
  if (!options.enabled) {
    for (const activity of mine) await end(activity.id)
    return
  }
  const ours = await currentActivities()
  for (const activity of ours.slice(1)) await end(activity.id)
  if (options.nothingWaits && ours[0]) await end(ours[0].id)
}

/** Whether the computer has the tokens the phone has now; unknown before it was given any. */
export async function tokensGiven(): Promise<boolean> {
  if (!current) return true
  return JSON.stringify((await tokensFor(current)) ?? null) === given
}
