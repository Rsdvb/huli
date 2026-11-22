// Huli: what the task board shows, read from the session list the sidebar already holds.

import type { SessionSummary } from '@shared/agent-host'
import { BOARD_STATUSES, onBoard, type BoardStatus } from '@shared/session-board'

export type BoardColumns = Record<BoardStatus, string[]>

/** The project a session counts under on the board: its folder, or '' for No project. */
export function boardProject(summary: Pick<SessionSummary, 'scratch' | 'projectPath'>): string {
  return summary.scratch ? '' : summary.projectPath
}

/**
 * The board's columns as one string of session ids, each column's latest moved first, of one
 * project or of all (null). A selector returns it, so the board renders again only when a card
 * comes, goes or moves, not at each change to a session.
 */
export function columnsKey(byId: Record<string, SessionSummary>, project: string | null): string {
  const columns = new Map<BoardStatus, SessionSummary[]>(BOARD_STATUSES.map((s) => [s, []]))
  for (const summary of Object.values(byId)) {
    if (!summary.board || !onBoard(summary)) continue
    if (project !== null && boardProject(summary) !== project) continue
    columns.get(summary.board.status)?.push(summary)
  }
  return BOARD_STATUSES.map((status) =>
    columns
      .get(status)!
      .sort((a, b) => b.board!.at - a.board!.at || b.createdAt - a.createdAt)
      .map((summary) => summary.id)
      .join('\n'),
  ).join('\t')
}

export function columnsOf(key: string): BoardColumns {
  const parts = key.split('\t')
  return Object.fromEntries(
    BOARD_STATUSES.map((status, i) => [status, parts[i] ? parts[i].split('\n') : []]),
  ) as BoardColumns
}

/** The projects that have sessions on the board, '' for No project, as JSON for a selector. */
export function projectsKey(byId: Record<string, SessionSummary>): string {
  const projects = new Set<string>()
  for (const summary of Object.values(byId)) {
    if (summary.board && onBoard(summary)) projects.add(boardProject(summary))
  }
  return JSON.stringify([...projects].sort())
}

/** Whether any session is on the board. */
export function anyOnBoard(byId: Record<string, SessionSummary>): boolean {
  for (const summary of Object.values(byId)) if (summary.board && onBoard(summary)) return true
  return false
}

/** What Kite marks by itself on a card: waiting for the user, at work, stopped, or done unseen. */
export type KiteMark = 'you' | 'running' | 'stopped' | 'ready' | null

export function kiteMark(
  summary: Pick<SessionSummary, 'permissionCount' | 'status' | 'attention'>,
): KiteMark {
  if (summary.permissionCount > 0 || summary.status === 'awaiting_permission') return 'you'
  if (summary.status === 'auth_required') return 'you'
  if (summary.attention === 'error' || summary.status === 'failed') return 'stopped'
  if (summary.status === 'running' || summary.status === 'starting') return 'running'
  return summary.attention === 'unread' ? 'ready' : null
}
