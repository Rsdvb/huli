import { useState } from 'react'
import { Message01Icon, Store01Icon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { Workflow, WireWorkflowEntry } from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { useHostWorkflows } from '@renderer/stores/workflows'
import { openMarketplace } from '@renderer/stores/view'
import { GROUP_ICON } from '@renderer/features/groups/group-icon'
import { WORKTREE_ICON } from '../worktree/worktree-icon'
import { choosePace, useWorkflowChoice } from './workflow-choice'
import { WorkflowPreview } from './workflow-preview'
import { PaceControl } from './workflow-steps'
import { WORKFLOW_ICON, workflowBlocked, workflowName, stepChain } from './workflow-picks'

const CHAT = ''
// A workflow id starts with a letter or digit, so neither Chat's value nor best of N's is one.
const BEST_OF_N = '_best-of-n'

/**
 * New session's way of working, on the tray before the worktree: Chat, one agent as a session
 * is, or a workflow of the host's library that runs the message as a task, one session per step.
 * A workflow waiting for approval, changed since, or unreadable is listed but cannot be chosen.
 * With a workflow chosen, the menu sets the task's pace and hovering shows the workflow's chart.
 * With none in the library, the menu holds Chat and the way to add one from the Marketplace.
 */
export function WorkflowMenu({
  hostId,
  workflowId,
  firstAgentId,
  onChoose,
  bestOfN = null,
}: {
  hostId: string | null
  /** The chosen workflow, null for Chat. */
  workflowId: string | null
  /** The tray's agent, which does the first step. */
  firstAgentId: AgentId | null
  onChoose: (workflowId: string | null) => void
  /**
   * Huli: giving the message to several agents at once, each in a worktree of its own: whether it
   * is chosen and how many runs it starts; null where no worktree can be made.
   */
  bestOfN?: { chosen: boolean; runs: number; onChoose: () => void } | null
}) {
  const { t } = useTranslation('session')
  const { entries, loaded, error } = useHostWorkflows(hostId)
  const pace = useWorkflowChoice((s) => s.pace)
  const [menuOpen, setMenuOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const none = loaded && !error && entries.length === 0
  const several = !!bestOfN?.chosen
  const chosen =
    workflowId && !several ? entries.find((entry) => entry.id === workflowId) : undefined
  const usable =
    chosen?.workflow && workflowBlocked(chosen) === null
      ? (chosen as WireWorkflowEntry & { workflow: Workflow })
      : undefined

  return (
    <HoverCard open={!!usable && previewOpen && !menuOpen} onOpenChange={setPreviewOpen}>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <HoverCardTrigger
          render={
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t('newSession.workflow.label')}
                  className="ui-as-tray-link kettu-tray-link--workflow"
                />
              }
            />
          }
        >
          <Glyph icon={several ? GROUP_ICON : chosen ? WORKFLOW_ICON : Message01Icon} size={13} />
          <span className="kettu-tray-link__text">
            {several
              ? t('group.mode', { count: bestOfN?.runs ?? 0 })
              : chosen
                ? workflowName(chosen)
                : t('newSession.workflow.chat')}
          </span>
        </HoverCardTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-80">
          <DropdownMenuRadioGroup
            value={several ? BEST_OF_N : (workflowId ?? CHAT)}
            onValueChange={(value) => {
              if (value === BEST_OF_N) bestOfN?.onChoose()
              else onChoose(value === CHAT ? null : String(value))
            }}
          >
            <DropdownMenuRadioItem value={CHAT} closeOnClick className="py-1.5">
              <MenuGlyph icon={Message01Icon} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{t('newSession.workflow.chat')}</span>
                <span className="truncate text-meta text-tertiary">
                  {t('newSession.workflow.chatHint')}
                </span>
              </span>
            </DropdownMenuRadioItem>
            {bestOfN && (
              <DropdownMenuRadioItem value={BEST_OF_N} closeOnClick className="py-1.5">
                <MenuGlyph icon={GROUP_ICON} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{t('group.choice')}</span>
                  <span className="truncate text-meta text-tertiary">{t('group.choiceHint')}</span>
                </span>
              </DropdownMenuRadioItem>
            )}
            {!none && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('newSession.workflow.heading')}</DropdownMenuLabel>
                  {!loaded ? (
                    <div className="flex flex-col gap-1 px-1 pb-1" aria-hidden>
                      {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-10 w-full rounded-lg" />
                      ))}
                    </div>
                  ) : error && entries.length === 0 ? (
                    <p className="px-2 py-1.5 text-meta text-danger">{error}</p>
                  ) : (
                    entries.map((entry) => {
                      const blocked = workflowBlocked(entry)
                      return (
                        <DropdownMenuRadioItem
                          key={entry.id}
                          value={entry.id}
                          closeOnClick
                          disabled={blocked !== null}
                          className="py-1.5 data-disabled:opacity-100"
                        >
                          <MenuGlyph icon={WORKFLOW_ICON} />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className={blocked ? 'truncate text-tertiary' : 'truncate'}>
                              {workflowName(entry)}
                            </span>
                            <span className="truncate text-meta text-tertiary">
                              {entry.workflow
                                ? stepChain(entry.workflow)
                                : t('newSession.workflow.unreadableHint')}
                            </span>
                          </span>
                          {blocked && (
                            <span
                              className={
                                blocked === 'unreadable'
                                  ? 'shrink-0 text-small text-danger'
                                  : 'shrink-0 text-small text-warning'
                              }
                            >
                              {t(`newSession.workflow.blocked.${blocked}`)}
                            </span>
                          )}
                        </DropdownMenuRadioItem>
                      )
                    })
                  )}
                </DropdownMenuGroup>
              </>
            )}
          </DropdownMenuRadioGroup>
          {usable && (
            <>
              <DropdownMenuSeparator />
              <div className="flex items-center justify-between gap-3 py-1 pr-1 pl-2 text-ui text-secondary">
                {t('workflow.pace')}
                <PaceControl value={pace} onChange={choosePace} />
              </div>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => openMarketplace({ tab: 'workflow' })}>
            <MenuGlyph icon={Store01Icon} />
            {none ? t('newSession.workflow.addFromMarketplace') : t('newSession.workflow.findMore')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {usable && (
        <HoverCardContent
          side="bottom"
          align="start"
          sideOffset={8}
          className="w-auto max-w-[min(40rem,90vw)] p-3"
        >
          <WorkflowPreview entry={usable} hostId={hostId} firstAgentId={firstAgentId} pace={pace} />
        </HoverCardContent>
      )}
    </HoverCard>
  )
}

