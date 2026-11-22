import { useMemo } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/react'
import { useTranslation } from 'react-i18next'
import type { BoardStatus } from '@shared/session-board'
import { useSessionsStore } from '@renderer/stores/sessions'
import { anyOnBoard } from './model'

/** What a card carries while it is dragged. */
export interface CardData {
  sessionId: string
}

/** What a column takes a dropped card as. */
export interface ColumnData {
  boardStatus: BoardStatus
}

/** The column's name, as the board and its menus say it. */
export function useBoardLabel(): (status: BoardStatus) => string {
  const { t } = useTranslation('sidebar')
  return (status) => t(`board.status.${status}`)
}

/** Whether any session is on the board, as a boolean selected alone. */
export function useBoardHasCards(): boolean {
  return useSessionsStore((s) => anyOnBoard(s.byId))
}

/** A card as a drag source, which `attach` sets on its element; a press still opens it. */
export function useCardDrag(sessionId: string): {
  attach: (element: Element | null) => void
  dragging: boolean
} {
  const data = useMemo<CardData>(() => ({ sessionId }), [sessionId])
  const drag = useDraggable({ id: `kb-card:${sessionId}`, data })
  return { attach: drag.ref, dragging: drag.isDragging }
}

/** A column as a drop target; `over` while a dragged card is over it. */
export function useColumnDrop(status: BoardStatus): {
  attach: (element: Element | null) => void
  over: boolean
} {
  const data = useMemo<ColumnData>(() => ({ boardStatus: status }), [status])
  const drop = useDroppable({ id: `kb-column:${status}`, data })
  return { attach: drop.ref, over: drop.isDropTarget }
}
