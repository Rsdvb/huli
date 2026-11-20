// Huli: the import from the agents' grouping, search and quick picks. Huli's own; see
// tools/huli/README.md.

import type { AgentHistoryPage, AgentHistorySession } from '@shared/agent-history'
import type { AgentId, HarnessId } from '@shared/agents'
import { basename } from '@renderer/lib/format'
import { readJson, writeJson } from '@renderer/lib/storage'

/** One agent's listing as it loads, page by page. */
export interface HistoryList {
  sessions: AgentHistorySession[]
  hidden: AgentHistoryPage['hidden']
  /** More pages are coming. */
  loading: boolean
  error: string | null
  /** For another folder's listing: the folder its sessions were read from. */
  source?: string
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

/**
 * Where a listing comes from: an agent's own sessions, keyed by the agent, or Huli: another
 * folder's of the agent's kind.
 */
export function sourceKey(agentId: AgentId, folder: string | null): string {
  return folder === null ? agentId : `${agentId}\n${folder}`
}

/** Huli: the tab of the Claude desktop app's Code sessions, beside the agents' own. */
export const DESKTOP_TAB = 'claude-desktop'

/** Huli: the listing of the Claude desktop app's sessions, which Claude Code agent `agentId` imports. */
export function desktopSourceKey(agentId: AgentId): string {
  return `${agentId}\n${DESKTOP_TAB}`
}

/** Huli: whether a listing's key is one of the agent's: its own, another folder's or the desktop app's. */
export function ofAgent(key: string, agentId: AgentId): boolean {
  return key === agentId || key.startsWith(`${agentId}\n`)
}

/** A session of a listing, `source` an agent's id or a `sourceKey`. */
export function sessionKey(source: string, acpSessionId: string): string {
  return `${source}\n${acpSessionId}`
}

const RECENT_FOLDERS_KEY = 'agentHistory.folders'
const RECENT_FOLDERS = 6

/** Huli: the folders chosen last for an agent kind, the latest first. */
export function recentFolders(harness: HarnessId): string[] {
  const kept = readJson<unknown>(RECENT_FOLDERS_KEY, null)
  const list =
    typeof kept === 'object' && kept !== null ? (kept as Record<string, unknown>)[harness] : null
  return Array.isArray(list)
    ? list.filter((item): item is string => typeof item === 'string').slice(0, RECENT_FOLDERS)
    : []
}

export function rememberFolder(harness: HarnessId, folder: string): string[] {
  const kept = readJson<unknown>(RECENT_FOLDERS_KEY, null)
  const all = typeof kept === 'object' && kept !== null ? (kept as Record<string, unknown>) : {}
  const next = [folder, ...recentFolders(harness).filter((item) => item !== folder)].slice(
    0,
    RECENT_FOLDERS,
  )
  writeJson(RECENT_FOLDERS_KEY, { ...all, [harness]: next })
  return next
}

export function forgetFolder(harness: HarnessId, folder: string): string[] {
  const kept = readJson<unknown>(RECENT_FOLDERS_KEY, null)
  const all = typeof kept === 'object' && kept !== null ? (kept as Record<string, unknown>) : {}
  const next = recentFolders(harness).filter((item) => item !== folder)
  writeJson(RECENT_FOLDERS_KEY, { ...all, [harness]: next })
  return next
}

/**
 * One that may be chosen: not imported yet, or Huli: a fork of an imported one that another folder
 * carried on, and its folder still there.
 */
export function selectable(session: AgentHistorySession): boolean {
  return (
    (!session.imported || session.outside === 'fork') && !session.missing && !session.unavailable
  )
}

export function matches(session: AgentHistorySession, query: string): boolean {
  if (query === '') return true
  const q = query.toLocaleLowerCase()
  return (
    (session.title ?? '').toLocaleLowerCase().includes(q) ||
    session.cwd.toLocaleLowerCase().includes(q)
  )
}

/**
 * The sessions under their folders, the folder used last first; Huli: with `scratch`, the Claude
 * desktop app's sessions in its scratch folders together under that heading.
 */
export function groupsOf(
  sessions: readonly AgentHistorySession[],
  scratch?: { name: string; path: string },
): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>()
  for (const session of sessions) {
    const together = scratch !== undefined && session.scratch === true
    const key = together ? `\n${DESKTOP_TAB}` : folderKey(session.cwd)
    let group = groups.get(key)
    if (!group) {
      group = together
        ? { key, path: scratch.path, name: scratch.name, sessions: [], latest: 0 }
        : { key, path: session.cwd, name: basename(session.cwd), sessions: [], latest: 0 }
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
  source: string,
  sessions: readonly AgentHistorySession[],
  days: number,
  now: number,
): string[] {
  return sessions
    .filter((s) => selectable(s) && (s.updatedAt ?? 0) >= now - days * DAY_MS)
    .map((s) => sessionKey(source, s.acpSessionId))
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
