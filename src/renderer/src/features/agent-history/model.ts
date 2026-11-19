// Huli: the import from the agents' grouping, search and quick picks. Huli's own; see
// tools/huli/README.md.

import type { AgentHistoryPage, AgentHistorySession } from '@shared/agent-history'
import type { AgentId } from '@shared/agents'
import { basename } from '@renderer/lib/format'

/** One agent's listing as it loads, page by page. */
export interface HistoryList {
  sessions: AgentHistorySession[]
  hidden: AgentHistoryPage['hidden']
  /** More pages are coming. */
  loading: boolean
  error: string | null
}

export interface HistoryGroup {
  key: string
  path: string
  name: string
  /** Newest first. */
  sessions: AgentHistorySession[]
  latest: number
}

export const DAY_MS = 24 * 60 * 60 * 1000

/** Paths compared as the folder they name: a drive letter's case-insensitively, as on Windows. */
export function folderKey(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  return /^[A-Za-z]:([\\/]|$)|^\\\\/.test(trimmed)
    ? trimmed.replace(/\//g, '\\').toLowerCase()
    : trimmed
}

export function sessionKey(agentId: AgentId, acpSessionId: string): string {
  return `${agentId}\n${acpSessionId}`
}

/**
 * One that may be chosen: not imported yet, or Huli: a fork of an imported one that another folder
 * carried on, and its folder still there.
 */
export function selectable(session: AgentHistorySession): boolean {
  return (!session.imported || session.outside === 'fork') && !session.missing
}

export function matches(session: AgentHistorySession, query: string): boolean {
  if (query === '') return true
  const q = query.toLocaleLowerCase()
  return (
    (session.title ?? '').toLocaleLowerCase().includes(q) ||
    session.cwd.toLocaleLowerCase().includes(q)
  )
}

/** The sessions under their folders, the folder used last first. */
export function groupsOf(sessions: readonly AgentHistorySession[]): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>()
  for (const session of sessions) {
    const key = folderKey(session.cwd)
    let group = groups.get(key)
    if (!group) {
      group = { key, path: session.cwd, name: basename(session.cwd), sessions: [], latest: 0 }
      groups.set(key, group)
    }
    group.sessions.push(session)
    group.latest = Math.max(group.latest, session.updatedAt ?? 0)
  }
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }
  return [...groups.values()].sort((a, b) => b.latest - a.latest)
}

/** The keys of the sessions that may be chosen and last changed within `days`. */
export function recentKeys(
  agentId: AgentId,
  sessions: readonly AgentHistorySession[],
  days: number,
  now: number,
): string[] {
  return sessions
    .filter((s) => selectable(s) && (s.updatedAt ?? 0) >= now - days * DAY_MS)
    .map((s) => sessionKey(agentId, s.acpSessionId))
}

export function withKeys(
  set: ReadonlySet<string>,
  keys: readonly string[],
  on: boolean,
): Set<string> {
  const next = new Set(set)
  for (const key of keys) {
    if (on) next.add(key)
    else next.delete(key)
  }
  return next
}

/** Runs `run` on each item, `limit` at a time, until `going` turns false. */
export async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  going: () => boolean,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length && going()) await run(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
