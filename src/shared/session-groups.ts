// Huli: best of N. One prompt runs on several agents or models at once, each run a session in a
// worktree of its own; the runs are one group, and the user keeps the best run's changes. What the
// desktop and the phone both read from a run's summary is here.

import type { ChangedFile } from './git'
import type { AgentId } from './thread'

/** The fewest and most runs a group starts with. */
export const GROUP_RUNS_MIN = 2
export const GROUP_RUNS_MAX = 4

/** The group a run belongs to, as each run's summary carries it. */
export interface SessionGroupRef {
  id: string
  /** The prompt's first line, the same for every run. */
  title: string
  /** How many runs it started with. */
  size: number
  /** The run whose changes the user kept, by session id; null until one is. */
  kept: string | null
}

/** One run to start: an agent and the option values it starts with, such as its model. */
export interface GroupRunStart {
  agentId: AgentId
  options?: Record<string, string | boolean>
}

/** A run's changes against the commit its worktree was cut from, uncommitted ones included. */
export interface RunChanges {
  files: ChangedFile[]
  insertions: number
  deletions: number
  /** Commits on its branch since then. */
  commits: number
  /** More files changed than are listed. */
  truncated: boolean
}

/** What keeping a run did: the merge commit in the project's own checkout. */
export interface KeptRun {
  commit: string
  branch: string
}

/** Where a run stands, as the group's view and the phone's list say it. */
export type RunPhase = 'working' | 'waiting' | 'done' | 'failed'

interface RunFacts {
  status: string
  permissionCount: number
  attention: string
  worktree?: { state: string } | undefined
}

/** A run's phase from its summary: what waits for the user first, then what still works. */
export function runPhase(run: RunFacts): RunPhase {
  if (run.permissionCount > 0 || run.status === 'awaiting_permission') return 'waiting'
  if (run.status === 'auth_required') return 'waiting'
  if (run.status === 'failed' || run.worktree?.state === 'setup-failed') return 'failed'
  if (run.attention === 'error') return 'failed'
  if (run.status === 'running' || run.status === 'starting') return 'working'
  if (run.worktree?.state === 'creating' || run.worktree?.state === 'setup') return 'working'
  return 'done'
}

/** How many runs are in each phase, for a group's one-line summary. */
export function phaseCounts(runs: readonly RunFacts[]): Record<RunPhase, number> {
  const counts: Record<RunPhase, number> = { working: 0, waiting: 0, done: 0, failed: 0 }
  for (const run of runs) counts[runPhase(run)]++
  return counts
}
