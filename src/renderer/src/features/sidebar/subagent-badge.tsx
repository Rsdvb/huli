import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ArrowDown01Icon, ArrowRight01Icon, BotIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { revealSubagent } from '@renderer/features/session/reveal-subagent'
import { subagentRunning, useSubagentProgress } from '@renderer/features/session/subagent/progress'
import { Glyph } from '@renderer/features/shell/glyph'
import { duration } from '@renderer/lib/format'
import { isMac } from '@renderer/lib/platform'
import { sessionTitle } from '@renderer/stores/sessions'
import { openSession, setShowFinishedSubagents, useViewStore } from '@renderer/stores/view'
import { SessionMenuItems } from './session-menu'
import { runSessionMenuAccelerator } from './session-menu-model'
import { SubagentStatus } from './subagent-status'
import { listedSubagents, subagentFailed } from './subagents'

const nothing = () => {}

const CLOSE_DELAY = 200
// Past Base UI's own close, so the guard below only acts on a leave Base UI never saw.
const AWAY_DELAY = CLOSE_DELAY + 100
// More finished ones than this fold under a row of their own while others still run.
const FOLD_FINISHED = 3
// Room below the badge that keeps the list there; with less, it opens above if more room is there.
const ROOM_BELOW = 300

/**
 * A session's sub-agents on its row: a count with a spinner while any runs, and on hover the list,
 * each jumping to its block in the session's thread, or to its own page while it waits for you.
 * Finished ones show only when chosen.
 */
export function SubagentBadge({
  parent,
  subagents,
  onOpen,
}: {
  parent: SessionSummary
  subagents: SessionSummary[]
  /** The badge's list opened, taking the place of the row's own card. */
  onOpen: () => void
}) {
  const showFinished = useViewStore((s) => s.showFinishedSubagents)
  const listed = listedSubagents(subagents, showFinished)
  if (listed.length === 0) return null
  return <BadgeCard parent={parent} listed={listed} showFinished={showFinished} onOpen={onOpen} />
}

