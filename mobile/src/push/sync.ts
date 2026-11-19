// This phone's notifications on the paired computer, over the link (notifications.get and .set in
// src/shared/remote/push.ts): once connected to a host that sends them, it asks the user, gives the
// host this phone's push target and whether it wants plan limit alerts, and gives the extension
// what opens them.

import { useSyncExternalStore } from 'react'
import type { HostLink } from '@shared/remote/link'
import {
  NOTIFICATIONS_GET,
  NOTIFICATIONS_SET,
  PUSH_FEATURE,
  PUSH_VERSION,
  type NotificationsState,
} from '@shared/remote/push'
import { decodeRelayBytes, relayHostId } from '@shared/remote/relay'
import { liveActivityTokens, liveTurnsWanted } from '../live/activities'
import { getPrefs } from '../prefs'
import { loadDeviceKey } from '../store'
import { platform } from './platform'

export type PushStatus =
  /** Not known yet. */
  | 'pending'
  /** This phone or the computer has no notifications. */
  | 'unsupported'
  /** The user turned them off. */
  | 'off'
  /** The computer is not signed in to Huli Cloud, which it sends them through. */
  | 'signed-out'
  | 'on'

let status: PushStatus = 'pending'
const listeners = new Set<() => void>()

function setStatus(next: PushStatus): void {
  if (next === status) return
  status = next
  for (const listener of listeners) listener()
}

/** The status in a line for the user; null while it is not known. */
export function pushStatusText(value: PushStatus): string | null {
  switch (value) {
    case 'pending':
      return null
    case 'unsupported':
      return '通知：暂不可用'
    case 'off':
      return '通知：已关闭，可在系统设置中为纸鸢开启'
    case 'signed-out':
      return '通知：电脑未登录 Kite Cloud，暂时收不到'
    case 'on':
      return '通知：已开启'
  }
}

export function usePushStatus(): PushStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => status,
  )
}

/** The target each link was last given, so a reconnect sends it again only when it changed. */
const sent = new WeakMap<HostLink, string>()
/** The sync running on each link, and the one queued after it. */
const running = new WeakMap<HostLink, Promise<string | null>>()
const queued = new WeakMap<HostLink, Promise<string | null>>()

/**
 * Registers this phone with the computer on `link`. Each paired computer is synced while it is the
 * active one, and keeps the registration after; resolves with the id its notifications carry.
 * Asked while a sync runs, as when a switch flips during one, it runs once more after it with the
 * choices as they are then, so the latest always reaches the computer; callers meanwhile share it.
 */
export function syncPush(link: HostLink): Promise<string | null> {
  const next = queued.get(link)
  if (next) return next
  const current = running.get(link)
  if (current) {
    const after = current
      .catch(() => null)
      .then(() => {
        queued.delete(link)
        return syncPush(link)
      })
    queued.set(link, after)
    return after
  }
  const run = syncOnce(link).finally(() => running.delete(link))
  running.set(link, run)
  return run
}

/**
 * After a notification switch changed (通知中隐藏内容, 额度提醒): the extension keeps quiet at
 * once, connected or not, and a connected computer hears the choices now; one that is away hears
 * them when it next syncs. Rejects with what failed, for the switch to say.
 */
export async function pushChoicesChanged(link: HostLink | null): Promise<void> {
  await platform.setQuiet(getPrefs().hidePreviews)
  if (link?.state.kind === 'connected') await syncPush(link)
}

async function syncOnce(link: HostLink): Promise<string | null> {
  const state = link.state
  if (state.kind !== 'connected') return null
  const { welcome } = state
  if (
    !platform.supported ||
    welcome.protocol < PUSH_VERSION ||
    !welcome.features.includes(PUSH_FEATURE)
  ) {
    setStatus('unsupported')
    return null
  }
  const current = (await link.request(NOTIFICATIONS_GET, undefined)) as NotificationsState
  const hostKey = decodeRelayBytes(current.host.key)
  if (!hostKey || (await relayHostId(hostKey)) !== current.host.id) {
    throw new Error('The host key does not match its id')
  }
  const device = await loadDeviceKey()
  // Without the keys the extension still shows each notification, with a generic text.
  if (device) {
    const quiet = getPrefs().hidePreviews
    await platform.share({ device, host: current.host, quiet }).catch(() => {})
  }

  if ((await platform.permission(true)) !== 'granted') {
    if (current.target.apns) await link.request(NOTIFICATIONS_SET, { target: null })
    sent.delete(link)
    setStatus('off')
    return current.host.id
  }
  const target = await platform.target()
  if (!target) {
    setStatus('unsupported')
    return current.host.id
  }
  // A computer that says whether it has a turn's activity follows turns; an older one does not.
  const follows = typeof current.target.progress === 'boolean'
  const activity = await liveActivityTokens(current.host, follows).catch(() => undefined)
  if (activity) target.activity = activity
  const text = JSON.stringify(target)
  // The computer drops a Live Activity token Apple no longer takes, or one whose activity it ended.
  const activityChanged =
    Boolean(current.target.activityStart) !== Boolean(activity?.start) ||
    Boolean(current.target.activityUpdate) !== Boolean(activity?.update) ||
    (follows && current.target.progress !== Boolean(activity?.progress))
  // Each choice goes only to a computer that answers with it; an older one would ignore it anyway.
  const choices: { limits?: boolean; liveProgress?: boolean } = {}
  // 额度提醒 is the phone's own switch.
  const limits = getPrefs().limitAlerts
  if ('limits' in current.choices && current.choices.limits !== limits) choices.limits = limits
  // It starts an activity for a turn begun while the phone is away only when asked to.
  const liveProgress = follows && liveTurnsWanted()
  if (follows && current.choices.liveProgress !== liveProgress) choices.liveProgress = liveProgress
  const changed = Object.keys(choices).length > 0
  if (!current.target.apns || activityChanged || changed || sent.get(link) !== text) {
    await link.request(NOTIFICATIONS_SET, { target, ...(changed ? { choices } : {}) })
    sent.set(link, text)
  }
  setStatus(current.signedIn ? 'on' : 'signed-out')
  return current.host.id
}

/** Another computer becomes the one shown: its status is not known until it is synced. */
export function resetPushStatus(): void {
  setStatus('pending')
}

/**
 * Before unpairing a computer: it stops sending (when its link is up), and the extension forgets
 * its key (`hostId`, the id its notifications carry). Other computers' notifications go on.
 */
export async function stopPush(link: HostLink | null, hostId: string | null): Promise<void> {
  if (hostId) await platform.unshare(hostId).catch(() => {})
  if (!link || link.state.kind !== 'connected') return
  sent.delete(link)
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000))
  await Promise.race([link.request(NOTIFICATIONS_SET, { target: null }), timeout]).catch(() => {})
}
