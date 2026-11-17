// This phone's notifications on the paired computer, over the link (notifications.get and .set in
// src/shared/remote/push.ts): once connected to a host that sends them, it asks the user, gives the
// host this phone's push target, and gives the extension what opens them.

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
import { liveActivityTokens } from '../live/activities'
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
      return '通知：已关闭，可在系统设置中为 Huli 开启'
    case 'signed-out':
      return '通知：电脑未登录 Huli Cloud，暂时收不到'
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
const syncing = new WeakSet<HostLink>()

export async function syncPush(link: HostLink): Promise<void> {
  if (syncing.has(link)) return
  syncing.add(link)
  try {
    await syncOnce(link)
  } finally {
    syncing.delete(link)
  }
}

async function syncOnce(link: HostLink): Promise<void> {
  const state = link.state
  if (state.kind !== 'connected') return
  const { welcome } = state
  if (
    !platform.supported ||
    welcome.protocol < PUSH_VERSION ||
    !welcome.features.includes(PUSH_FEATURE)
  ) {
    return setStatus('unsupported')
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
    return setStatus('off')
  }
  const target = await platform.target()
  if (!target) return setStatus('unsupported')
  const activity = await liveActivityTokens(current.host).catch(() => undefined)
  if (activity) target.activity = activity
  const text = JSON.stringify(target)
  // The computer drops a Live Activity token Apple no longer takes, or one whose activity it ended.
  const activityChanged =
    Boolean(current.target.activityStart) !== Boolean(activity?.start) ||
    Boolean(current.target.activityUpdate) !== Boolean(activity?.update)
  if (!current.target.apns || activityChanged || sent.get(link) !== text) {
    await link.request(NOTIFICATIONS_SET, { target })
    sent.set(link, text)
  }
  setStatus(current.signedIn ? 'on' : 'signed-out')
}

/** Before unpairing: the computer stops sending, and the extension forgets it. */
export async function stopPush(link: HostLink | null): Promise<void> {
  await platform.unshare().catch(() => {})
  setStatus('pending')
  if (!link || link.state.kind !== 'connected') return
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000))
  await Promise.race([link.request(NOTIFICATIONS_SET, { target: null }), timeout]).catch(() => {})
}
