// Huli: the user's task board. Each of the user's own top-level sessions sits in one of four
// columns the user drags it between, or its agent moves it to through Kite's tools. It is the
// user's own workflow state, apart from what Kite marks by itself (working, waiting, done).

/** The columns, in the board's order. */
export const BOARD_STATUSES = ['todo', 'in_progress', 'review', 'done'] as const
export type BoardStatus = (typeof BOARD_STATUSES)[number]

/** Where a new session starts, and where one from before the board stands. */
export const NEW_BOARD_STATUS: BoardStatus = 'in_progress'

/** A session's column and when it moved there, which orders a column the latest first. */
export interface SessionBoard {
  status: BoardStatus
  at: number
}

export function isBoardStatus(value: unknown): value is BoardStatus {
  return (BOARD_STATUSES as readonly unknown[]).includes(value)
}

interface BoardFacts {
  parentId: string | null
  origin: string
  archivedAt: number | null
}

/**
 * Whether a session is on the board: the user's own, top-level and not archived. A routine's runs
 * and a task's steps have pages of their own, and sub-sessions go with their parent.
 */
export function onBoard(session: BoardFacts): boolean {
  return session.parentId === null && session.origin === 'user' && session.archivedAt === null
}