/**
 * A task's place to work, shown and not chosen: in a Git project a task always gets a worktree of
 * its own, cut from the branch checked out.
 */
export function TaskWorktreeTag({
  base,
  several = false,
}: {
  base: string | null
  /** Huli: best of N's runs, a worktree each. */
  several?: boolean
}) {
  const { t } = useTranslation('session')
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="ui-as-tray-link kettu-tray-link--branch" data-static="" />}
      >
        <Glyph icon={WORKTREE_ICON} size={13} />
        <span className="kettu-tray-link__text">
          {base ? (
            <Trans
              t={t}
              i18nKey="worktree.newTrigger"
              values={{ branch: base }}
              components={{ name: <span className="font-mono" /> }}
            />
          ) : (
            t('worktree.new')
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {several ? t('group.worktreeHint') : t('newSession.workflow.worktreeHint')}
      </TooltipContent>
    </Tooltip>
  )
}

/** Under the composer, where the worktree's note is: where a task in a Git project works. */
export function TaskWorktreeNote({
  base,
  several = false,
}: {
  base: string | null
  /** Huli: best of N's runs, a worktree each. */
  several?: boolean
}) {
  const { t } = useTranslation('session')
  if (!base) return <p aria-hidden className={NOTE} />
  return (
    <p className={NOTE}>
      <Glyph icon={WORKTREE_ICON} size={12} className="shrink-0 text-icon" />
      <span className="min-w-0 truncate">
        <Trans
          t={t}
          i18nKey={several ? 'group.worktreeNote' : 'newSession.workflow.worktreeNote'}
          components={{ base: <b className="font-medium" /> }}
          values={{ base }}
        />
      </span>
    </p>
  )
}

const NOTE = 'flex h-5 min-w-0 items-center gap-1.5 px-2.75 text-xs text-secondary'
