// The buttons on Huli's notifications and what pressing one does. A waiting request offers 允许 and
// 拒绝 when the computer sent its one-time answers, a question offers its choices and 回复…, and a
// finished turn offers 回复… and 打开. The answering buttons run without bringing the app to the
// front, after the phone is unlocked: the app connects to the computer, sends the answer, and
// leaves a notice of how it went, which opens the session when it failed.
//
// The categories with fixed buttons are registered here; a question's buttons are its own, so the
// Notification Service Extension registers its category as it opens the notification, with the
// same action identifiers (plugins/notification-service/NotificationService.swift).

import * as Notifications from 'expo-notifications'
import { getPrefs, prefsReady } from '../prefs'
import { connectedLink } from './live-link'
import type { NotificationData } from './open'

export const ACTION = {
  allow: 'allow',
  deny: 'deny',
  reply: 'reply',
  open: 'open',
} as const

/** A question's choice: this and its position. */
export const CHOICE_ACTION = 'choice.'

export const CATEGORY = {
  /** A request with its one-time allow and deny. */
  permission: 'huli.permission',
  /** A request with a one-time allow and no deny. */
  allowOnly: 'huli.permission.allow',
  turnEnded: 'huli.turn',
} as const

/** How long an answer waits for the computer, within the time the system gives the app. */
const CONNECT_MS = 15_000
const REQUEST_MS = 10_000

const allow: Notifications.NotificationAction = {
  identifier: ACTION.allow,
  buttonTitle: '允许',
  options: { opensAppToForeground: false, isAuthenticationRequired: true },
}

const deny: Notifications.NotificationAction = {
  identifier: ACTION.deny,
  buttonTitle: '拒绝',
  options: { opensAppToForeground: false, isDestructive: true },
}

const reply: Notifications.NotificationAction = {
  identifier: ACTION.reply,
  buttonTitle: '回复…',
  textInput: { submitButtonTitle: '发送', placeholder: '接着说点什么' },
  options: { opensAppToForeground: false, isAuthenticationRequired: true },
}

const open: Notifications.NotificationAction = {
  identifier: ACTION.open,
  buttonTitle: '打开',
  options: { opensAppToForeground: true },
}

let registered: Promise<void> | null = null

/**
 * Registers the categories once per launch. One at a time: expo-notifications reads the set it
 * changes once and keeps it, so calls side by side would drop each other's category.
 */
export function registerCategories(): Promise<void> {
  registered ??= (async () => {
    await Notifications.setNotificationCategoryAsync(CATEGORY.permission, [allow, deny])
    await Notifications.setNotificationCategoryAsync(CATEGORY.allowOnly, [allow])
    await Notifications.setNotificationCategoryAsync(CATEGORY.turnEnded, [reply, open])
  })().catch(() => {
    registered = null
  })
  return registered
}

interface Answer {
  method: 'permissions.respond' | 'sessions.queue'
  params: Record<string, unknown>
  /** The notice's title once it went. */
  done: string
}

/** What pressing the button sends; null for one that sends nothing, as an empty reply. */
function answerOf(action: string, typed: string, data: NotificationData): Answer | null {
  const { sessionId, requestId, actions, question } = data
  if (!sessionId) return null
  const words = typed.trim()
  if (data.kind === 'turn-ended') {
    if (action !== ACTION.reply || !words) return null
    return {
      method: 'sessions.queue',
      params: { sessionId, content: [{ type: 'text', text: words }] },
      done: '已发送',
    }
  }
  if (data.kind !== 'permission' || !requestId) return null
  const respond = (answer: Record<string, unknown>, done: string): Answer => ({
    method: 'permissions.respond',
    params: { sessionId, requestId, ...answer },
    done,
  })
  if (action === ACTION.allow && actions)
    return respond({ optionId: actions.allow.optionId }, '已允许')
  if (action === ACTION.deny && actions?.deny) {
    return respond({ optionId: actions.deny.optionId }, '已拒绝')
  }
  if (action.startsWith(CHOICE_ACTION) && question) {
    const index = Number(action.slice(CHOICE_ACTION.length))
    const label = Number.isInteger(index) ? question.choices[index] : undefined
    if (label === undefined) return null
    return respond({ answers: [{ question: 0, choices: [index] }] }, `已回答：${label}`)
  }
  if (action === ACTION.reply && question?.text && words) {
    return respond({ answers: [{ question: 0, choices: [], text: words }] }, '已回答')
  }
  return null
}

function failure(error: unknown): { title: string; body: string } {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: { reason?: unknown } }
  if (code === 'not_found') {
    return {
      title: '已经处理过了',
      body:
        data?.reason === 'already_answered'
          ? '这个请求已经在别处回答过了。'
          : '这个请求已经结束了。点开看看。',
    }
  }
  if (error instanceof Error && ['no link', 'not connected', 'stopped'].includes(error.message)) {
    return { title: '没能发送，点开处理', body: '没有连上电脑。' }
  }
  return { title: '没能发送，点开处理', body: '电脑没有收下这个回答。' }
}

/** The notice of how an answer went, in place of the notification it answered. */
async function notice(
  data: NotificationData,
  identifier: string,
  content: { title: string; body: string; quiet: boolean },
): Promise<void> {
  await Notifications.dismissNotificationAsync(identifier).catch(() => {})
  await Notifications.scheduleNotificationAsync({
    identifier: `huli.result.${identifier}`,
    content: {
      title: content.title,
      body: content.body,
      sound: content.quiet ? false : 'default',
      ...(content.quiet ? { interruptionLevel: 'passive' as const } : {}),
      // Tapping it opens the session, never answers again.
      data: { host: data.host, kind: 'answered', sessionId: data.sessionId },
      ...(data.host && data.sessionId
        ? { threadIdentifier: `${data.host}:${data.sessionId}` }
        : {}),
    },
    trigger: null,
  }).catch(() => {})
}

/** Sends what a pressed button says, then leaves a notice of how it went. */
export async function answerFromNotification(
  response: Notifications.NotificationResponse,
  data: NotificationData,
): Promise<void> {
  const answer = answerOf(response.actionIdentifier, response.userText ?? '', data)
  if (!answer) return
  const { identifier, content } = response.notification.request
  await prefsReady()
  const hidden = getPrefs().hidePreviews
  try {
    const link = await connectedLink(CONNECT_MS)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), REQUEST_MS)
    try {
      await link.request(answer.method, answer.params, abort.signal)
    } finally {
      clearTimeout(timer)
    }
    const title = !hidden && content.title ? content.title : 'Huli'
    await notice(data, identifier, { title: answer.done, body: title, quiet: true })
  } catch (error) {
    await notice(data, identifier, { ...failure(error), quiet: false })
  }
}
