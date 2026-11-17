// What a sub-agent's thread says about its work, for its row in its parent's thread: how many tool
// calls it made and how long its latest run took. Ported from the desktop's subagent/progress.ts:
// the thread is read whole once per state of the sub-agent, a running one at most every few
// seconds, and kept for the rows that show it.

import { useEffect, useSyncExternalStore } from 'react'
import type { SessionSummary } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import type { SessionSnapshot, StopReason } from '@shared/thread'

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

function read(link: HostLink, child: Pick<SessionSummary, 'id' | 'status' | 'updatedAt'>): void {
  const key = keyOf(child)
  if (reads.get(child.id)?.key === key || reading.has(child.id)) return
  reading.add(child.id)
  void (
    link.request('sessions.snapshot', { sessionId: child.id, from: 0 }) as Promise<SessionSnapshot>
  )
    .then((snapshot) => {
      let tools = 0
      let durationMs: number | null = null
      let stopReason: StopReason | null = null
      for (const entry of snapshot.entries) {
        if (entry.kind === 'tool') tools++
        else if (entry.kind === 'turn_end') {
          durationMs = entry.durationMs
          stopReason = entry.stopReason
        }
      }
      reads.delete(child.id)
      reads.set(child.id, {
        key,
        digest: { tools: snapshot.older === null ? tools : null, durationMs, stopReason },
      })
      for (const id of reads.keys()) {
        if (reads.size <= KEPT) break
        reads.delete(id)
      }
      for (const listener of listeners) listener()
    })
    .catch(() => {})
    .finally(() => reading.delete(child.id))
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
