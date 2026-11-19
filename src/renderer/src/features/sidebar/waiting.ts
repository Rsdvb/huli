import type { SessionSummary } from '@shared/agent-host'
import type { ThreadEntry } from '@shared/thread'

/** Where a row's wait is: the session itself, one of its sub-agents, or one of its sub-sessions. */
export type WaitingPlace = 'here' | 'subagent' | 'subSession'

/** A session that waits for the user, as a row counts it. */
export interface WaitingSource {
  summary: SessionSummary
  place: WaitingPlace
  count: number
}

/** What a request asks of the user, as the row's mark names it. */
export type WaitingKind =
  | 'permission'
  | 'command'
  | 'edit'
  | 'question'
  | 'plan'
  | 'form'
  | 'site'
  | 'device'
  | 'app'
  | 'setup'
  | 'step'
  | 'publish'

/**
 * The sessions whose requests a row counts, oldest first: the session, its sub-agents at any depth,
 * and with `subSessions` its sub-sessions at any depth with their sub-agents, as the sidebar's tree
 * adds them up.
 */
export function waitingSources(
  byId: Readonly<Record<string, SessionSummary>>,
  rootId: string,
  subSessions: boolean,
): WaitingSource[] {
  const kids = new Map<string, SessionSummary[]>()
  for (const s of Object.values(byId)) {
    if (!s.parentId || s.archivedAt) continue
    const list = kids.get(s.parentId) ?? []
    list.push(s)
    kids.set(s.parentId, list)
  }
  const out: WaitingSource[] = []
  const seen = new Set<string>()
  const visit = (summary: SessionSummary, place: WaitingPlace): void => {
    if (seen.has(summary.id)) return
    seen.add(summary.id)
    if (summary.permissionCount > 0) out.push({ summary, place, count: summary.permissionCount })
    const children = (kids.get(summary.id) ?? []).sort((a, b) => a.createdAt - b.createdAt)
    for (const child of children) {
      if (child.origin === 'subagent') visit(child, 'subagent')
      else if (subSessions) visit(child, 'subSession')
    }
  }
  const root = byId[rootId]
  if (root) visit(root, 'here')
  return out
}

/**
 * The sources of a row's `count`: the session and its sub-agents, and when they wait for fewer, as
 * a collapsed parent or a row of Needs you counts, its sub-sessions too.
 */
export function rowWaitingSources(
  byId: Readonly<Record<string, SessionSummary>>,
  rootId: string,
  count: number,
): WaitingSource[] {
  const own = waitingSources(byId, rootId, false)
  return own.reduce((n, s) => n + s.count, 0) < count ? waitingSources(byId, rootId, true) : own
}

/** A short key of the sources, which changes only when what the row's mark says does. */
export function waitingKey(sources: readonly WaitingSource[]): string {
  return sources.map((s) => `${s.summary.id}:${s.count}`).join(' ')
}

/** What a waiting entry asks for; null for an entry that waits for nothing. */
export function waitingKind(entry: ThreadEntry): WaitingKind | null {
  switch (entry.kind) {
    case 'tool': {
      const permission = entry.permission
      if (!permission) return null
      if (permission.questions) return 'question'
      if (permission.plan) return 'plan'
      if (permission.elicitation) return 'form'
      if (entry.toolKind === 'execute') return 'command'
      if (entry.toolKind === 'edit' || entry.toolKind === 'delete' || entry.toolKind === 'move')
        return 'edit'
      return 'permission'
    }
    case 'browser_origin':
      return entry.decision === null ? 'site' : null
    case 'device_access':
      return entry.decision === null ? 'device' : null
    case 'computer_app':
      return entry.decision === null ? 'app' : null
    case 'computer_setup':
      return entry.outcome === null ? 'setup' : null
    case 'control_ask':
      return entry.outcome === null ? 'step' : null
    case 'market_publish':
      return entry.outcome === null ? 'publish' : null
    default:
      return null
  }
}
