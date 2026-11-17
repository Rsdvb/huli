// Where a notification leads: what the extension (or this app, for its own notices) left in its
// data, and the screen that shows it. A notification opened before the paired computer is loaded,
// as one that launched the app, waits here until the bridge says the screens are ready; the app
// lock's cover stays over whatever it opens until the user unlocks.

import { router, type Href } from 'expo-router'
import type { PushActions, PushQuestion } from '@shared/remote/push'

/** A notification's data, as the Notification Service Extension writes it. */
export interface NotificationData {
  /** The host's id. */
  host: string | null
  kind: string | null
  tag: string | null
  sessionId: string | null
  /** An entry of the session to show, when the notification names one. */
  entryId: string | null
  requestId: string | null
  actions: PushActions | null
  question: PushQuestion | null
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

function answerOf(value: unknown): { optionId: string; label: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const { optionId, label } = value as Record<string, unknown>
  return typeof optionId === 'string' && typeof label === 'string' ? { optionId, label } : null
}

function actionsOf(value: unknown): PushActions | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const allow = answerOf(record.allow)
  if (!allow) return null
  const deny = answerOf(record.deny)
  return deny ? { allow, deny } : { allow }
}

function questionOf(value: unknown): PushQuestion | null {
  if (typeof value !== 'object' || value === null) return null
  const { choices, text: own } = value as Record<string, unknown>
  if (!Array.isArray(choices) || !choices.every((choice) => typeof choice === 'string')) return null
  return { choices: choices as string[], text: own === true }
}

/** A notification's data, or null for one that is not Huli's. */
export function notificationData(raw: unknown): NotificationData | null {
  if (typeof raw !== 'object' || raw === null) return null
  const data = raw as Record<string, unknown>
  const host = text(data.host)
  const kind = text(data.kind)
  if (!host && !kind) return null
  return {
    host,
    kind,
    tag: text(data.tag),
    sessionId: text(data.sessionId),
    entryId: text(data.entryId),
    requestId: text(data.requestId),
    actions: actionsOf(data.actions),
    question: questionOf(data.question),
  }
}

/** The screen a notification opens; null leaves the app where it is. */
export function routeOf(data: NotificationData): Href | null {
  if (data.sessionId) {
    return {
      pathname: '/session/[id]',
      params: data.entryId ? { id: data.sessionId, entry: data.entryId } : { id: data.sessionId },
    }
  }
  if (data.kind === 'routine-paused') return '/routines'
  return null
}

let pending: NotificationData | null = null
let ready = false

function flush(): void {
  if (!ready || !pending) return
  const route = routeOf(pending)
  pending = null
  if (route) router.push(route)
}

/** Opens what the notification is about, now or once the screens are ready. */
export function openNotification(data: NotificationData): void {
  pending = data
  flush()
}

/** Whether the paired computer's screens are there to open a notification on. */
export function setOpenReady(value: boolean): void {
  ready = value
  flush()
}
