import { memo, useEffect, useId, useState } from 'react'
import {
  Cancel01Icon,
  Copy01Icon,
  Flowchart01Icon,
  StopIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BackgroundTaskView, WorkflowAgentView } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { shortDuration, tokens } from '@renderer/lib/format'
import { Clock, Fold } from './row-parts'
import { useStopTask } from './use-stop-task'
import { useWorkflowAgent } from './use-workflow-agent'
import { agentEnded, phaseGroups, workflowLine } from './workflow-model'

/**
 * A workflow at work: its name and clock, and under them the phases at work now as "Review 3/6".
 * A click opens its agents in place, by phase; Stop shows beside the clock on hover.
 */
export function WorkflowLive({
  sessionId,
  task,
  compact,
}: {
  sessionId: string
  task: BackgroundTaskView
  compact: boolean
}) {
  const { t } = useTranslation('board')
  const id = useId()
  const [open, setOpen] = useState(false)
  // Its agents are made once opened, so a closed row costs nothing as they change.
  const [made, setMade] = useState(false)
  const { stop, stopping, error } = useStopTask(sessionId, task.id)
  const line =
    task.progress ?? (task.workflow ? workflowLine(t, task.workflow) : null) ?? t('step.starting')
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
          onClick={() => {
            setMade(true)
            setOpen(!open)
          }}
        />
        <span className="kb-mark">
          <PaneIcon icon={Flowchart01Icon} size={14} />
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
        {!one && <span className="kb-live__what">{line}</span>}
      </div>
      {error && (
        <p role="alert" className="kb-item__error">
          {error}
        </p>
      )}
      <Fold id={id} open={open}>
        {made && <WorkflowAgents sessionId={sessionId} task={task} />}
      </Fold>
    </div>
  )
}

const TASK_STATE = { completed: 'done', failed: 'failed', stopped: 'stopped' } as const

/** A workflow that ended: how, its name and how long it took. A click opens its agents in place. */
export function EndedWorkflow({
  sessionId,
  task,
}: {
  sessionId: string
  task: BackgroundTaskView
}) {
  const { t } = useTranslation('board')
  const id = useId()
  const [open, setOpen] = useState(false)
  const [made, setMade] = useState(false)
  const state = task.status === 'running' ? 'done' : TASK_STATE[task.status]
  const took =
    state === 'failed'
      ? t('status.failed')
      : state === 'stopped'
        ? t('status.stopped')
        : shortDuration((task.endedAt ?? task.startedAt) - task.startedAt)
  const line = task.workflow ? workflowLine(t, task.workflow) : null
  return (
    <div className="kb-end-item" data-open={open || undefined}>
      <button
        type="button"
        className="kb-end"
        data-state={state}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setMade(true)
          setOpen(!open)
        }}
      >
        <span className="kb-end__mark">
          <PaneIcon
            icon={state === 'failed' ? Cancel01Icon : state === 'stopped' ? StopIcon : Tick02Icon}
            size={13}
          />
        </span>
        <span className="kb-end__name">{task.title}</span>
        <span className="kb-end__took">{line ? `${line} · ${took}` : took}</span>
      </button>
      <Fold id={id} open={open}>
        {made && (
          <>
            {task.status === 'failed' && task.summary && (
              <p className="kb-wf__summary">{task.summary}</p>
            )}
            <WorkflowAgents sessionId={sessionId} task={task} />
          </>
        )}
      </Fold>
    </div>
  )
}

/** A workflow's agents by phase, each phase headed by its title and how many of its agents finished. */
function WorkflowAgents({ sessionId, task }: { sessionId: string; task: BackgroundTaskView }) {
  const { t } = useTranslation('board')
  const view = task.workflow
  if (!view || view.agents.length === 0) {
    return <p className="kb-wf__none">{t('workflow.noAgents')}</p>
  }
  const flat = view.phases.length === 0
  return (
    <div className="kb-wf">
      {phaseGroups(view).map((group) => (
        <section
          key={group.phase?.index ?? 'loose'}
          className="kb-wf__phase"
          aria-label={group.phase?.title ?? t('workflow.otherPhase')}
        >
          {!flat && (
            <div className="kb-wf__head" data-idle={group.agents.length === 0 || undefined}>
              <span className="kb-wf__title">{group.phase?.title ?? t('workflow.otherPhase')}</span>
              {group.failed > 0 && (
                <span className="kb-wf__failed">
                  {t('earlier.failed', { count: group.failed })}
                </span>
              )}
              <span className="kb-wf__n">
                {group.agents.length === 0
                  ? t('workflow.notReached')
                  : `${group.done}/${group.agents.length}`}
              </span>
            </div>
          )}
          {group.agents.map((agent) => (
            <AgentRow key={agent.index} sessionId={sessionId} taskId={task.id} agent={agent} />
          ))}
        </section>
      ))}
    </div>
  )
}

function sameAgent(a: WorkflowAgentView, b: WorkflowAgentView): boolean {
  return (
    a.index === b.index &&
    a.label === b.label &&
    a.state === b.state &&
    a.startedAt === b.startedAt &&
    a.durationMs === b.durationMs &&
    a.progress === b.progress &&
    a.error === b.error &&
    a.cached === b.cached
  )
}

