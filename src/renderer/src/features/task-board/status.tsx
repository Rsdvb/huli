// Huli: the task board's columns as the sidebar's rows, the session menus and the board draw them.
// See tools/huli/README.md (Task board).

import {
  CheckmarkCircle02Icon,
  DashedLineCircleIcon,
  Progress03Icon,
  Progress04Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { BOARD_STATUSES, isBoardStatus, type BoardStatus } from '@shared/session-board'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { moveOnBoard } from './move'
import { useBoardLabel } from './use-board'

/** Each column's mark: a ring that fills as the work goes on, a tick once done. */
const BOARD_ICONS: Record<BoardStatus, IconSvgElement> = {
  todo: DashedLineCircleIcon,
  in_progress: Progress03Icon,
  review: Progress04Icon,
  done: CheckmarkCircle02Icon,
}

/** Each column's color: what is still to come faint, what is done green. */
const BOARD_TONES: Record<BoardStatus, string> = {
  todo: 'text-(--faint)',
  in_progress: 'text-(--primary-foreground)',
  review: 'text-warning',
  done: 'text-(--thread-done)',
}

/** A column's mark in its color, as the board's heads and the menus show it. */
export function BoardGlyph({
  status,
  size = 15,
  className,
}: {
  status: BoardStatus
  size?: number
  className?: string
}) {
  return (
    <Glyph
      icon={BOARD_ICONS[status]}
      size={size}
      className={cn('shrink-0', BOARD_TONES[status], className)}
    />
  )
}

/**
 * On a sidebar row: the column's mark alone, faint, its name on hover. The row's card leaves to
 * its tooltip when the pointer comes onto it.
 */
export function BoardRowMark({ status, onEnter }: { status: BoardStatus; onEnter: () => void }) {
  const { t } = useTranslation('sidebar')
  const label = t('board.mark', { status: t(`board.status.${status}`) })
  return (
    <Tooltip>
      <TooltipTrigger
        delay={400}
        render={
          <span
            role="img"
            aria-label={label}
            onPointerEnter={onEnter}
            className="inline-flex h-5 shrink-0 items-center px-[3px] text-(--faint)"
          />
        }
      >
        <Glyph icon={BOARD_ICONS[status]} size={12} />
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

/** The columns as a menu's choices, the session's own checked, for any of the app's menus. */
export function BoardStatusItems({ summary }: { summary: Pick<SessionSummary, 'id' | 'board'> }) {
  const label = useBoardLabel()
  if (!summary.board) return null
  return (
    <DropdownMenuRadioGroup
      value={summary.board.status}
      onValueChange={(value: unknown) => {
        if (isBoardStatus(value)) void moveOnBoard(summary.id, value)
      }}
    >
      {BOARD_STATUSES.map((status) => (
        <DropdownMenuRadioItem key={status} value={status} closeOnClick>
          <BoardGlyph status={status} />
          {label(status)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

/** A session menu's Board › submenu, which names the column the session is in. */
export function BoardStatusMenu({ summary }: { summary: Pick<SessionSummary, 'id' | 'board'> }) {
  const { t } = useTranslation('sidebar')
  const label = useBoardLabel()
  if (!summary.board) return null
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <BoardGlyph status={summary.board.status} />
        <span className="min-w-0 flex-1 truncate">{t('board.menu')}</span>
        <span className="shrink-0 pl-4 text-hint text-tertiary">{label(summary.board.status)}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-48">
        <BoardStatusItems summary={summary} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
