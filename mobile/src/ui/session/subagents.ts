// What a sub-agent's thread says about its work, for its row in its parent's thread: how many tool
// calls it made and how long its latest run took. Ported from the desktop's subagent/progress.ts:
// read once per state of the sub-agent, a running one at most every few seconds, and kept for the
// rows that show it.
//
// Huli: a computer that names lean threads tells the rows' numbers with `sessions.stats`, the rows
// that mount together in one request. An older one is not asked: reading every row's whole thread
// at once, screenshots and all, pulled 70 MB in a burst and froze the phone, and even a latest
// page of a sub-agent that took screenshots runs to megabytes there. Its rows show what their
// summaries say, a running one the time since it started.

import { useEffect, useSyncExternalStore } from 'react'
import type { SessionStats, SessionSummary } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import { LEAN_THREADS_FEATURE } from '@shared/remote/protocol'
import type { StopReason } from '@shared/thread'

export interface SubagentDigest {
  /** Its tool calls; null while the start of its thread was not read. */
  tools: number | null
  /** How long its latest run took, from that run's end. */
  durationMs: number | null
  stopReason: StopReason | null
}

export function subagentRunning(child: Pick<SessionSummary, 'status'>): boolean {
  return (
    child.status === 'running' ||
    child.status === 'awaiting_permission' ||
    child.status === 'starting'
  )
}

// A running sub-agent changes often: its thread is read again at most this often.
const RUNNING_EVERY = 8000
const KEPT = 100

const reads = new Map<string, { key: string; digest: SubagentDigest }>()
const reading = new Set<string>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function keyOf(child: Pick<SessionSummary, 'status' | 'updatedAt'>): string {
  const at = subagentRunning(child) ? Math.floor(child.updatedAt / RUNNING_EVERY) : child.updatedAt
  return `${child.status}:${at}`
}

function keep(id: string, key: string, digest: SubagentDigest): void {
  reads.delete(id)
  reads.set(id, { key, digest })
  for (const old of reads.keys()) {
    if (reads.size <= KEPT) break
    reads.delete(old)
  }
}

function told(): void {
  for (const listener of listeners) listener()
}

/** Huli: the rows waiting for the next `sessions.stats`, by id with the state they were read in. */
let asked = new Map<string, string>()
let askTimer: ReturnType<typeof setTimeout> | null = null
// Rows that mount together, as a thread's page does, share one request.
const ASK_AFTER = 50
const MOST_ASKED = 100

function askStats(link: HostLink): void {
  askTimer = null
  const batch = asked
  asked = new Map()
  const ids = [...batch.keys()].slice(0, MOST_ASKED)
  for (const id of batch.keys()) if (!ids.includes(id)) reading.delete(id)
  if (ids.length === 0) return
  void (
    link.request('sessions.stats', { sessionIds: ids }) as Promise<Record<string, SessionStats>>
  )
    .then((stats) => {
      for (const id of ids) {
        const found = stats[id]
        if (found) keep(id, batch.get(id)!, found)
      }
      told()
    })
    .catch(() => {})
    .finally(() => {
      for (const id of ids) reading.delete(id)
    })
}

/** Whether the computer answers `sessions.stats`. */
function readsStats(link: HostLink): boolean {
  const state = link.state
  return state.kind === 'connected' && state.welcome.features.includes(LEAN_THREADS_FEATURE)
}

function read(link: HostLink, child: Pick<SessionSummary, 'id' | 'status' | 'updatedAt'>): void {
  const key = keyOf(child)
  if (reads.get(child.id)?.key === key || reading.has(child.id)) return
  if (!readsStats(link)) return
  reading.add(child.id)
  asked.set(child.id, key)
  askTimer ??= setTimeout(() => askStats(link), ASK_AFTER)
}

/** Huli: forgets the numbers read, as when the system runs short of memory. */
export function dropSubagentReads(): void {
  reads.clear()
  told()
}

/**
 * The sub-agents a session's badge lists: those running, the latest started first, then with
 * `showFinished` the others, the latest finished first. Ported from the desktop's subagents.ts.
 */
export function listedSubagents(
  subagents: readonly SessionSummary[],
  showFinished: boolean,
): SessionSummary[] {
  const running = subagents.filter(subagentRunning).sort((a, b) => b.createdAt - a.createdAt)
  if (!showFinished) return running
  const finished = subagents
    .filter((subagent) => !subagentRunning(subagent))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return [...running, ...finished]
}

let version = 0
listeners.add(() => {
  version++
})

/** The digests of several sub-agents at once, for a list of them such as the badge's menu. */
export function useSubagentDigests(
  link: HostLink,
  children: readonly SessionSummary[],
  connected: boolean,
): (id: string) => SubagentDigest | null {
  const keys = children.map((child) => `${child.id}:${child.status}:${child.updatedAt}`).join(',')
  useEffect(() => {
    if (!connected) return
    for (const child of children) read(link, child)
    // keys stands for the children's ids and states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, connected, keys])
  useSyncExternalStore(subscribe, () => version)
  return (id) => reads.get(id)?.digest ?? null
}

/** The digest of a sub-agent's thread, read when its row shows and again as it changes. */
export function useSubagentDigest(
  link: HostLink,
  child: SessionSummary | undefined,
  connected: boolean,
): SubagentDigest | null {
  const id = child?.id
  const status = child?.status
  const updatedAt = child?.updatedAt
  useEffect(() => {
    if (!connected || !id || !status || updatedAt === undefined) return
    read(link, { id, status, updatedAt })
  }, [link, connected, id, status, updatedAt])
  return useSyncExternalStore(subscribe, () => (id ? (reads.get(id)?.digest ?? null) : null))
}