function StateMark({ state }: { state: WorkflowAgentView['state'] }) {
  if (state === 'running') return <Spinner aria-hidden className="size-3" />
  if (state === 'queued') return <i className="kb-wfa__ring" aria-hidden />
  const icon = state === 'failed' ? Cancel01Icon : state === 'stopped' ? StopIcon : Tick02Icon
  return <PaneIcon icon={icon} size={12} />
}

/**
 * One agent: how it stands, its label and its time, and under them what it does or why it failed.
 * A click opens what it was asked and gave back. Rows of agents that did not change do not render
 * again when the list does.
 */
const AgentRow = memo(
  function AgentRow({
    sessionId,
    taskId,
    agent,
  }: {
    sessionId: string
    taskId: string
    agent: WorkflowAgentView
  }) {
    const { t } = useTranslation('board')
    const id = useId()
    const [open, setOpen] = useState(false)
    const [made, setMade] = useState(false)
    const end =
      agent.state === 'running' && agent.startedAt !== null ? (
        <Clock since={agent.startedAt} />
      ) : agent.state === 'queued' ? (
        t('workflow.queued')
      ) : agent.cached ? (
        t('workflow.cached')
      ) : agent.durationMs !== null ? (
        shortDuration(agent.durationMs)
      ) : agent.state === 'failed' ? (
        t('status.failed')
      ) : agent.state === 'stopped' ? (
        t('status.stopped')
      ) : null
    const what =
      agent.state === 'running'
        ? (agent.progress ?? t('step.starting'))
        : agent.state === 'failed' || agent.state === 'stopped'
          ? agent.error
          : null
    return (
      <div className="kb-wfa-item" data-open={open || undefined}>
        <button
          type="button"
          className="kb-wfa"
          data-state={agent.state}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            setMade(true)
            setOpen(!open)
          }}
        >
          <span className="kb-wfa__mark">
            <StateMark state={agent.state} />
          </span>
          <span className="kb-wfa__name">{agent.label}</span>
          {end !== null && <span className="kb-wfa__end">{end}</span>}
          {what && (
            <span className="kb-wfa__what" data-live={agent.state === 'running' || undefined}>
              {what}
            </span>
          )}
        </button>
        <Fold id={id} open={open}>
          {made && <AgentDetail sessionId={sessionId} taskId={taskId} agent={agent} open={open} />}
        </Fold>
      </div>
    )
  },
  (a, b) => a.sessionId === b.sessionId && a.taskId === b.taskId && sameAgent(a.agent, b.agent),
)

/**
 * What an agent was asked and gave back, read when its row opens and again as it ends: its last
 * message from its transcript where that could be read, else the start Claude Code reported.
 */
function AgentDetail({
  sessionId,
  taskId,
  agent,
  open,
}: {
  sessionId: string
  taskId: string
  agent: WorkflowAgentView
  open: boolean
}) {
  const { t } = useTranslation('board')
  const read = useWorkflowAgent(sessionId, taskId, agent.index, agent.state, open)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const { detail } = read
  if (!detail) {
    return (
      <div className="kb-detail kb-wfa__detail">
        {read.error ? (
          <p role="alert" className="kb-detail__error">
            {t('workflow.readFailed', { error: read.error })}
          </p>
        ) : (
          <div className="kb-wfa__loading" aria-busy>
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        )}
      </div>
    )
  }
  const answer = detail.reply?.text ?? detail.result
  const meta = [
    detail.model,
    detail.tokens !== null ? t('workflow.tokens', { tokens: tokens(detail.tokens) }) : null,
    detail.toolCalls !== null ? t('workflow.toolCalls', { count: detail.toolCalls }) : null,
    detail.attempt !== null && detail.attempt > 1
      ? t('workflow.attempt', { attempt: detail.attempt })
      : null,
  ].filter((part): part is string => !!part)
  const note = detail.reply?.truncated
    ? t('workflow.replyCut')
    : !detail.reply && detail.result
      ? t('workflow.previewOnly')
      : null
  return (
    <div className="kb-detail kb-wfa__detail" data-selectable="">
      {detail.prompt && (
        <>
          <span className="kb-detail__label">{t('workflow.prompt')}</span>
          <p className="kb-wfa__text kb-wfa__text--clip">{detail.prompt}</p>
        </>
      )}
      {answer ? (
        <>
          <span className="kb-detail__label">
            {t(detail.reply ? 'workflow.reply' : 'workflow.result')}
          </span>
          <p className="kb-wfa__text kb-wfa__text--scroll">{answer}</p>
        </>
      ) : (
        <p className="kb-detail__none">
          {t(agentEnded(agent) ? 'workflow.noResult' : 'workflow.working')}
        </p>
      )}
      {detail.error && (
        <>
          <span className="kb-detail__label">{t('workflow.error')}</span>
          <p className="kb-wfa__text kb-wfa__text--error">{detail.error}</p>
        </>
      )}
      {note && <p className="kb-detail__note">{note}</p>}
      {meta.length > 0 && <p className="kb-detail__note">{meta.join(' · ')}</p>}
      {read.error && (
        <p role="alert" className="kb-detail__error">
          {t('workflow.readFailed', { error: read.error })}
        </p>
      )}
      {answer && (
        <div className="kb-detail__acts">
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              void navigator.clipboard.writeText(answer).then(() => setCopied(true))
            }}
          >
            <PaneIcon icon={copied ? Tick02Icon : Copy01Icon} size={12} />
            {t(copied ? 'actions.copied' : 'actions.copy')}
          </Button>
        </div>
      )}
    </div>
  )
}
