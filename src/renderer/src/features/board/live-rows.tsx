import { useId, useState } from 'react'
import { ComputerTerminal01Icon, StopIcon, ViewIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { TaskProcess } from '@shared/task-processes'
import type { BackgroundTaskView, ForegroundTaskView } from '@shared/thread'
import type { PortBlock } from '@shared/worktree-ports'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  useLoadSubagent,
  type SubagentDigestOf,
} from '@renderer/features/session/subagent/progress'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { hostOfSession, sessionTitle } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { askedStep, currentStep, lastLine, subagentWaiting } from './board-model'
import { TaskStats } from './process-parts'
import { useToBackground } from './use-to-background'
import { Clock, Fold } from './row-parts'
import { TaskDetail } from './task-detail'
import { useStopTask } from './use-stop-task'
import { useTaskOutput } from './use-task-output'

// A row that only shows a command's last line reads it less often than an opened one.
const GLANCE_MS = 5_000
const OPEN_MS = 2_000

/**
 * A sub-agent at work: its agent's mark, its name and clock, and under them its type and the
 * step it is on. One that waits for the user is tinted and says what it asks, with Review in
 * the clock's place. A click opens its page. `compact` keeps only the first line.
 */
export function AgentLive({
  child,
  digest,
  compact,
  sessionId,
  held = null,
}: {
  child: SessionSummary
  digest: SubagentDigestOf['digest']
  compact: boolean
  /** The parent's session, which a move to the background goes through. */
  sessionId: string
  /** Huli: set while it holds up the call that started it, which it can be moved out of. */
  held?: ForegroundTaskView | null
}) {
  const { t } = useTranslation('board')
  const toBackground = useToBackground(sessionId, held?.toolCallId ?? '')
  useLoadSubagent(child, true)
  const waiting = subagentWaiting(child)
  const title = sessionTitle(child)
  const open = () => openSession(child.id, child.projectPath)
  const one = compact && !waiting
  return (
    <div className="kb-item" data-wait={waiting || undefined}>
      <div className="kb-live" data-one={one || undefined}>
        <button
          type="button"
          className="kb-hit"
          aria-label={t('actions.openTitle', { title })}
          onClick={open}
        />
        <span className="kb-mark">
          <AgentMark agent={child.agentId} hostId={hostOfSession(child)} size={14} dot={null} />
          {waiting && <i className="kb-mark__badge" />}
        </span>
        <span className="kb-live__name">{title}</span>
        {waiting ? (
          <Button size="xs" className="kb-live__review kb-live__act" onClick={open}>
            {t('actions.review')}
          </Button>
        ) : (
          // A sub-agent that ran before keeps no start for this run, so it shows no time.
          digest?.durationMs == null && (
            <span className="kb-live__end">
              <Clock since={child.createdAt} />
            </span>
          )
        )}
        {!one && (
          <span className="kb-live__what">
            {waiting ? (
              (askedStep(digest, child.projectPath) ?? t('step.waiting'))
            ) : (
              <>
                {child.description && <span className="kb-live__type">{child.description} · </span>}
                <span className="shimmer">
                  {child.progress ?? currentStep(digest, child.projectPath) ?? t('step.starting')}
                </span>
              </>
            )}
          </span>
        )}
        {held && !waiting && !one && (
          <Button
            size="xs"
            variant="outline"
            className="kb-live__act kb-live__move"
            disabled={toBackground.moving}
            onClick={toBackground.move}
          >
            {t('actions.toBackground')}
          </Button>
        )}
      </div>
      {toBackground.error && (
        <p role="alert" className="kb-item__error">
          {toBackground.error}
        </p>
      )}
    </div>
  )
}

/**
 * A command or monitor the agent left running: its mark, name and clock, and under them the last
 * line it printed. A click opens it in place, where the second line is the command itself and
 * its output follows; Stop shows beside the clock on hover and stops this one task. A command
 * that runs on in its tool call has neither, so its row only names the command.
 */
export function TaskLive({
  sessionId,
  task,
  compact,
  stats = null,
  block = null,
}: {
  sessionId: string
  task: BackgroundTaskView
  compact: boolean
  /** Huli: what the board's latest reading found of its processes. */
  stats?: TaskProcess | null
  block?: PortBlock | null
}) {
  if (task.entryId !== undefined) return <CallLive task={task} compact={compact} />
  return <TaskRow sessionId={sessionId} task={task} compact={compact} stats={stats} block={block} />
}

function CallLive({ task, compact }: { task: BackgroundTaskView; compact: boolean }) {
  return (
    <div className="kb-item">
      <div className="kb-live" data-kind="task" data-one={compact || undefined}>
        <span className="kb-mark">
          <PaneIcon icon={ComputerTerminal01Icon} size={14} />
        </span>
        <span className="kb-live__name">{task.title}</span>
        <span className="kb-live__end">
          <Clock since={task.startedAt} />
        </span>
        {!compact && (
          <span className="kb-live__what kb-live__what--mono">{task.command ?? task.title}</span>
        )}
      </div>
    </div>
  )
}

function TaskRow({
  sessionId,
  task,
  compact,
  stats,
  block,
}: {
  sessionId: string
  task: BackgroundTaskView
  compact: boolean
  stats: TaskProcess | null
  block: PortBlock | null
}) {
  const { t } = useTranslation('board')
  const id = useId()
  const [open, setOpen] = useState(false)
  const output = useTaskOutput(sessionId, task.id, {
    enabled: true,
    live: true,
    every: open ? OPEN_MS : GLANCE_MS,
  })
  const { stop, stopping, error } = useStopTask(sessionId, task.id)
  const command = task.command ?? task.title
  const one = compact && !open
  return (
    <div className="kb-item" data-open={open || undefined}>
      <div className="kb-live" data-kind="task" data-one={one || undefined}>
        <button
          type="button"
          className="kb-hit"
          aria-label={task.title}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        />
        <span className="kb-mark">
          <PaneIcon icon={task.kind === 'monitor' ? ViewIcon : ComputerTerminal01Icon} size={14} />
        </span>
        <span className="kb-live__name">{task.title}</span>
        <span className="kb-live__end">
          <button
            type="button"
            className="kb-stop kb-live__act"
            aria-label={t('actions.stopTitle', { title: task.title })}
            title={t('actions.stop')}
            disabled={stopping}
            onClick={stop}
          >
            <PaneIcon icon={StopIcon} size={13} />
          </button>
          <Clock since={task.startedAt} />
        </span>
        {!one && (
          <span className="kb-live__what kb-live__what--mono">
            {open
              ? command
              : (task.progress ?? (output.text ? lastLine(output.text) : null) ?? command)}
          </span>
        )}
        {!one && stats && <TaskStats stats={stats} block={block} />}
      </div>
      {error && (
        <p role="alert" className="kb-item__error">
          {error}
        </p>
      )}
      <Fold id={id} open={open}>
        <TaskDetail task={task} output={output} onStop={stop} stopping={stopping} />
      </Fold>
    </div>
  )
}
