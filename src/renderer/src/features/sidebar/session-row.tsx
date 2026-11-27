import { memo, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  MoreHorizontalIcon,
  NotificationOff03Icon,
  PinIcon,
  PinOffIcon,
} from '@hugeicons/core-free-icons'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { pinSession } from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { Glyph } from '@renderer/features/shell/glyph'
import { backTime } from '@renderer/lib/format'
import { isMac, isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { awayHosts, isAway, sidebarHosts, useOtherHost } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import {
  clearSelection,
  selectionFor,
  selectRange,
  toggleSelected,
  useSessionSelection,
} from '@renderer/stores/session-selection'
import {
  hostOfSession,
  sessionTitle,
  useSessionsStore,
  visibleOrder,
  type SessionNode,
} from '@renderer/stores/sessions'
import { withFolderOrder } from '@renderer/features/session-folders/drag'
import {
  useSessionDragSource,
  useSessionDragStore,
} from '@renderer/features/split/session-drag-model'
import { allPanes, paneWithSession } from '@renderer/features/split/layout'
import { openSession, useViewStore } from '@renderer/stores/view'
import { RenameHints } from './rename-hints'
import { useRenameHints } from './rename-scope'
import { isReturning, rowVariants } from './row-exit'
import { badgeInUse } from './row-badges'
import { rowStatus } from './row-status'
import { cacheGone, useGoneLabel, useSessionCache } from './session-cache'
import { SessionCard } from './session-card'
import { RowBody, RowEnd, SessionIndicator } from './session-indicator'
import {
  DeleteSessionDialog,
  MultiSessionMenuItems,
  SessionMenuItems,
  SessionTitleField,
} from './session-menu'
import { runSessionMenuAccelerator } from './session-menu-model'
import { WorktreeRowMark } from '@renderer/features/session/worktree/worktree-tag'
import { PrBadge } from './pr-badge'
import { IssueBadge } from '@renderer/features/git/flow-chips'
import { BoardRowMark } from '@renderer/features/task-board/status'
import { onBoard } from '@shared/session-board'
import { useEntry } from '@renderer/lib/features'
import { SubagentBadge } from './subagent-badge'
import { useRenaming } from './use-renaming'
import { moveRow } from './row-drag'
import { WaitingMark } from './waiting-mark'
import { QuickAllowTools, type QuickAllowRoom } from './quick-allow'

/**
 * A row's padding before its mark, as App Shell's chat rows: a session in a project's folder lines
 * up with the folder's name; a sub-session's row starts past its parent's tree line.
 */
export const ROW_PAD = 6
export const INDENT_PAD = 30
export const NESTED_STEP = 22

/**
 * Huli: whether an event happened on the row itself. The popups of its marks (the sub-agents', a
 * pull request's) are portaled out of it but are still its children in React's tree, so their
 * clicks reached the row too: a pick in the sub-agents' list then also opened the parent session.
 */
const fromRow = (event: SyntheticEvent<HTMLElement>): boolean =>
  event.currentTarget.contains(event.target as Node)

interface SessionRowProps {
  node: SessionNode
  /** The id of the list's one Tab stop, which the row it names takes. */
  tabStopId: string | null
  /** The row ends with its host's name, as in a list across the hosts. */
  showHost?: boolean
  /** In a project's folder, so the row lines up with the folder's name. */
  indent?: boolean
  /** A sub-session's place under its parent, which the tree line follows. */
  branch?: 'middle' | 'last'
  /** Huli: Needs you's row, whose tools offer 允许 for a plain request (quick-allow.tsx). */
  quickAllow?: boolean
}

/** Whether the list's Tab stop is this row or one of its sub-sessions'. */
const holdsStop = (node: SessionNode, id: string | null): boolean =>
  id !== null && (node.summary.id === id || node.children.some((child) => holdsStop(child, id)))

/**
 * The Tab stop follows the session shown, so it moves on every open; only the rows it leaves and
 * reaches render for it, not all of them.
 */
const sameRow = (a: SessionRowProps, b: SessionRowProps): boolean =>
  a.node === b.node &&
  a.showHost === b.showHost &&
  a.indent === b.indent &&
  a.branch === b.branch &&
  a.quickAllow === b.quickAllow &&
  (a.tabStopId === b.tabStopId ||
    (!holdsStop(a.node, a.tabStopId) && !holdsStop(b.node, b.tabStopId)))

export const SessionRow = memo(function SessionRow({
  node,
  tabStopId,
  showHost = false,
  indent = false,
  branch,
  quickAllow = false,
}: SessionRowProps) {
  const { t } = useTranslation('sidebar')
  const { summary, children } = node
  const hostId = hostOfSession(summary)
  const otherHost = useOtherHost(hostId)
  // What an offline host's session last said is not known to hold, so it shows no state.
  const away = isAway(otherHost?.connection ?? null)
  const hostName = hostId === null ? t('hosts.thisComputer') : (otherHost?.name ?? '')
  // A sub-agent has no row, so its parent's stands for it while it shows. Whether this row is the
  // one shown, not which is: that would render every row when another one opens.
  const current = useViewStore((s) => {
    const shownId = s.main.kind === 'session' && !s.settings.open ? s.main.sessionId : null
    return (
      shownId !== null &&
      (shownId === summary.id || node.subagents.some((agent) => agent.id === shownId))
    )
  })
  // The rows of the other panes in view take the current row's fill as well.
  const inSplit = useViewStore(
    (s) =>
      !s.settings.open &&
      s.main.kind === 'session' &&
      s.main.sessionId !== summary.id &&
      !!paneWithSession(s.layout, summary.id) &&
      allPanes(s.layout).some(
        (pane) =>
          s.visiblePanes.includes(pane.id) &&
          pane.view.kind === 'session' &&
          pane.view.sessionId === summary.id,
      ),
  )
  const tabStop = tabStopId === summary.id
  const picked = useSessionSelection((s) => selectionFor(summary.id, s.ids))
  // A row picked alone shows it, though its menu still acts on it alone.
  const marked = useSessionSelection((s) => s.ids.includes(summary.id))
  const userExpanded = useViewStore((s) => s.expandedParents[summary.id])
  const hasChildren = children.length > 0
  const childActive = children.some((c) => c.running || c.permissionCount > 0)
  const expanded = hasChildren && (userExpanded ?? childActive)

  // A parent expands by itself the first time a sub-session needs attention, then stays as left.
  useEffect(() => {
    if (childActive && userExpanded === undefined) {
      useViewStore.setState((s) => ({
        expandedParents: { ...s.expandedParents, [summary.id]: true },
      }))
    }
  }, [childActive, userExpanded, summary.id])

  const setExpanded = (value: boolean) =>
    useViewStore.setState((s) => ({
      expandedParents: { ...s.expandedParents, [summary.id]: value },
    }))

  // Null until Delete is first asked for, so the dialog mounts only then.
  const [deleting, setDeleting] = useState<boolean | null>(null)
  const variants = useMemo(() => rowVariants(summary.id), [summary.id])
  const [moreOpen, setMoreOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  const [allowRoom, setAllowRoom] = useState<QuickAllowRoom | null>(null)
  const [allowOpen, setAllowOpen] = useState(false)
  const issueBadge = useEntry('sidebar.issueBadge')
  const boardMark = useEntry('sidebar.boardMark')
  const [cardMounted, setCardMounted] = useState(false)
  if (cardOpen && !cardMounted) setCardMounted(true)
  const row = useRef<HTMLDivElement>(null)
  const rename = useRenaming(() => row.current?.querySelector<HTMLElement>('[data-sidebar-row]'))
  const drag = useSessionDragSource(summary.id, rename.renaming)
  const ownHints = useRenameHints(rename.renaming)
  const base = indent ? INDENT_PAD : ROW_PAD
  const pad = branch ? base + NESTED_STEP : base
  const cache = useSessionCache(summary)
  const gone = useGoneLabel(cache)
  const expiring = cache?.state === 'ending' ? cache.cache : null
  // Collapsed, a parent speaks for its sub-sessions: their count and the loudest status.
  const status = rowStatus(node, hasChildren && !expanded)
  // What waits gets a button of its own in the row's tools, over the status slot.
  const waiting = !away && status.waiting > 0
  const allowing = quickAllow && waiting
  // Huli: a manager's worker shows the task its manager gave it.
  const title = summary.worker?.title || sessionTitle(summary)

  // Mod-click and Shift-click pick rows for a menu that acts on all of them; a plain click opens
  // the session and lets go of the picked ones.
  const pick = (event: React.MouseEvent): boolean => {
    const currentId = useViewStore.getState().main
    const current = currentId.kind === 'session' ? currentId.sessionId : null
    if (isMod(event) && !event.shiftKey && !event.altKey) {
      toggleSelected(summary.id)
      return true
    }
    if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const view = useViewStore.getState()
      const order = visibleOrder(
        { ...view, hosts: sidebarHosts(), away: awayHosts() },
        useSessionsStore.getState().byId,
        useProjectsStore.getState().projects,
        {},
        useProjectsStore.getState().noProjects,
      )
      selectRange(summary.id, current, withFolderOrder(order))
      return true
    }
    clearSelection()
    return false
  }

  const caret = hasChildren && (
    <span
      role="button"
      tabIndex={-1}
      aria-label={expanded ? t('row.collapse') : t('row.expand')}
      onClick={(event) => {
        event.stopPropagation()
        setExpanded(!expanded)
      }}
      className="-mr-1.5 -ml-4 grid size-3.5 shrink-0 place-items-center rounded-sm text-(--faint) hover:text-(--ink)"
    >
      <Glyph icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
    </span>
  )
  const mark = (
    <span className="ui-as-chat-row__logo relative">
      <AgentMark
        agent={summary.agentId}
        size={14}
        hostId={hostId}
        className={cn(
          'transition-[filter,opacity] duration-(--duration-base)',
          cacheGone(cache) && 'opacity-40 grayscale',
        )}
      />
    </span>
  )

  const button = (
    <button
      ref={drag.ref}
      type="button"
      aria-description={inSplit ? t('row.inSplitView') : undefined}
      // The other panes' rows take the current row's fill.
      className={cn(
        'ui-as-side__item ui-as-chat-row__link data-multi-selected:bg-(--row-picked)!',
        inSplit && 'kettu-row-in-view',
        away && 'text-(--faint)!',
      )}
      data-sidebar-row=""
      data-session-id={summary.id}
      tabIndex={tabStop ? 0 : -1}
      aria-current={current ? 'page' : undefined}
      aria-expanded={hasChildren ? expanded : undefined}
      data-multi-selected={marked ? '' : undefined}
      onClick={(event) => {
        if (!fromRow(event)) return
        if (!pick(event)) openSession(summary.id, summary.projectPath)
      }}
      onDoubleClick={(event) => fromRow(event) && rename.start()}
      onKeyDown={(event) => {
        if (!fromRow(event)) return
        if (event.key === 'Escape') {
          // Esc that lets go of picked rows stops here, before it reaches the session.
          if (useSessionSelection.getState().ids.length > 0) event.preventDefault()
          clearSelection()
        }
        // The context menu key opens the More menu, the row's menu for the keyboard.
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          setMoreOpen(true)
          return
        }
        if (event.key === 'F2') {
          event.preventDefault()
          rename.start()
          return
        }
        // Huli: Alt+arrows move the row within its group's own order (group-order-menu.tsx).
        if (
          (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
          event.altKey &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          event.preventDefault()
          moveRow(summary.id, event.key === 'ArrowUp' ? -1 : 1)
          return
        }
        if (!hasChildren) return
        if (event.key === 'ArrowRight' && !expanded) {
          event.preventDefault()
          setExpanded(true)
        } else if (event.key === 'ArrowLeft' && expanded) {
          event.preventDefault()
          setExpanded(false)
        }
      }}
      style={{ paddingLeft: pad }}
    >
      {caret}
      <RowBody>
        {mark}
        <span className="ui-as-side__text" dir="auto">
          {/* Huli: a manager's worker leads with its roster name; a manager says it is one. */}
          {summary.worker && <span className="text-(--faint)">{summary.worker.name} · </span>}
          {title}
        </span>
        {summary.manager && (
          <span
            aria-label={t('row.manager')}
            title={t('row.manager')}
            className="shrink-0 text-[11px] font-normal text-(--faint)"
          >
            {t('row.managerBadge')}
          </span>
        )}
        {summary.worktree && (
          <WorktreeRowMark worktree={summary.worktree} onOpen={() => setCardOpen(false)} />
        )}
        {summary.issue && issueBadge && (
          <IssueBadge issue={summary.issue} onEnter={() => setCardOpen(false)} />
        )}
        <PrBadge summary={summary} onOpen={() => setCardOpen(false)} />
        {summary.board && boardMark && onBoard(summary) && (
          <BoardRowMark status={summary.board.status} onEnter={() => setCardOpen(false)} />
        )}
        {/* Huli: 静音通知. */}
        {summary.muted && (
          <span
            role="img"
            aria-label={t('row.muted')}
            title={t('row.muted')}
            className="grid shrink-0 place-items-center text-(--faint)"
          >
            <Glyph icon={NotificationOff03Icon} size={12} />
          </span>
        )}
        {hasChildren && !expanded && (
          <span
            aria-label={t('row.subSessions', { count: children.length })}
            className="shrink-0 text-[12px] font-normal text-(--faint) tabular-nums"
          >
            {children.length}
          </span>
        )}
        {gone && <span className="sr-only">{gone}</span>}
        {node.subagents.length > 0 && !away && (
          <SubagentBadge
            parent={summary}
            subagents={node.subagents}
            onOpen={() => setCardOpen(false)}
          />
        )}
        <RowEnd>
          {/* Huli: when a snoozed session comes back (会话整理). */}
          {summary.snooze && (
            <span
              title={t(summary.snooze.reset ? 'tidy.backAtReset' : 'tidy.backAt', {
                time: backTime(summary.snooze.until),
              })}
              className="shrink-0 text-[12px] font-normal text-(--faint) tabular-nums"
            >
              {backTime(summary.snooze.until)}
            </span>
          )}
          {showHost && hostName && (
            <span className="max-w-24 truncate text-[12px] font-normal text-(--faint)">
              {hostName}
            </span>
          )}
          {!away && <SessionIndicator status={status} expiring={expiring} waitingApart={waiting} />}
        </RowEnd>
      </RowBody>
    </button>
  )

  const menuItems =
    menuOpen || moreOpen ? (
      picked ? (
        <MultiSessionMenuItems ids={picked} onDelete={() => setDeleting(true)} />
      ) : (
        <SessionMenuItems
          summary={summary}
          onRename={rename.menu.onRename}
          onNewSubSession={rename.menu.onLeave}
          onDelete={() => setDeleting(true)}
          subagents={away ? undefined : node.subagents}
        />
      )
    ) : null

  const pinned = !!summary.pinnedAt
  return (
    <motion.li
      className="flex flex-col"
      variants={variants}
      initial={isReturning(summary.id) ? 'hidden' : false}
      animate="shown"
      exit="exit"
    >
      <div
        ref={row}
        className="ui-as-chat-row"
        data-indent={indent || undefined}
        data-menu={menuOpen || moreOpen || (allowing && allowOpen) || undefined}
        data-quick-allow={(allowing && allowRoom) || undefined}
      >
        {branch && <TreeLine last={branch === 'last'} left={base + 7} />}
        {rename.renaming ? (
          <>
            {/* A field cannot sit inside the row's button, so the row is a plain box while renaming. */}
            <div
              className="ui-as-chat-row__rename flex items-center gap-2"
              style={{ paddingLeft: pad - 1 }}
            >
              {caret}
              {mark}
              <SessionTitleField
                summary={summary}
                onDone={rename.finish}
                className="h-full min-w-0 flex-1 bg-transparent outline-none selection:bg-edit-selection aria-invalid:text-danger"
              />
            </div>
            {ownHints && <RenameHints />}
          </>
        ) : (
          <>
            <ContextMenu
              onOpenChange={setMenuOpen}
              onOpenChangeComplete={rename.menu.onOpenChangeComplete}
            >
              {/* A trigger's render must take its props, so the card's Root wraps the menu trigger. */}
              <HoverCard
                open={cardOpen}
                // A badge's own card stands in for the row's, so only one shows at a time.
                // Huli: and a drag of a session opens none, as its row stays under the pointer.
                onOpenChange={(open, details) => {
                  if (open && useSessionDragStore.getState().dragging) {
                    details.cancel()
                    return
                  }
                  setCardOpen(open && !badgeInUse(row.current))
                }}
              >
                <HoverCardTrigger
                  delay={600}
                  closeDelay={150}
                  render={<ContextMenuTrigger render={button} />}
                />
                <HoverCardContent
                  side="right"
                  align="start"
                  sideOffset={10}
                  alignOffset={-4}
                  className="w-[340px] p-0"
                >
                  {cardMounted && (
                    <SessionCard
                      summary={summary}
                      cache={cache}
                      status={status}
                      onOpen={() => setCardOpen(false)}
                    />
                  )}
                </HoverCardContent>
              </HoverCard>
              <ContextMenuContent
                finalFocus={rename.menu.finalFocus}
                onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
              >
                {menuItems}
              </ContextMenuContent>
            </ContextMenu>
            {/* App Shell's row tools: the More menu and the pin, shown on hover. */}
            <span className="ui-as-chat-row__tools">
              {allowing && (
                <QuickAllowTools
                  row={row}
                  rootId={summary.id}
                  count={status.waiting}
                  onRoom={setAllowRoom}
                  onOpenChange={setAllowOpen}
                />
              )}
              <DropdownMenu
                open={moreOpen}
                onOpenChange={setMoreOpen}
                onOpenChangeComplete={rename.menu.onOpenChangeComplete}
              >
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={t('row.moreFor', { title })}
                      title={t('row.more')}
                      className="ui-as-chat-row__tool"
                    />
                  }
                >
                  <Glyph icon={MoreHorizontalIcon} size={15} />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  finalFocus={rename.menu.finalFocus}
                  onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
                >
                  {menuItems}
                </DropdownMenuContent>
              </DropdownMenu>
              {waiting ? (
                // Pinning is also in the More menu, so the wait takes the pin's place.
                <WaitingMark rootId={summary.id} count={status.waiting} />
              ) : (
                <button
                  type="button"
                  // One stop per row for the keyboard: pinning is also in the More menu.
                  tabIndex={-1}
                  aria-label={pinned ? t('row.unpin') : t('row.pin')}
                  aria-pressed={pinned}
                  title={pinned ? t('row.unpin') : t('row.pin')}
                  onClick={() => void pinSession(summary.id, !pinned)}
                  className="ui-as-chat-row__tool ui-as-chat-row__pin"
                >
                  <Glyph icon={pinned ? PinOffIcon : PinIcon} size={14} />
                </button>
              )}
            </span>
          </>
        )}
      </div>
      {expanded && (
        <ul className="flex flex-col">
          <AnimatePresence initial={false}>
            {children.map((child, i) => (
              <SessionRow
                key={child.summary.id}
                node={child}
                tabStopId={tabStopId}
                indent={indent}
                branch={i === children.length - 1 ? 'last' : 'middle'}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
      {deleting !== null && (
        <DeleteSessionDialog
          sessionId={summary.id}
          title={title}
          ids={picked ?? undefined}
          open={deleting}
          onOpenChange={setDeleting}
        />
      )}
    </motion.li>
  )
}, sameRow)

/**
 * The line from a parent down along its sub-sessions, with a tick to each; on the last it turns
 * with a short curve and stops.
 */
export function TreeLine({ last, left }: { last: boolean; left: number }) {
  return (
    <span
      aria-hidden
      style={{ left }}
      className={cn(
        'pointer-events-none absolute w-[9px] border-l border-(--line-strong)',
        last
          ? 'top-0 h-[15px] rounded-bl-[4px] border-b'
          : 'inset-y-0 before:absolute before:top-[15px] before:-left-px before:w-[9px] before:border-t before:border-(--line-strong)',
      )}
    />
  )
}
