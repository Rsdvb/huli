import { DashboardSquare02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import type { TFunction } from 'i18next'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { StillRunning } from '@shared/agent-host'
import { usePane } from '@renderer/features/split/pane-context'
import { useSessionsStore } from '@renderer/stores/sessions'
import { focusPane, toggleBoard } from '@renderer/stores/view'

type Work = Pick<StillRunning, 'commands' | 'subagents' | 'workflows' | 'workflowAgents'>

/** What runs on, in words: "a workflow - 12 sub-agents and 1 command". */
function stillRunningText(
  t: TFunction<'session'>,
  { commands, subagents, workflows = 0, workflowAgents = 0 }: Work,
): string {
  const parts: string[] = []
  if (workflows > 0) {
    const flow =
      workflows === 1
        ? t('stillRunning.workflow')
        : t('stillRunning.workflows', { count: workflows })
    parts.push(
      workflowAgents > 0
        ? t('stillRunning.withAgents', {
            workflow: flow,
            agents: t('stillRunning.subagents', { count: workflowAgents }),
          })
        : flow,
    )
  }
  if (subagents > 0) parts.push(t('stillRunning.subagents', { count: subagents }))
  if (commands > 0) parts.push(t('stillRunning.commands', { count: commands }))
  if (parts.length === 0) return t('stillRunning.subagents', { count: 0 })
  if (parts.length === 1) return parts[0]!
  if (parts.length === 2) return t('stillRunning.both', { subagents: parts[0], commands: parts[1] })
  return t('stillRunning.three', { first: parts[0], second: parts[1], third: parts[2] })
}

/**
 * What the session runs on after its turn ended, as a muted line at the thread's end with the
 * board one click away. It is the host's live count, never a stored entry, so it goes once that
 * work ends or the next turn starts.
 */
export const StillRunningLine = memo(function StillRunningLine({
  sessionId,
}: {
  sessionId: string
}) {
  const { t } = useTranslation('session')
  const pane = usePane()
  const work = useSessionsStore(
    useShallow((s) => {
      const still = s.byId[sessionId]?.stillRunning
      return still
        ? {
            commands: still.commands,
            subagents: still.subagents,
            workflows: still.workflows ?? 0,
            workflowAgents: still.workflowAgents ?? 0,
            reportsBack: still.reportsBack,
          }
        : null
    }),
  )
  if (!work) return null
  const what = stillRunningText(t, work)
  const text = work.reportsBack
    ? t('stillRunning.lineReports', {
        work: what,
        count: work.commands + work.subagents + work.workflows,
      })
    : t('stillRunning.line', { work: what })
  const open = () => {
    if (pane && !pane.focused) focusPane(pane.paneId)
    toggleBoard(sessionId, true)
  }
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <HugeiconsIcon
        icon={DashboardSquare02Icon}
        strokeWidth={1.9}
        aria-hidden
        className="size-3.5 shrink-0"
      />
      <span className="min-w-0 truncate">{text}</span>
      <button type="button" className="ks-still__open shrink-0" onClick={open}>
        {t('stillRunning.openBoard')}
      </button>
    </div>
  )
})