function BadgeCard({
  parent,
  listed,
  showFinished,
  onOpen,
}: {
  parent: SessionSummary
  listed: SessionSummary[]
  showFinished: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation('sidebar')
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState<'top' | 'bottom'>('bottom')
  const trigger = useRef<HTMLAnchorElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  // An item's own menu is open: the pointer is on it, outside the card, and Escape is the menu's.
  const menuOpen = useRef(false)
  const close = useCallback(() => setOpen(false), [])
  useCloseWhenAway(open, close, trigger, popup, menuOpen)

  const running = listed.filter(subagentRunning)
  const finished = listed.filter((child) => !subagentRunning(child))
  // One that waits for the user is not working, so the badge holds still and takes the fox color.
  const waiting = listed.some((child) => child.permissionCount > 0)
  const count = running.length || listed.length
  const label = [
    running.length
      ? t('subagents.running', { count: running.length })
      : t('subagents.count', { count: listed.length }),
    waiting ? t('subagents.waiting') : null,
  ]
    .filter(Boolean)
    .join(t('waiting.separator'))

  const onMenu = (next: boolean, reason: string) => {
    menuOpen.current = next
    if (next) return
    // Opening the sub-agent or its block from the menu is done with the list too.
    if (reason === 'item-press') close()
    // A menu put away with the pointer off the list leaves no leave event to close it.
    else
      setTimeout(() => {
        if (
          !menuOpen.current &&
          !popup.current?.matches(':hover') &&
          !trigger.current?.matches(':hover')
        )
          close()
      }, AWAY_DELAY)
  }
  const item = (child: SessionSummary) => (
    <li key={child.id}>
      <SubagentItem parent={parent} child={child} onOpened={close} onMenu={onMenu} />
    </li>
  )

  return (
    <HoverCard
      open={open}
      onOpenChange={(next, details) => {
        // The pointer went onto an item's menu, which lies outside the card.
        if (!next && menuOpen.current && details.reason === 'trigger-hover') {
          details.cancel()
          return
        }
        if (next) {
          setSide(roomySide(trigger.current))
          onOpen()
        } else menuOpen.current = false
        setOpen(next)
      }}
    >
      <HoverCardTrigger
        ref={trigger}
        delay={300}
        closeDelay={CLOSE_DELAY}
        aria-label={label}
        render={
          // As an image, its label goes into the name of the row's button around it.
          <span
            role="img"
            data-subagent-badge=""
            className="kettu-subagent-badge inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-subtle pr-[5px] pl-1 text-[11px] font-medium text-secondary tabular-nums shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] hover:bg-selected data-popup-open:bg-selected"
          />
        }
      >
        <Glyph icon={BotIcon} size={11} className="size-[11px]! text-tertiary" />
        {count}
        {waiting ? (
          <span aria-hidden className="mx-px size-1.5 rounded-full bg-attention-dot" />
        ) : (
          running.length > 0 && <RingSpinner aria-hidden className="size-[9px] border-[1.25px]" />
        )}
      </HoverCardTrigger>
      <HoverCardContent
        ref={popup}
        side={side}
        align="center"
        sideOffset={12}
        // Huli: on the side picked as it opens, never beside the badge, where a long list was moved
        // up over the sidebar, nor flipping as it grows; it scrolls within the room there.
        collisionAvoidance={{ side: 'none', align: 'shift' }}
        className="flex max-h-[min(60vh,var(--available-height))] w-[300px] flex-col p-[5px]"
        // Huli: an item's own menu, not the row's as well, which holds this list in React's tree;
        // and focus coming back to an item from its menu must not open the row's card.
        onContextMenu={(event) => event.stopPropagation()}
        onFocus={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center px-2 pt-1.5 pb-1">
          <span className="flex-1 text-small font-medium text-tertiary">
            {t('subagents.title')}
          </span>
          {running.length > 0 && (
            <span className="text-caption text-tertiary tabular-nums">
              {t('subagents.runningShort', { count: running.length })}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <ul className="flex flex-col">{running.map(item)}</ul>
          {finished.length > 0 &&
            (running.length > 0 ? (
              <FinishedSection count={finished.length}>
                <ul className="flex flex-col">{finished.map(item)}</ul>
              </FinishedSection>
            ) : (
              <ul className="flex flex-col">{finished.map(item)}</ul>
            ))}
        </div>
        <div role="separator" className="mx-[3px] my-[5px] h-px shrink-0 bg-(--border-subtle)" />
        <label className="flex h-[30px] shrink-0 items-center gap-[9px] rounded-tile px-2 text-[13.5px] text-primary">
          <span className="min-w-0 flex-1 truncate">{t('subagents.showFinished')}</span>
          <Switch size="sm" checked={showFinished} onCheckedChange={setShowFinishedSubagents} />
        </label>
      </HoverCardContent>
    </HoverCard>
  )
}

function roomySide(trigger: Element | null): 'top' | 'bottom' {
  if (!trigger) return 'bottom'
  const { top, bottom } = trigger.getBoundingClientRect()
  const below = window.innerHeight - bottom
  return below >= ROOM_BELOW || below >= top ? 'bottom' : 'top'
}

/** The finished ones under the running ones, folded when there are many. */
function FinishedSection({ count, children }: { count: number; children: ReactNode }) {
  const { t } = useTranslation('sidebar')
  // The list mounts each time the card opens, so it opens folded again.
  const [expanded, setExpanded] = useState(count <= FOLD_FINISHED)
  return (
    <>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="mt-1 flex h-[26px] w-full items-center gap-1.5 rounded-lg px-2 text-left text-small font-medium text-tertiary outline-none hover:bg-selected hover:text-secondary focus-ring"
      >
        <Glyph icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
        <span className="tabular-nums">{t('subagents.finishedSection', { count })}</span>
      </button>
      {expanded && children}
    </>
  )
}

/**
 * Closes the open card once the pointer is outside both the badge and the card, or leaves the
 * window, unless an item's menu holds it. Base UI closes it on a mouseleave of either, and
 * nothing else did: a leave it never got kept the list open over the sidebar for good.
 */
function useCloseWhenAway(
  open: boolean,
  close: () => void,
  trigger: RefObject<HTMLElement | null>,
  popup: RefObject<HTMLElement | null>,
  menuOpen: RefObject<boolean>,
): void {
  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (away: boolean) => {
      if (!away || menuOpen.current) {
        clearTimeout(timer)
        timer = undefined
      } else {
        timer ??= setTimeout(close, AWAY_DELAY)
      }
    }
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (!!trigger.current?.contains(target) || !!popup.current?.contains(target))
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') settle(!inside(event.target))
    }
    const onOut = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && event.relatedTarget === null) settle(true)
    }
    // Before the composer's own Escape, which would stop the session's run.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || menuOpen.current) return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    document.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerout', onOut, { passive: true })
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerout', onOut)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, close, trigger, popup, menuOpen])
}

function SubagentItem({
  parent,
  child,
  onOpened,
  onMenu,
}: {
  parent: SessionSummary
  child: SessionSummary
  /** The item took the user to the sub-agent. */
  onOpened: () => void
  onMenu: (open: boolean, reason: string) => void
}) {
  const { t } = useTranslation('sidebar')
  const progress = useSubagentProgress(child)
  const running = subagentRunning(child)
  const waiting = child.permissionCount > 0
  const failed = subagentFailed(child)
  const elapsed = progress.elapsedMs === null ? null : duration(progress.elapsedMs)
  const meta = running
    ? [progress.tools === null ? null : t('subagents.tools', { count: progress.tools }), elapsed]
    : [t(failed ? 'subagents.failed' : 'subagents.done'), elapsed]

  return (
    <ContextMenu onOpenChange={(next, details) => onMenu(next, details.reason)}>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            // Huli: one that waits for you opens on its own page, where its request is answered.
            onClick={() => {
              if (waiting) openSession(child.id, child.projectPath)
              else revealSubagent(parent.id, child.id)
              onOpened()
            }}
            className="flex min-h-10 w-full items-center gap-[9px] rounded-lg px-2 py-[5px] text-left outline-none hover:bg-selected focus-ring data-popup-open:bg-selected"
          />
        }
      >
        <span className="grid size-[22px] shrink-0 place-items-center rounded-tile bg-subtle text-secondary">
          <Glyph icon={BotIcon} size={13} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
          <span className="truncate text-[13px] text-primary">
            {sessionTitle(child)}
            {child.description && <span className="text-tertiary"> · {child.description}</span>}
          </span>
          <span className="truncate text-caption text-tertiary tabular-nums">
            {meta.filter(Boolean).join(' · ')}
          </span>
        </span>
        <SubagentStatus child={child} />
      </ContextMenuTrigger>
      <ContextMenuContent onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}>
        <SessionMenuItems summary={child} onNewSubSession={nothing} onDelete={nothing} />
      </ContextMenuContent>
    </ContextMenu>
  )
}
