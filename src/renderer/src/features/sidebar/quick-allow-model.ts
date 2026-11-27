// Huli: 一键允许 from the sidebar's Needs you. A row answers its session's oldest request with
// allow once, and only when that request is a plain one the host does not judge high; 全部允许
// answers as the thread's 全部同意 does (`permissions.respondAll`), leaving the rest for the user.

import { bulkOption, bulkSplit, requestQueue, type QueuedRequest } from '@shared/permission-queue'
import type { ThreadEntry } from '@shared/thread'
import { labelText, toolLabel } from '@renderer/features/session/entries/helpers'

/** What a row's 允许 and 全部允许 would answer in one session, read from its waiting entries. */
export interface QuickAllow {
  sessionId: string
  /** The session's queue, oldest first. */
  queue: readonly QueuedRequest[]
  /** The oldest request, which 允许 allows once with `optionId`. */
  head: QueuedRequest
  optionId: string
  /** What 全部允许 allows once, oldest first, and what it leaves for the user. */
  answered: QueuedRequest[]
  skipped: QueuedRequest[]
}

/** The session's quick allow, or null when its oldest request is not one a click may allow. */
export function quickAllowOf(
  sessionId: string,
  queue: readonly QueuedRequest[],
): QuickAllow | null {
  const head = queue[0]
  const optionId = head ? bulkOption(head, 'allow') : null
  if (!head || !optionId) return null
  return { sessionId, queue, head, optionId, ...bulkSplit(queue, 'allow') }
}

/** The quick allow of a session's waiting entries, as `sessions.requests` gives them. */
export function quickAllowOfEntries(
  sessionId: string,
  entries: readonly ThreadEntry[],
): QuickAllow | null {
  return quickAllowOf(sessionId, requestQueue(entries))
}

/** What is left once `requestIds` were answered: the next request's quick allow, if any. */
export function afterAnswers(
  allow: QuickAllow,
  requestIds: ReadonlySet<string>,
): QuickAllow | null {
  return quickAllowOf(
    allow.sessionId,
    allow.queue.filter((entry) => !requestIds.has(entry.permission.requestId)),
  )
}

/** A request in words, on one line: what it runs, the file it touches or the tool it calls. */
export function requestText(entry: QueuedRequest, projectPath: string): string {
  return (entry.question ?? labelText(toolLabel(entry, projectPath))).split('\n')[0]!.trim()
}
