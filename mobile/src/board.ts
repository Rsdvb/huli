// Huli: the task board's columns as the phone names and draws them, after the desktop's. The phone
// shows a session's column on its row and moves it from the session's menus.

import { CircleCheck, CircleDashed, Contrast, Eye } from 'lucide-react-native'
import { onBoard, type BoardStatus } from '@shared/session-board'
import type { SessionSummary } from '@shared/agent-host'
import type { IconSpec } from './ui/session/Icon'

export const BOARD_LABEL: Record<BoardStatus, string> = {
  todo: '待办',
  in_progress: '进行中',
  review: '待审',
  done: '完成',
}

export const BOARD_ICON: Record<BoardStatus, IconSpec> = {
  todo: { sf: 'circle.dashed', lucide: CircleDashed },
  in_progress: { sf: 'circle.lefthalf.filled', lucide: Contrast },
  review: { sf: 'eye.circle', lucide: Eye },
  done: { sf: 'checkmark.circle', lucide: CircleCheck },
}

/** The session's column when it is on the board: the user's own, top-level, not archived. */
export function boardStatusOf(
  s: Pick<SessionSummary, 'board' | 'parentId' | 'origin' | 'archivedAt'>,
): BoardStatus | null {
  return s.board && onBoard(s) ? s.board.status : null
}
