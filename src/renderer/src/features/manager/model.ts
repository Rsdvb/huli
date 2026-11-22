// Huli: manager mode in the window: a manager's workers from the session list, what each is doing,
// and the user's controls, which go to the manager's host.

import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import type { ManagerChoices, ManagerSettings } from '@shared/manager'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage, host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'

/**
 * What a worker row shows: working, waiting for the user, held at its plan's limit, done, failed,
 * stopped or idle.
 */
export type WorkerState =
  'starting' | 'running' | 'waiting' | 'limit' | 'done' | 'failed' | 'stopped' | 'idle'

export function workerState(summary: SessionSummary): WorkerState {
  if (summary.permissionCount > 0) return 'waiting'
  // A turn the plan's limit stopped is no failure: it goes on after the reset, or waits for a word.
  if (summary.limitPause) return 'limit'
  if (summary.status === 'starting') return 'starting'
  if (summary.status === 'running' || summary.status === 'awaiting_permission') return 'running'
  const status = summary.worker?.status
  if (status === 'limit' && summary.status !== 'auth_required') return 'limit'
  if (summary.status === 'failed' || summary.status === 'auth_required') return 'failed'
  if (status === 'failed' || status === 'blocked' || status === 'needs_user') return 'failed'
  if (status === 'stopped' || status === 'interrupted') return 'stopped'
  if (status === 'done') return 'done'
  return 'idle'
}

export function isWorking(state: WorkerState): boolean {
  return state === 'starting' || state === 'running' || state === 'waiting'
}

/** The ids of a manager's workers, oldest first; the list changes only when one comes or goes. */
export function useWorkerIds(managerId: string): string[] {
  return useSessionsStore(
    useShallow((s) =>
      Object.values(s.byId)
        .filter((item) => item.worker?.managerId === managerId && item.archivedAt === null)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((item) => item.id),
    ),
  )
}

/** The worker ids under each implementer: reviewers the loop started nest under what they review. */
export function workerTree(
  ids: readonly string[],
  byId: Readonly<Record<string, SessionSummary>>,
): { id: string; children: string[] }[] {
  const nested = new Map<string, string[]>()
  const tops: string[] = []
  for (const id of ids) {
    const parent = byId[id]?.worker?.reviewOf
    if (parent && ids.includes(parent)) nested.set(parent, [...(nested.get(parent) ?? []), id])
    else tops.push(id)
  }
  return tops.map((id) => ({ id, children: nested.get(id) ?? [] }))
}

async function run(action: Promise<unknown>): Promise<boolean> {
  try {
    await action
    return true
  } catch (error) {
    toast(errorMessage(error), undefined, { tone: 'warning' })
    return false
  }
}

export function stopAll(sessionId: string): Promise<boolean> {
  return run(host('manager.stopAll', { sessionId }))
}

export function setPaused(sessionId: string, paused: boolean): Promise<boolean> {
  return run(host('manager.pause', { sessionId, paused }))
}

export function setDetached(sessionId: string, detached: boolean): Promise<boolean> {
  return run(host('manager.detach', { sessionId, detached }))
}

export function moreTurns(sessionId: string): Promise<boolean> {
  return run(host('manager.moreTurns', { sessionId }))
}

export function setManager(
  sessionId: string,
  on: boolean,
  choices?: ManagerChoices,
): Promise<boolean> {
  return run(host('manager.set', { sessionId, on, ...(choices ? { choices } : {}) }))
}

export function stopWorker(sessionId: string): Promise<boolean> {
  return run(host('sessions.cancel', { sessionId }))
}

/** A message from the user to one worker, queued behind what it does; its manager hears of it. */
export function messageWorker(sessionId: string, text: string): Promise<boolean> {
  return run(host('sessions.queue', { sessionId, content: [{ type: 'text', text }] }))
}

/** "412k 令牌 · 约 $1.84", with the turns no price was known for left out of the sum. */
export function usageText(tokens: number, cost: number, unpriced = 0): string {
  const parts = [i18n.t('session:manager.usage.tokens', { count: tokens, tokens: compact(tokens) })]
  if (cost > 0) {
    parts.push(
      unpriced > 0
        ? i18n.t('session:manager.usage.costSome', { cost: dollars(cost) })
        : i18n.t('session:manager.usage.cost', { cost: dollars(cost) }),
    )
  }
  return parts.join(' · ')
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function dollars(amount: number): string {
  return amount >= 10 ? `$${amount.toFixed(0)}` : `$${amount.toFixed(2)}`
}

/** The settings a project's manager uses: its own roster and choices over the settings'. */
export function useManagerSettings(projectPath: string | null): ManagerSettings | null {
  const global = useSettingsStore((s) => s.settings.manager ?? null)
  const own = useProjectsStore((s) =>
    projectPath ? (s.projects.find((p) => p.path === projectPath)?.manager ?? null) : null,
  )
  if (!global) return null
  return own
    ? {
        ...global,
        workers: own.workers,
        reviewerId: own.reviewerId,
        ...(own.autoReview === undefined ? {} : { autoReview: own.autoReview }),
        ...(own.approvals === undefined ? {} : { approvals: own.approvals }),
        ...(own.limits === undefined ? {} : { limits: own.limits }),
      }
    : global
}
