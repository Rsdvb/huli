import { type CSSProperties, Fragment, useEffect, useRef, useState } from 'react'
import {
  Archive01Icon,
  ArrowMoveDownRightIcon,
  Clock01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CommandLineIcon,
  EyeIcon,
  FolderRemoveIcon,
  ComputerArrowUpIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  Delete02Icon,
  FileExportIcon,
  PictureInPictureOnIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitMergeIcon,
  Layout2ColumnIcon,
  LinkSquare02Icon,
  Notification03Icon,
  NotificationOff03Icon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  PlugSocketIcon,
  RefreshIcon,
  RepeatIcon,
  SidebarBottomIcon,
  SidebarRightIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  StopCircleIcon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import {
  archiveSession,
  deleteSession,
  descendantCount,
  forkSession,
  leaveSession,
  markSessionUnread,
  muteSession,
  pinSession,
  renameSession,
  unarchiveSession,
} from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { ForkIcon } from '@renderer/components/fork-icon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { toast } from '@renderer/components/ui/toast'
import { OpenInEditorMenu } from '@renderer/features/files/open-in-editor-menu'
import { isLocalProject } from '@renderer/features/files/operations'
import { PrIcon } from '@renderer/features/git/pr-icon'
import { modelName } from '@renderer/features/session/conversation-markdown'
import { sessionLinkProps } from '@renderer/features/session/open-link'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { basename, tokens } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { hostPath } from '@renderer/lib/host-paths'
import { currentLocale, i18n } from '@renderer/lib/i18n'
import { fileManagerName, formatShortcut, isMac, isWeb } from '@renderer/lib/platform'
import { shortcutKeysOf } from '@renderer/lib/shortcut-keys'
import { cn } from '@renderer/lib/utils'
import { agentsOn, isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { pullRequestOf, useGitStore } from '@renderer/stores/git'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { clearSelection } from '@renderer/stores/session-selection'
import {
  hostOfSession,
  listedSubSessions,
  sessionTitle,
  useSessionsStore,
} from '@renderer/stores/sessions'
import {
  allPanes,
  canSplit,
  focusedPane,
  paneWithSession,
  type SplitReason,
} from '@renderer/features/split/layout'
import { usePane } from '@renderer/features/split/pane-context'
import { splitSize } from '@renderer/features/split/session-drag-model'
import {
  openInSplit,
  openNewSubSession,
  openSession,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'
import {
  ACCELERATORS,
  canDeleteAtOnce,
  isRunning,
  MULTI_ACCELERATORS,
  multiSessionMenuGroups,
  QUICK_DELETE,
  runSessionMenuAccelerator,
  sessionMenuGroups,
  settle,
  SPLIT_ACCELERATORS,
  ARCHIVE_ALONE,
  type SessionMenuItem,
  type SessionMenuPlace,
} from './session-menu-model'
import { confirmArchive } from './archive-confirm-model'
import { NeverSettleItem, SettleItem, SnoozeMenu } from './tidy-menu'
import { ZenMenu } from '@renderer/features/session/zen-menu'
import { MenuOptions } from '@renderer/features/session/menu-options'
import { handoffSession } from '@renderer/features/session/composer/traffic-actions'
import { useMenuOptions } from '@renderer/features/session/menu-options-model'
import { undoToast } from './undo'
import { binnedSessionsToast } from '@renderer/features/recycle-bin/undo'
import { hostHasBin, useHostHasBin } from '@renderer/features/recycle-bin/support'
import { workAtStake, type WorkItem } from './running-work'
import { RunningWorkList } from './running-work-list'
import { dissolveRows } from './row-dust'
import { markReturning } from './row-exit'
import { sessionPullRequests } from './session-prs'
import { SubagentsMenu } from './subagents-menu'
import { listedSubagents } from './subagents'
import { sessionFolder } from '@renderer/lib/session-folder'
import { prFlowActive, prFlowTarget, setPrFlow } from '@renderer/features/git/flow-model'
import { copyResumeCommand, resumeInTerminal } from '@renderer/features/agents/agent-terminal'
import { MoveToFolderMenu } from '@renderer/features/session-folders/move-menu'
import { RowOrderItems } from './group-order-menu'
import { BoardStatusMenu } from '@renderer/features/task-board/status'
import { ManagerMenu } from '@renderer/features/manager/manager-menu'
import { askExport, canExport, exportAs } from '@renderer/features/session/export/export'
import { askMove, canMove } from '@renderer/features/session/move/move'
import { askMcpPanel } from '@renderer/features/session/mcp/mcp-panel'
import {
  refreshSessionTerminals,
  requestCloseAllTerminals,
} from '@renderer/features/terminal/close-all-terminals-model'
import {
  askRemoveWorktree,
  canRemoveWorktree,
  hasLiveWorktree,
  offerWorktreeRemoval,
} from '@renderer/features/worktrees/remove-worktree-model'
import { terminalsOf, useTerminalsStore } from '@renderer/stores/terminals'

/** An accelerator as the menu shows it: macOS's symbols, or the key names elsewhere. */
function shortcutLabel(shortcut: string): string {
  if (shortcut === 'Backspace') return isMac ? '⌫' : 'Backspace'
  return formatShortcut(shortcut)
}

/** Whether a session in a pane in view shows the given session, which keeps it read. */
function useInFront(sessionId: string): boolean {
  return useViewStore(
    (s) =>
      !s.settings.open &&
      allPanes(s.layout).some(
        (pane) =>
          s.visiblePanes.includes(pane.id) &&
          pane.view.kind === 'session' &&
          pane.view.sessionId === sessionId,
      ),
  )
}

/**
 * Archives with a toast that undoes it for five seconds, or Mod+Z meanwhile, with their sub-sessions as `subSessions`
 * says, once the user said whether they go when it does not, and confirmed when anything of theirs
 * runs, which archiving stops. Undo takes back the ones that archived, with the sub-sessions they
 * left; the toast names the failure when some did not, since a second toast would replace it.
 */
function archiveWithUndo(ids: readonly string[], title: string, subSessions?: boolean): void {
  void confirmArchive(ids, subSessions).then((answer) => {
    if (answer) archiveNow(ids, title, answer.subSessions)
  })
}

/** How many sub-sessions in the list these sessions have, which archiving alone leaves there. */
function useListedSubSessions(ids: readonly string[]): number {
  return useSessionsStore((s) => ids.reduce((n, id) => n + listedSubSessions(s.byId, id).length, 0))
}

function archiveNow(ids: readonly string[], title: string, subSessions: boolean): void {
  // Read before archiving: the question names the sessions as they were.
  const { byId } = useSessionsStore.getState()
  const before = ids.flatMap((id) => (byId[id] ? [byId[id]] : []))
  void settle(ids, (id) => archiveSession(id, subSessions)).then(({ done, errors }) => {
    const failure = errors.length > 0 ? errorMessage(errors[0]) : null
    if (done.length === 0) {
      if (failure) toast(failure)
      return
    }
    const archived = failure
      ? i18n.t('sidebar:row.archivedSome', { done: done.length, total: ids.length, error: failure })
      : title
    undoToast(
      archived,
      () => {
        markReturning(done)
        void settle(done, unarchiveSession).then(({ errors: failed }) => {
          if (failed.length > 0) toast(errorMessage(failed[0]))
        })
      },
      Archive01Icon,
    )
    void offerWorktreeRemoval(
      before.filter((s) => done.includes(s.id)),
      'archived',
    )
  })
}

/** Copies the text and says so in a toast. */
function copyWithToast(text: string, done: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast(done),
    (error: unknown) => toast(errorMessage(error)),
  )
}

/**
 * A session's actions. A context menu is a Base UI menu, so the same items serve the row's context
 * menu and the top bar's More menu (`place`); each passes `runSessionMenuAccelerator` as its
 * popup's `onKeyDown`.
 */
export function SessionMenuItems({
  summary,
  place = 'row',
  onRename,
  onNewSubSession,
  onDelete,
  subagents,
}: {
  summary: SessionSummary
  place?: SessionMenuPlace
  /** Left out where nothing renames the session, which leaves Rename out of the menu. */
  onRename?: () => void
  /** New session opens for a sub-session, and its composer takes the focus from the menu. */
  onNewSubSession: () => void
  onDelete: () => void
  /** The row's sub-agents, which the menu lists as its badge does; left out where it has none. */
  subagents?: readonly SessionSummary[]
}) {
  const { t } = useTranslation(['sidebar', 'common', 'session', 'shell'])
  const pane = usePane()
  const canLeave = place === 'more' && !!pane && !pane.split && pane.view.kind === 'session'
  // The agents of the session's host that can run one now; More options opens New session with
  // every agent.
  const hostId = hostOfSession(summary)
  const agents = useAgentsStore(
    useShallow((s) => {
      const { order, byId } = agentsOn(s, hostId)
      return usableAgents(order, byId).filter((a) => isInstalled(a) && !a.hidden && !a.disabled)
    }),
  )
  // Huli: every agent forks, one that cannot do it itself from Kettu's copy of the thread.
  const canFork = useAgentsStore((s) => !!agentsOn(s, hostId).byId[summary.agentId])
  const inFront = useInFront(summary.id)
  // A session a pane shows already, in view or folded, has no Open in split view.
  const inSplit = useViewStore((s) => !!paneWithSession(s.layout, summary.id))
  const terminal = useTerminalAllowed(summary.projectPath)
  const unread = summary.attention === 'unread'
  const running = isRunning(summary)
  // Only this computer's folders open in its file manager and its editors.
  const local = isLocalProject(summary.projectPath)
  // Huli: its host writes the command, for any agent whose own CLI resumes its sessions.
  const resume = useAgentsStore((s) => {
    const agent = agentsOn(s, hostId).byId[summary.agentId]
    return !!agent?.terminal?.resumes && !agent.disabled && !!summary.acpSessionId
  })
  const { id } = summary
  const terminalCount = useTerminalsStore((s) => (terminal ? terminalsOf(s.byId, id).length : 0))
  const subSessions = useListedSubSessions([id])
  const currentPr = useGitStore((s) => s.currentPr[sessionFolder(summary)] ?? null)
  const prTarget = prFlowTarget(summary, currentPr)
  const showFinished = useViewStore((s) => s.showFinishedSubagents)
  const listed = subagents ? listedSubagents(subagents, showFinished) : []
  const menuOptions = useMenuOptions(summary.id)

  useEffect(() => {
    if (terminal) void refreshSessionTerminals(summary.projectPath)
  }, [terminal, summary.projectPath])

  const item = (name: SessionMenuItem) => {
    // Huli: the terminal's item carries the terminal's keys as the user bound them.
    const accelerator =
      name === 'openTerminal' ? shortcutKeysOf('toggleTerminal') : ACCELERATORS[name]
    const shortcut = accelerator && (
      <DropdownMenuShortcut>{shortcutLabel(accelerator)}</DropdownMenuShortcut>
    )
    const props = { 'data-accelerator': accelerator }
    switch (name) {
      case 'stop':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            variant="destructive"
            onClick={() => void host('sessions.cancel', { sessionId: id })}
          >
            <Glyph icon={StopCircleIcon} size={15} />
            {t('row.stop')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'retry':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            onClick={() => void host('sessions.retry', { sessionId: id })}
          >
            <MenuGlyph icon={RefreshIcon} />
            {t('row.retry')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'open':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            disabled={inFront}
            onClick={() => openSession(id, summary.projectPath)}
          >
            <MenuGlyph icon={LinkSquare02Icon} />
            {t('row.open')}
            {/* What opens it from its row; in the menu Enter runs the highlighted item. */}
            <DropdownMenuShortcut>{formatShortcut('Enter')}</DropdownMenuShortcut>
          </DropdownMenuItem>
        )
      case 'pin':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            onClick={() => void pinSession(id, !summary.pinnedAt)}
          >
            {summary.pinnedAt ? <MenuGlyph icon={PinOffIcon} /> : <MenuGlyph icon={PinIcon} />}
            {summary.pinnedAt ? t('row.unpin') : t('row.pin')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'unread':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            disabled={inFront}
            onClick={() => void markSessionUnread(id, !unread)}
          >
            <MenuGlyph icon={ViewIcon} />
            {unread ? t('row.markRead') : t('row.markUnread')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'mute':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            className="h-auto items-start py-1.5"
            onClick={() =>
              void muteSession(id, !summary.muted).catch((e: unknown) => toast(errorMessage(e)))
            }
          >
            <Glyph
              icon={summary.muted ? Notification03Icon : NotificationOff03Icon}
              size={15}
              className="mt-0.5 text-icon"
            />
            <span className="flex min-w-0 flex-col">
              <span>{summary.muted ? t('row.unmute') : t('row.mute')}</span>
              <span className="max-w-60 text-small text-pretty whitespace-normal text-tertiary">
                {summary.muted ? t('row.unmuteHint') : t('row.muteHint')}
              </span>
            </span>
          </DropdownMenuItem>
        )
      case 'autoResume':
        return (
          <DropdownMenuCheckboxItem
            key={name}
            {...props}
            checked={summary.autoResume ?? false}
            onCheckedChange={(on) =>
              void host('sessions.setAutoResume', { sessionId: id, on }).catch((e: unknown) =>
                toast(errorMessage(e)),
              )
            }
            closeOnClick
          >
            <MenuGlyph icon={Clock01Icon} />
            {t('row.autoResume')}
          </DropdownMenuCheckboxItem>
        )
      case 'snooze':
        return <SnoozeMenu key={name} summaries={[summary]} />
      case 'settle':
        return <SettleItem key={name} summaries={[summary]} />
      case 'neverSettle':
        return <NeverSettleItem key={name} summary={summary} />
      case 'toolCalls':
        return <ZenMenu key={name} sessionId={summary.id} />
      case 'menuOptions':
        return <MenuOptions key={name} sessionId={summary.id} />
      case 'board':
        return <BoardStatusMenu key={name} summary={summary} />
      case 'manager':
        return <ManagerMenu key={name} summary={summary} />
      case 'autoMerge':
      case 'watchPr': {
        if (!prTarget) return null
        const flow =
          summary.prFlow && prFlowActive(summary.prFlow) && summary.prFlow.url === prTarget.url
            ? summary.prFlow
            : null
        const on = !!flow && (name === 'autoMerge' ? flow.autoMerge : flow.watch)
        return (
          <DropdownMenuCheckboxItem
            key={name}
            {...props}
            checked={on}
            onCheckedChange={(checked) =>
              setPrFlow(
                id,
                prTarget.url,
                name === 'autoMerge' ? { autoMerge: checked } : { watch: checked },
              )
            }
            closeOnClick
          >
            <MenuGlyph icon={name === 'autoMerge' ? GitMergeIcon : EyeIcon} />
            {t(name === 'autoMerge' ? 'row.autoMerge' : 'row.watchPr')}
          </DropdownMenuCheckboxItem>
        )
      }
      case 'rename':
        return (
          <DropdownMenuItem key={name} {...props} onClick={onRename}>
            <MenuGlyph icon={PencilEdit02Icon} />
            {t('row.rename')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'fork':
        return (
          <DropdownMenuItem key={name} {...props} onClick={() => void forkSession(id)}>
            <ForkIcon />
            {summary.worktree && hasLiveWorktree(summary)
              ? t('worktree.forkNew')
              : place === 'more'
                ? t('row.forkFromHere')
                : t('row.fork')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'forkSame':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            onClick={() =>
              void forkSession(id, undefined, 'same').catch((error: unknown) =>
                toast(errorMessage(error)),
              )
            }
          >
            <ForkIcon />
            {t('worktree.forkSame')}
          </DropdownMenuItem>
        )
      case 'handoff':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            onClick={() =>
              void handoffSession(id).then(
                () => toast(t('session:handoff.asked')),
                (error: unknown) => toast(errorMessage(error)),
              )
            }
          >
            <MenuGlyph icon={RepeatIcon} />
            {t('session:handoff.menu')}
          </DropdownMenuItem>
        )
      case 'removeWorktree':
        return (
          <DropdownMenuItem key={name} {...props} onClick={() => void askRemoveWorktree(summary)}>
            <MenuGlyph icon={FolderRemoveIcon} />
            {t('worktree.menu')}
          </DropdownMenuItem>
        )
      case 'newSubSession':
        return (
          <DropdownMenuSub key={name}>
            <DropdownMenuSubTrigger>
              <MenuGlyph icon={ArrowMoveDownRightIcon} />
              {t('row.newSubSession')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-59">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('row.runItWith')}</DropdownMenuLabel>
                {agents.map((agent) => (
                  <DropdownMenuItem
                    key={agent.id}
                    onClick={() => {
                      onNewSubSession()
                      openNewSubSession(summary, agent.id)
                    }}
                  >
                    <AgentMark agent={agent.id} size={15} hostId={hostId} />
                    <span className="min-w-0 flex-1 truncate">{agent.harnessName}</span>
                    {agent.name !== agent.harnessName && (
                      <span className="max-w-24 shrink-0 truncate pl-4 text-hint text-tertiary">
                        {agent.name}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  onNewSubSession()
                  openNewSubSession(summary, summary.agentId)
                }}
              >
                <MenuGlyph icon={SlidersHorizontalIcon} />
                {t('row.moreOptions')}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      case 'subagents':
        return (
          <SubagentsMenu key={name} parent={summary} listed={listed} showFinished={showFinished} />
        )
      case 'openInSplit':
        return <OpenInSplit summary={summary} key={name} />
      case 'pullRequest': {
        const prs = sessionPullRequests(summary)
        if (prs.length === 1) {
          const pr = prs[0]!
          return (
            <DropdownMenuItem
              key={name}
              {...props}
              render={<a {...sessionLinkProps(pr.url, id)} />}
            >
              <PrIcon state={pr.state} />
              {t('row.openPullRequest', { number: pr.number })}
              {shortcut}
            </DropdownMenuItem>
          )
        }
        return (
          prs.length > 1 && (
            <DropdownMenuSub key={name}>
              <DropdownMenuSubTrigger>
                <PrIcon state={null} />
                {t('row.pullRequests')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-80">
                {prs.map((pr) => (
                  <DropdownMenuItem key={pr.url} render={<a {...sessionLinkProps(pr.url, id)} />}>
                    <PrIcon state={pr.state} />
                    <span className="shrink-0 text-tertiary tabular-nums">
                      {pr.repo}#{pr.number}
                    </span>
                    <PrTitle url={pr.url} hostId={hostId} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        )
      }
      case 'openInEditor':
        return <OpenInEditorMenu key={name} path={sessionFolder(summary)} />
      case 'showInFolder':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            onClick={() => void window.kettu.shell.showItem(sessionFolder(summary))}
          >
            <MenuGlyph icon={FolderOpenIcon} />
            {t('row.showIn', { name: fileManagerName() })}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'openTerminal':
        return (
          <DropdownMenuItem key={name} {...props} onClick={() => toggleTerminal(summary.id, true)}>
            <MenuGlyph icon={ComputerTerminal01Icon} />
            {t('row.openTerminal')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'resumeInTerminal':
        return (
          <DropdownMenuItem key={name} {...props} onClick={() => void resumeInTerminal(summary)}>
            <MenuGlyph icon={CommandLineIcon} />
            {t('row.resumeInTerminal')}
          </DropdownMenuItem>
        )
      case 'closeTerminals':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            onClick={() => void requestCloseAllTerminals(id, { notify: true })}
          >
            <MenuGlyph icon={CancelCircleIcon} />
            <span className="min-w-0 flex-1 truncate">{t('row.closeTerminals')}</span>
            <span className="shrink-0 pl-4 text-hint text-tertiary tabular-nums">
              {terminalCount}
            </span>
          </DropdownMenuItem>
        )
      case 'copyResume':
        return (
          resume && (
            <DropdownMenuItem
              key={name}
              {...props}
              onClick={() => void copyResumeCommand(summary, t('row.copiedResume'))}
            >
              {place === 'more' ? (
                <MenuGlyph icon={Copy01Icon} />
              ) : (
                <MenuGlyph icon={ComputerTerminal01Icon} />
              )}
              {t('row.copyResume')}
            </DropdownMenuItem>
          )
        )
      case 'copySessionId':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            onClick={() =>
              copyWithToast(summary.acpSessionId ?? summary.id, t('row.copiedSessionId'))
            }
          >
            <MenuGlyph icon={Copy01Icon} />
            {t('row.copySessionId')}
          </DropdownMenuItem>
        )
      case 'mini':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            onClick={() => window.kettu.mini?.open(summary.id)}
          >
            <MenuGlyph icon={PictureInPictureOnIcon} />
            {t('row.mini')}
          </DropdownMenuItem>
        )
      // Huli: Export › Web page… and Markdown… at once, and the dialog for the rest.
      case 'export':
        return (
          <DropdownMenuSub key={name}>
            <DropdownMenuSubTrigger>
              <MenuGlyph icon={FileExportIcon} />
              {t('session:export.menu')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => exportAs(summary, 'html')}>
                {t('session:export.asHtml')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportAs(summary, 'md')}>
                {t('session:export.asMarkdown')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => askExport(summary)}>
                {t('session:export.more')}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      case 'mcp':
        return (
          <DropdownMenuItem key={name} {...props} onClick={() => askMcpPanel(summary)}>
            <MenuGlyph icon={PlugSocketIcon} />
            {t('row.mcp')}
          </DropdownMenuItem>
        )
      case 'move':
        return (
          <DropdownMenuItem key={name} {...props} onClick={() => askMove(summary)}>
            <MenuGlyph icon={ComputerArrowUpIcon} />
            {t('row.move')}
          </DropdownMenuItem>
        )
      case 'showInParent':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            onClick={() => {
              const parent = summary.parentId
                ? useSessionsStore.getState().byId[summary.parentId]
                : undefined
              if (parent) openSession(parent.id, parent.projectPath)
            }}
          >
            <MenuGlyph icon={ArrowMoveDownRightIcon} />
            {t('row.showInParent')}
          </DropdownMenuItem>
        )
      case 'leave':
        return (
          <DropdownMenuItem key={name} onClick={() => leaveSession(summary)}>
            <MenuGlyph icon={Cancel01Icon} />
            {t('shell:headerTools.leaveSession')}
            {/* 浏览器端由浏览器自身占用 Mod+W 快捷键。 */}
            {!isWeb && <DropdownMenuShortcut>{formatShortcut('Mod+W')}</DropdownMenuShortcut>}
          </DropdownMenuItem>
        )
      case 'archive': {
        const title = t('row.archived', { title: sessionTitle(summary) })
        if (subSessions === 0) {
          return (
            <DropdownMenuItem key={name} {...props} onClick={() => archiveWithUndo([id], title)}>
              <MenuGlyph icon={Archive01Icon} />
              {t('row.archive')}
              {shortcut}
            </DropdownMenuItem>
          )
        }
        return (
          <Fragment key={name}>
            <DropdownMenuItem {...props} onClick={() => archiveWithUndo([id], title, true)}>
              <MenuGlyph icon={Archive01Icon} />
              {t('row.archiveAll')}
              {shortcut}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-accelerator={ARCHIVE_ALONE}
              onClick={() => archiveWithUndo([id], title, false)}
            >
              <MenuGlyph icon={Archive01Icon} />
              {t('row.archiveAlone')}
              <DropdownMenuShortcut>{shortcutLabel(ARCHIVE_ALONE)}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </Fragment>
        )
      }
      case 'delete':
        return (
          <DropdownMenuItem
            key={name}
            {...props}
            data-quick-accelerator={QUICK_DELETE}
            variant="destructive"
            // A session cannot be removed mid-write; Stop comes first.
            disabled={running}
            // As drawn, a disabled Delete keeps its color and fades only its icon.
            className="data-disabled:opacity-100 data-disabled:[&>svg]:opacity-50"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey) void deleteUnlessAtStake([summary], onDelete)
              else onDelete()
            }}
          >
            <Glyph icon={Delete02Icon} size={15} />
            {t('row.deleteMenu')}
            {shortcut}
          </DropdownMenuItem>
        )
    }
  }

  const context = {
    canFork,
    shown: inSplit,
    place,
    local,
    terminal,
    hasTerminals: terminalCount > 0,
    resume,
    terminalResume: terminal && !running,
    rename: onRename !== undefined,
    worktree: hasLiveWorktree(summary),
    removeWorktree: canRemoveWorktree(summary),
    exportable: canExport(),
    movable: canMove() && !summary.scratch && summary.origin !== 'subagent',
    mini: local && window.kettu.mini !== undefined,
    prFlow: prTarget !== null,
    subagents: listed.length > 0,
    menuOptions: menuOptions.length > 0,
    leave: canLeave,
  }
  return sessionMenuGroups(summary, context).map((group, index) => (
    <DropdownMenuGroup key={group[0]}>
      {index > 0 && <DropdownMenuSeparator />}
      {group.map(item)}
      {group.includes('pin') && <MoveToFolderMenu ids={[id]} />}
      {group.includes('pin') && place === 'row' && <RowOrderItems sessionId={id} />}
    </DropdownMenuGroup>
  ))
}

/**
 * The More menu's head: the agent that runs the session, its model and the tokens the session has
 * used, as far as the agent reports them.
 */
export function SessionMenuHeader({
  summary,
  session,
}: {
  summary: SessionSummary
  session: SessionView | undefined
}) {
  const { t } = useTranslation('sidebar')
  const hostId = hostOfSession(summary)
  const agent = useAgentsStore((s) => agentsOn(s, hostId).byId[summary.agentId])
  const harness = agent?.harnessName ?? agent?.name ?? ''
  const name =
    agent && agent.name !== agent.harnessName
      ? t('row.agentOf', { harness, agent: agent.name })
      : harness
  const model = modelName(session)
  const used = session?.usage?.tokens?.total
  const detail = [
    model,
    used !== undefined && used > 0 ? t('row.tokensUsed', { tokens: tokens(used) }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      <div className="flex gap-2.5 px-2 pt-2 pb-2.5">
        <AgentMark agent={summary.agentId} size={28} hostId={hostId} />
        <div className="min-w-0">
          <div className="truncate text-ui font-semibold text-primary">{name}</div>
          {detail && <div className="mt-0.5 truncate text-meta text-tertiary">{detail}</div>}
        </div>
      </div>
      <DropdownMenuSeparator />
    </>
  )
}

/**
 * The menu for several sessions picked together: only the actions that apply to every one of them,
 * each acting on all of them.
 */
export function MultiSessionMenuItems({
  ids,
  onDelete,
}: {
  ids: readonly string[]
  onDelete: () => void
}) {
  const { t } = useTranslation('sidebar')
  const summaries = useSessionsStore(
    useShallow((s) => ids.map((id) => s.byId[id]).filter((x): x is SessionSummary => !!x)),
  )
  const front = useViewStore(
    useShallow((s) =>
      summaries.map(
        (summary) =>
          !s.settings.open &&
          allPanes(s.layout).some(
            (pane) =>
              s.visiblePanes.includes(pane.id) &&
              pane.view.kind === 'session' &&
              pane.view.sessionId === summary.id,
          ),
      ),
    ),
  )
  const count = summaries.length
  const each = (run: (summary: SessionSummary) => Promise<unknown>) => () => {
    clearSelection()
    void Promise.all(summaries.map(run)).catch((error: unknown) => toast(errorMessage(error)))
  }
  const listed = summaries.map((s) => s.id)
  const subSessions = useListedSubSessions(listed)
  const groups = multiSessionMenuGroups(summaries, (index) => front[index] ?? false)
  const shortcut = (accelerator: string | undefined) =>
    accelerator && <DropdownMenuShortcut>{shortcutLabel(accelerator)}</DropdownMenuShortcut>

  return (
    <>
      {groups.map((group, index) => (
        <DropdownMenuGroup key={group[0]}>
          {index > 0 ? (
            <DropdownMenuSeparator />
          ) : (
            <DropdownMenuLabel>{t('row.sessionsCount', { count })}</DropdownMenuLabel>
          )}
          {index === groups.length - 1 && <MoveToFolderMenu ids={summaries.map((s) => s.id)} />}
          {group.map((name) => {
            const accelerator = MULTI_ACCELERATORS[name]
            const props = { 'data-accelerator': accelerator }
            switch (name) {
              case 'stop':
                return (
                  <DropdownMenuItem
                    key={name}
                    {...props}
                    variant="destructive"
                    onClick={each((s) => host('sessions.cancel', { sessionId: s.id }))}
                  >
                    <Glyph icon={StopCircleIcon} size={15} />
                    {t('row.stopCount', { count })}
                    {shortcut(accelerator)}
                  </DropdownMenuItem>
                )
              case 'read':
              case 'unread':
                return (
                  <DropdownMenuItem
                    key={name}
                    {...props}
                    onClick={each((s) => markSessionUnread(s.id, name === 'unread'))}
                  >
                    <MenuGlyph icon={ViewIcon} />
                    {name === 'read' ? t('row.markRead') : t('row.markUnread')}
                  </DropdownMenuItem>
                )
              case 'pin':
              case 'unpin':
                return (
                  <DropdownMenuItem
                    key={name}
                    {...props}
                    onClick={each((s) => pinSession(s.id, name === 'pin'))}
                  >
                    {name === 'pin' ? (
                      <MenuGlyph icon={PinIcon} />
                    ) : (
                      <MenuGlyph icon={PinOffIcon} />
                    )}
                    {name === 'pin' ? t('row.pin') : t('row.unpin')}
                  </DropdownMenuItem>
                )
              case 'snooze':
                return <SnoozeMenu key={name} summaries={summaries} />
              case 'settle':
                return <SettleItem key={name} summaries={summaries} />
              case 'archive': {
                const archive = (subSessions?: boolean) => () => {
                  clearSelection()
                  archiveWithUndo(listed, t('row.archivedCount', { count }), subSessions)
                }
                if (subSessions === 0) {
                  return (
                    <DropdownMenuItem key={name} {...props} onClick={archive()}>
                      <MenuGlyph icon={Archive01Icon} />
                      {t('row.archiveCount', { count })}
                      {shortcut(accelerator)}
                    </DropdownMenuItem>
                  )
                }
                return (
                  <Fragment key={name}>
                    <DropdownMenuItem {...props} onClick={archive(true)}>
                      <MenuGlyph icon={Archive01Icon} />
                      {t('row.archiveAll')}
                      {shortcut(accelerator)}
                    </DropdownMenuItem>
                    <DropdownMenuItem data-accelerator={ARCHIVE_ALONE} onClick={archive(false)}>
                      <MenuGlyph icon={Archive01Icon} />
                      {t('row.archiveAloneCount', { count })}
                      {shortcut(ARCHIVE_ALONE)}
                    </DropdownMenuItem>
                  </Fragment>
                )
              }
              case 'delete':
                return (
                  <DropdownMenuItem
                    key={name}
                    {...props}
                    variant="destructive"
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey) {
                        void deleteUnlessAtStake(summaries, onDelete)
                      } else onDelete()
                    }}
                  >
                    <Glyph icon={Delete02Icon} size={15} />
                    {t('row.deleteCount', { count })}
                  </DropdownMenuItem>
                )
            }
          })}
        </DropdownMenuGroup>
      ))}
    </>
  )
}

/**
 * **Open in split view** with its sides, each disabled, saying why, when the split cannot take
 * that side: a tenth pane, or no room in the window.
 */
function OpenInSplit({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation('sidebar')
  const layout = useViewStore((s) => s.layout)
  const size = splitSize()
  const beside = size ? canSplit(layout, focusedPane(layout).id, 'right', size) : null
  const below = size ? canSplit(layout, focusedPane(layout).id, 'bottom', size) : null
  const open = (side: 'right' | 'bottom') => {
    if (!size) return
    openInSplit(
      { kind: 'session', sessionId: summary.id, projectPath: summary.projectPath },
      side,
      size,
    )
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MenuGlyph icon={Layout2ColumnIcon} />
        {t('row.openInSplit')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-49"
        onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
      >
        <OpenInSplitItem
          side="right"
          label={t('row.splitRight')}
          reason={beside?.ok ? null : (beside?.reason ?? 'room')}
          onClick={() => open('right')}
        />
        <OpenInSplitItem
          side="below"
          label={t('row.splitBelow')}
          reason={below?.ok ? null : (below?.reason ?? 'room')}
          onClick={() => open('bottom')}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function OpenInSplitItem({
  side,
  label,
  reason,
  onClick,
}: {
  side: 'right' | 'below'
  label: string
  /** Why the split cannot take that side; null when it can. */
  reason: SplitReason | null
  onClick: () => void
}) {
  const { t } = useTranslation('sidebar')
  const accelerator = SPLIT_ACCELERATORS[side]
  return (
    <DropdownMenuItem disabled={reason !== null} onClick={onClick} data-accelerator={accelerator}>
      {side === 'right' ? (
        <MenuGlyph icon={SidebarRightIcon} />
      ) : (
        <MenuGlyph icon={SidebarBottomIcon} />
      )}
      {label}
      {reason ? (
        <span className="ml-auto pl-3 text-xs text-tertiary">{t(`row.noRoom.${reason}`)}</span>
      ) : (
        <DropdownMenuShortcut>{shortcutLabel(accelerator)}</DropdownMenuShortcut>
      )}
    </DropdownMenuItem>
  )
}

/**
 * The session's title as a text field. Enter or a blur saves, Esc cancels, and an empty title
 * returns to the agent's. The field stays until the host has the new title, so the old one never
 * flashes back. Huli: `suggest` adds Regenerate, which puts a title the session's agent writes
 * from its conversation in the field, for the user to edit before it is saved.
 */
export function SessionTitleField({
  summary,
  onDone,
  className,
  style,
  suggest = false,
}: {
  summary: SessionSummary
  onDone: (restoreFocus: boolean) => void
  className?: string
  style?: CSSProperties
  suggest?: boolean
}) {
  const { t } = useTranslation('sidebar')
  const current = sessionTitle(summary)
  const [error, setError] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  const regenerate = async (): Promise<void> => {
    if (writing) return
    setWriting(true)
    setError(null)
    try {
      const { title } = await host('sessions.suggestTitle', { sessionId: summary.id })
      const input = field.current
      if (!input) return
      input.value = title
      input.focus()
      input.select()
    } catch (err) {
      setError(errorMessage(err))
      field.current?.focus()
    } finally {
      setWriting(false)
    }
  }
  // Enter, Esc and the blur that follows can all land on one edit; only the first counts.
  const settled = useRef(false)

  const finish = async (value: string | null, restoreFocus: boolean) => {
    if (settled.current) return
    settled.current = true
    const title = value?.trim() ?? null
    if (title === null || title === current) return onDone(restoreFocus)
    try {
      await renameSession(summary.id, title || null)
      onDone(restoreFocus)
    } catch (err) {
      settled.current = false
      setError(errorMessage(err))
      field.current?.focus()
    }
  }

  const input = (
    <input
      ref={field}
      autoFocus
      aria-label={t('row.renameTitle')}
      aria-invalid={error !== null}
      title={error ?? undefined}
      defaultValue={current}
      maxLength={200}
      autoComplete="off"
      spellCheck={false}
      className={cn('min-w-0 outline-none', className)}
      style={style}
      onFocus={(event) => event.currentTarget.select()}
      onChange={() => setError(null)}
      // Leaving a field that failed to save gives up instead of trying again.
      onBlur={(event) => void finish(error ? null : event.currentTarget.value, false)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') {
          event.preventDefault()
          void finish(event.currentTarget.value, true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          void finish(null, true)
        }
      }}
    />
  )
  if (!suggest) return input
  return (
    <>
      {input}
      <Button
        type="button"
        variant="quiet"
        size="icon-xs"
        className="shrink-0 text-tertiary"
        aria-label={writing ? t('row.suggestingTitle') : t('row.suggestTitle')}
        title={writing ? t('row.suggestingTitle') : t('row.suggestTitle')}
        disabled={writing}
        // Pressed without taking the field's focus, whose blur would save the title as it is.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void regenerate()}
      >
        {writing ? <Spinner className="size-3.5" /> : <Glyph icon={SparklesIcon} size={14} />}
      </Button>
    </>
  )
}

/** Uncommitted work in a session's folder, and whether that folder is a linked git worktree. */
interface AtStake {
  /** Null when the host could not read the folder. */
  files: number | null
  worktree: boolean
}

/**
 * Reads what deleting would leave behind: the folder's uncommitted files, from a one-off look that
 * starts no watch. A folder outside git has none.
 */
async function readAtStake(projectPath: string): Promise<AtStake> {
  const files = await host('git.changes', { projectPath }).then(
    (changes) => changes.length,
    () => null,
  )
  const gitDir = useGitStore.getState().status[projectPath]?.repo?.gitDir ?? ''
  return { files, worktree: /[\\/]worktrees[\\/][^\\/]+$/.test(gitDir) }
}

function useAtStake(paths: readonly string[], open: boolean): Map<string, AtStake> | null {
  const key = paths.join('\n')
  // Kept with the paths it was read for, so a dialog for other sessions never shows it.
  const [read, setRead] = useState<{ key: string; stake: Map<string, AtStake> } | null>(null)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const unique = [...new Set(key.split('\n'))]
    void Promise.all(unique.map(async (path) => [path, await readAtStake(path)] as const)).then(
      (entries) => !cancelled && setRead({ key, stake: new Map(entries) }),
    )
    return () => {
      cancelled = true
    }
  }, [key, open])
  return open && read?.key === key ? read.stake : null
}

/** What deleting the sessions would stop, read each time the dialog opens. */
function useWorkAtStake(ids: readonly string[], open: boolean): WorkItem[] | null {
  const key = ids.join('\n')
  const [read, setRead] = useState<{ key: string; items: WorkItem[] } | null>(null)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void workAtStake(key.split('\n')).then((items) => !cancelled && setRead({ key, items }))
    return () => {
      cancelled = true
    }
  }, [key, open])
  return open && read?.key === key ? read.items : null
}

/**
 * Deletes one by one: their rows in sight turn to dust, and one whose delete fails comes back.
 * First asks about the worktrees no other session uses, since the host keeps them on delete and
 * no session would be left to ask from.
 */
async function deleteAll(ids: readonly string[]): Promise<void> {
  const { byId } = useSessionsStore.getState()
  const summaries = ids.flatMap((id) => (byId[id] ? [byId[id]] : []))
  await offerWorktreeRemoval(summaries, 'deleting')
  const dust = await dissolveRows(ids)
  for (const [i, id] of ids.entries()) {
    try {
      await deleteSession(id)
    } catch (error) {
      dust.restore(ids.slice(i))
      // Huli: the ones already gone wait in the recycle bin, with Undo.
      const done = new Set(ids.slice(0, i))
      binnedSessionsToast(summaries.filter((summary) => done.has(summary.id)))
      throw error
    }
  }
  // Huli: they wait in the recycle bin; Undo puts them back.
  binnedSessionsToast(summaries)
}

/**
 * The folder whose uncommitted files a delete puts at stake: its worktree's while Kettu has not
 * removed it, else its project's. A removed worktree leaves nothing on disk to lose.
 */
function stakeFolder(summary: SessionSummary): string | null {
  if (!summary.worktree) return summary.projectPath
  return hasLiveWorktree(summary) ? summary.worktree.path : null
}

/** The Delete item's second key or a Mod-click: deletes at once when nothing is at stake. */
async function deleteUnlessAtStake(
  summaries: readonly SessionSummary[],
  confirm: () => void,
): Promise<void> {
  const paths = [...new Set(summaries.flatMap((s) => stakeFolder(s) ?? []))]
  const [stakes, work] = await Promise.all([
    Promise.all(paths.map(readAtStake)),
    workAtStake(summaries.map((s) => s.id)),
  ])
  const files = stakes.map((stake) => stake.files)
  const withChildren = summaries.some((s) => descendantCount(s.id) > 0)
  if (work.length > 0 || !canDeleteAtOnce(files, withChildren)) return confirm()
  clearSelection()
  try {
    await deleteAll(summaries.map((summary) => summary.id))
  } catch (error) {
    toast(errorMessage(error))
  }
}

/**
 * Deletes one session or several after one confirmation, which calls out the uncommitted files in
 * their folders and offers to archive instead, which keeps them.
 * Mounted lazily on first open so hundreds of sidebar rows pay zero store subscriptions while closed.
 */
export function DeleteSessionDialog(props: {
  sessionId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
  /** Several sessions picked together, this one among them. */
  ids?: readonly string[]
}) {
  const [mounted, setMounted] = useState(props.open)
  if (props.open && !mounted) setMounted(true)
  if (!mounted) return null
  return <DeleteSessionDialogInner {...props} />
}

function DeleteSessionDialogInner({
  sessionId,
  title,
  open,
  onOpenChange,
  onDeleted,
  ids,
}: {
  sessionId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
  /** Several sessions picked together, this one among them. */
  ids?: readonly string[]
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const targets = useSessionsStore(
    useShallow((s) =>
      (ids ?? [sessionId]).map((id) => s.byId[id]).filter((x): x is SessionSummary => !!x),
    ),
  )
  const several = targets.length > 1
  // Huli: a host older than the recycle bin deletes for good, and the dialog says so.
  const firstHost = targets[0] ? hostOfSession(targets[0]) : null
  const binOn =
    useHostHasBin(firstHost) && targets.every((target) => hostHasBin(hostOfSession(target)))
  const count = open ? targets.reduce((sum, s) => sum + descendantCount(s.id), 0) : 0
  const stake = useAtStake(
    targets.flatMap((s) => stakeFolder(s) ?? []),
    open,
  )
  const work = useWorkAtStake(
    targets.map((s) => s.id),
    open,
  )
  // The branch of each worktree Kettu made for them, which the note names with it.
  const branches = new Map(
    targets.flatMap((s) =>
      s.worktree && hasLiveWorktree(s) ? [[s.worktree.path, s.worktree.branch] as const] : [],
    ),
  )
  // Huli: the agents whose own copy goes with it, and those that share their history with their
  // vendor's app and keep a copy there that Kite cannot delete; each a line of names.
  const copies = useAgentsStore(
    useShallow((s) => {
      const removed = new Set<string>()
      const kept = new Set<string>()
      for (const target of targets) {
        const status = agentsOn(s, hostOfSession(target)).byId[target.agentId]
        if (!status) continue
        if (status.deletesCopy ?? status.capabilities.deleteSession) removed.add(status.harnessName)
        else if (status.sharesSignIn) kept.add(status.harnessName)
      }
      return { removed: [...removed].join('\n'), kept: [...kept].join('\n') }
    }),
  )
  const names = (lines: string): string =>
    new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(lines.split('\n'))
  // Archive keeps what it archives; a sub-session goes with its parent.
  const canArchive = targets.length > 0 && targets.every((s) => s.parentId === null)
  const remove = async () => {
    // Closed first: the rows turn to dust once nothing covers them.
    onOpenChange(false)
    clearSelection()
    try {
      await deleteAll(targets.map((target) => target.id))
      onDeleted?.()
    } catch (error) {
      toast(errorMessage(error))
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="gap-3.5 px-5.5 data-[size=default]:sm:max-w-105">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {several
              ? t('row.deleteCountTitle', { count: targets.length })
              : t('row.deleteTitle', { title })}
          </AlertDialogTitle>
        </AlertDialogHeader>
        {stake &&
          [...stake.entries()]
            .filter(([path, { files }]) => files !== 0 || branches.has(path))
            .map(([path, { files, worktree }]) => (
              <div
                key={path}
                className="flex gap-2.5 rounded-[10px] bg-(--shell-chip) px-3 py-2.5 text-control leading-normal text-secondary"
              >
                <Glyph
                  icon={GitBranchIcon}
                  size={15}
                  className="mt-0.5 size-3.75 shrink-0 text-icon"
                />
                <span>
                  {/* A folder the host could not read says so, as the reason this asks. */}
                  <Trans
                    t={t}
                    i18nKey={
                      files === null
                        ? 'row.atStakeUnknown'
                        : branches.has(path)
                          ? files === 0
                            ? 'row.inWorktree'
                            : 'row.atStakeWorktreeBranch'
                          : worktree
                            ? 'row.atStakeWorktree'
                            : 'row.atStakeFolder'
                    }
                    count={files ?? undefined}
                    values={{ name: basename(hostPath(path)), branch: branches.get(path) ?? '' }}
                    components={{
                      name: <span className="font-mono text-xs text-primary" />,
                      files: <b className="font-semibold text-primary" />,
                    }}
                  />
                </span>
              </div>
            ))}
        {work && work.length > 0 && (
          <div className="text-control leading-normal text-secondary">
            {t('row.deleteStops')}
            <RunningWorkList items={work} className="mt-1.5" />
          </div>
        )}
        <AlertDialogDescription className="text-small text-tertiary">
          {binOn
            ? count > 0
              ? t('row.deleteBodyWithSub', { count })
              : several
                ? t('row.deleteBodyCount')
                : t('row.deleteBody')
            : count > 0
              ? t('row.deleteBodyWithSubForGood', { count })
              : several
                ? t('row.deleteBodyCountForGood')
                : t('row.deleteBodyForGood')}
          {copies.removed &&
            ` ${t(binOn ? 'row.deleteRemovesAgentCopy' : 'row.deleteRemovesAgentCopyNow', {
              agent: names(copies.removed),
              count: targets.length,
            })}`}
          {copies.kept && ` ${t('row.deleteKeepsAppCopy', { agent: names(copies.kept) })}`}
        </AlertDialogDescription>
        <AlertDialogFooter className="pt-1">
          {canArchive && (
            <Button
              variant="ghost"
              className="mr-auto text-secondary"
              onClick={() => {
                onOpenChange(false)
                clearSelection()
                archiveWithUndo(
                  targets.map((s) => s.id),
                  several
                    ? t('row.archivedCount', { count: targets.length })
                    : t('row.archived', { title }),
                )
              }}
            >
              {t('row.archiveInstead')}
            </Button>
          )}
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void remove()}>
            {t('row.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** A pull request's title in the menu, once its details have loaded somewhere. */
function PrTitle({ url, hostId }: { url: string; hostId: string | null }) {
  const title = useGitStore((s) => pullRequestOf(s, hostId, url)?.title ?? '')
  return <span className="min-w-0 flex-1 truncate">{title}</span>
}
