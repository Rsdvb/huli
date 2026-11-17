// What a notification is about: what the extension (or this app, for its own notices) left in its
// data, and the deep link that opens it on the computer that sent it (src/links.ts switches to
// that computer first, waits for Face ID and then navigates).

import type { PushActions, PushQuestion } from '@shared/remote/push'
import { openLink, type LinkTarget } from '../links'

/** A notification's data, as the Notification Service Extension writes it. */
export interface NotificationData {
  /** The sending computer's notification id (its relay host id). */
  host: string | null
  kind: string | null
  tag: string | null
  sessionId: string | null
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
    requestId: text(data.requestId),
    actions: actionsOf(data.actions),
    question: questionOf(data.question),
  }
}

function targetOf(data: NotificationData): LinkTarget | null {
  if (data.sessionId) return { kind: 'session', id: data.sessionId }
  if (data.kind === 'routine-paused') return { kind: 'tab', tab: 'routines' }
  return null
}

/** Opens what the notification is about, on the computer that sent it. */
export function openNotification(data: NotificationData): void {
  openLink({ target: targetOf(data), host: data.host })
}
