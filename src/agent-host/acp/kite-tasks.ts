// Huli: Kite's own ACP extension for background tasks, which its fake agent speaks so the session
// board can be tried without Claude Code. An agent that declares `kite/tasks: true` in its
// capabilities' `_meta` sends `_kite/tasks` with the session's whole list of background tasks
// and of what holds up a tool call, each list replacing the last, and its running subagents'
// summaries of what they do. It takes requests to stop a task, read its output, move what holds
// up a call to the background and forget ended tasks.

import type { BackgroundTaskView, ForegroundTaskView } from '@shared/thread'
import type { MapperEffect } from '../session-updates'

export const KITE_TASKS_META = 'kite/tasks'

export const KITE_TASKS = {
  list: '_kite/tasks',
  stop: '_kite/tasks/stop',
  output: '_kite/tasks/output',
  background: '_kite/tasks/background',
  clean: '_kite/tasks/clean',
} as const

const MAX_TASKS = 50
const MAX_ID = 256
const MAX_TITLE = 300
const MAX_COMMAND = 2_000
const MAX_SUMMARY = 1_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null

const time = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const KINDS: ReadonlySet<string> = new Set(['shell', 'monitor', 'workflow', 'other'])
const STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'failed', 'stopped'])

function task(value: unknown): BackgroundTaskView | null {
  if (!isRecord(value)) return null
  const id = text(value.id, MAX_ID)
  const title = text(value.title, MAX_TITLE)
  const startedAt = time(value.startedAt)
  if (id === null || title === null || startedAt === null) return null
  if (!KINDS.has(value.kind as string) || !STATUSES.has(value.status as string)) return null
  const command = text(value.command, MAX_COMMAND)
  const progress = text(value.progress, MAX_TITLE)
  const pid = value.pid
  return {
    id,
    kind: value.kind as BackgroundTaskView['kind'],
    title,
    ...(command !== null ? { command } : {}),
    status: value.status as BackgroundTaskView['status'],
    startedAt,
    endedAt: time(value.endedAt),
    summary: text(value.summary, MAX_SUMMARY),
    ...(progress !== null ? { progress } : {}),
    ...(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
  }
}

function held(value: unknown): ForegroundTaskView | null {
  if (!isRecord(value)) return null
  const toolCallId = text(value.toolCallId, MAX_ID)
  const taskId = text(value.taskId, MAX_ID)
  const title = text(value.title, MAX_TITLE)
  const startedAt = time(value.startedAt)
  if (toolCallId === null || taskId === null || title === null || startedAt === null) return null
  if (value.kind !== 'shell' && value.kind !== 'subagent') return null
  return { toolCallId, taskId, kind: value.kind, title, startedAt }
}

function list<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => read(item) ?? []).slice(0, MAX_TASKS)
}

/** A `_kite/tasks` notification as the effects it has on its session; null when malformed. */
export function kiteTasks(params: unknown): { sessionId: string; effects: MapperEffect[] } | null {
  if (!isRecord(params) || typeof params.sessionId !== 'string') return null
  const effects: MapperEffect[] = []
  if (Array.isArray(params.tasks)) effects.push({ kind: 'tasks', tasks: list(params.tasks, task) })
  if (Array.isArray(params.foreground)) {
    effects.push({ kind: 'foreground', tasks: list(params.foreground, held) })
  }
  // A running subagent's one-line summary of what it does, by its session's id.
  for (const item of Array.isArray(params.subagents) ? params.subagents.slice(0, MAX_TASKS) : []) {
    const sessionId = isRecord(item) ? text(item.sessionId, MAX_ID) : null
    const progress = isRecord(item) ? text(item.progress, MAX_TITLE) : null
    if (sessionId !== null && progress !== null) {
      effects.push({ kind: 'subagent', sessionId, progress })
    }
  }
  return { sessionId: params.sessionId, effects }
}
