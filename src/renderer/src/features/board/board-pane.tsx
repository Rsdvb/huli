import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ComputerTerminal01Icon,
  DashboardSquare02Icon,
  UserMultiple02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { BackgroundTaskView, ForegroundTaskView } from '@shared/thread'
import { RefreshIcon } from '@renderer/components/refresh-icon'
import { Button } from '@renderer/components/ui/button'
import { errorMessage, host } from '@renderer/lib/host'
import { subagentRunning, useSubagentDigests } from '@renderer/features/session/subagent/progress'
import { PaneBody, PaneEmpty, PaneIcon } from '@renderer/features/shell/panel-button'
import { artifactListShown, artifactStanding, useArtifactsStore } from '@renderer/stores/artifacts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { ArtifactRow } from './artifact-row'
import {
  backgroundOrder,
  boardSubagents,
  subagentFailed,
  summaryParts,
  threadArtifacts,
  type BoardArtifact,
} from './board-model'
import { EndedAgent, EndedGroup, EndedTask } from './earlier'
import { AgentLive, TaskLive } from './live-rows'
import { HeldLive, TakenPorts } from './process-parts'
import { useBoardActivity } from './use-board-activity'
import { useSessionProcesses } from './use-session-processes'
import './board.css'

const NO_ARTIFACTS: BoardArtifact[] = []
const NO_TASKS: BackgroundTaskView[] = []
const NO_HELD: ForegroundTaskView[] = []
// Past this many live rows, those that do not wait for the user keep one line.
const ROOMY = 6

/**
 * What the session's Board tab shows in the side panel. It answers what the session has going: Now is one card of what is live, those waiting for the user first,
 * then sub-agents, then commands; Earlier counts what ended, a line a kind; Artifacts is what
 * the session wrote.
 */
export default function BoardPane({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('board')
  const background = useThreadsStore(
    (s) => s.replicas[sessionId]?.state?.session.background ?? NO_TASKS,
  )
  const held = useThreadsStore((s) => s.replicas[sessionId]?.state?.session.foreground ?? NO_HELD)
  const turning = useThreadsStore((s) => s.replicas[sessionId]?.state?.session.status === 'running')
  // Read again when a task starts or ends, something comes to hold up a call, or a turn ends.
  const key = [
    ...background.filter((task) => task.status === 'running').map((task) => task.id),
    '|',
    ...held.map((task) => task.toolCallId),
    turning ? 'turn' : 'idle',
  ].join(' ')
  const processes = useSessionProcesses(sessionId, key)
  const tasks = processes.data?.tasks ?? background
  const stats = useMemo(
    () => new Map((processes.data?.processes ?? []).map((item) => [item.taskId, item])),
    [processes.data],
  )
  const block = processes.data?.block ?? null
  const clean = processes.data?.clean ?? null
  const [cleaning, setCleaning] = useState(false)
  const [cleanError, setCleanError] = useState<string | null>(null)
  const runClean = () => {
    setCleaning(true)
    setCleanError(null)
    host('sessions.cleanTasks', { sessionId })
      .catch((reason: unknown) => setCleanError(errorMessage(reason)))
      .finally(() => {
        setCleaning(false)
        processes.refresh()
      })
  }
  const children = useSessionsStore(
    useShallow((s) =>
      Object.values(s.byId).filter(
        (child) => child.parentId === sessionId && child.origin === 'subagent',
      ),
    ),
  )
  const written = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    return state ? threadArtifacts(state) : NO_ARTIFACTS
  })
  const artifacts = useArtifactsStore(
    useShallow((s) => written.filter((a) => artifactStanding(s, a.artifactId) === 'live')),
  )
  const activity = useBoardActivity(sessionId)

  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])

  const subagents = boardSubagents(children)
  const idKey = subagents.map((child) => child.id).join(' ')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the key stands for the ids
  const ids = useMemo(() => subagents.map((child) => child.id), [idKey])
  const digests = useSubagentDigests(ids)

  const liveAgents = subagents.filter(subagentRunning)
  const endedAgents = subagents.filter((child) => !subagentRunning(child))
  const ordered = backgroundOrder(tasks)
  const liveTasks = ordered.filter((task) => task.status === 'running')
  const endedTasks = ordered.filter((task) => task.status !== 'running')
  const heldCommands = held.filter((task) => task.kind === 'shell')
  const heldAgents = new Map(
    held.filter((task) => task.kind === 'subagent').map((task) => [task.taskId, task]),
  )
  const live = heldCommands.length + liveAgents.length + liveTasks.length
  const compact = live > ROOMY
  const empty =
    subagents.length === 0 && tasks.length === 0 && held.length === 0 && artifacts.length === 0
  const notes = [processes.error, processes.data?.error ?? null, cleanError].filter(
    (note): note is string => !!note,
  )
  const parts = summaryParts(t, activity)
  const failedFirst = <T,>(items: T[], failed: (item: T) => boolean) => [
    ...items.filter(failed),
    ...items.filter((item) => !failed(item)),
  ]

  let body: ReactNode
  if (empty) {
    body = (
      <PaneEmpty
        icon={<PaneIcon icon={DashboardSquare02Icon} size={20} />}
        title={t('empty.title')}
        text={t('empty.text')}
      />
    )
  } else {
    body = (
      <div className="kb-scroll">
        {block && processes.data && <TakenPorts taken={processes.data.taken} block={block} />}
        {notes.map((note) => (
          <p key={note} role="alert" className="kb-note">
            {note}
          </p>
        ))}
        {live > 0 && (
          <section aria-label={t('sections.now')}>
            <div className="kb-label kb-label--acts">
              <h3>{t('sections.now')}</h3>
              {clean === 'all' && liveTasks.length > 0 && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="kb-label__act"
                  disabled={cleaning}
                  onClick={runClean}
                >
                  {t('actions.stopAll')}
                </Button>
              )}
            </div>
            <div className="kb-now">
              {heldCommands.map((task) => (
                <HeldLive key={task.toolCallId} sessionId={sessionId} task={task} />
              ))}
              {liveAgents.map((child) => (
                <AgentLive
                  key={child.id}
                  child={child}
                  digest={digests[child.id]?.digest ?? null}
                  compact={compact}
                  sessionId={sessionId}
                  held={child.acpSessionId ? (heldAgents.get(child.acpSessionId) ?? null) : null}
                />
              ))}
              {liveTasks.map((task) => (
                <TaskLive
                  key={task.id}
                  sessionId={sessionId}
                  task={task}
                  compact={compact}
                  stats={stats.get(task.id) ?? null}
                  block={block}
                />
              ))}
            </div>
          </section>
        )}
        {(endedAgents.length > 0 || endedTasks.length > 0) && (
          <section aria-label={t('sections.earlier')}>
            <div className="kb-label kb-label--acts">
              <h3>{t('sections.earlier')}</h3>
              {clean === 'ended' && endedTasks.length > 0 && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="kb-label__act"
                  disabled={cleaning}
                  onClick={runClean}
                >
                  {t('actions.clean')}
                </Button>
              )}
            </div>
            {endedAgents.length > 0 && (
              <EndedGroup
                // Opened by itself once nothing is live, when it is all there is to read.
                key={live === 0 ? 'idle' : 'busy'}
                icon={UserMultiple02Icon}
                name={t('earlier.subagents')}
                count={endedAgents.length}
                failed={endedAgents.filter(subagentFailed).length}
                open={live === 0}
              >
                {failedFirst(endedAgents, subagentFailed).map((child) => (
                  <EndedAgent
                    key={child.id}
                    child={child}
                    digest={digests[child.id]?.digest ?? null}
                  />
                ))}
              </EndedGroup>
            )}
            {endedTasks.length > 0 && (
              <EndedGroup
                icon={ComputerTerminal01Icon}
                name={t('earlier.commands')}
                count={endedTasks.length}
                failed={endedTasks.filter((task) => task.status === 'failed').length}
              >
                {failedFirst(endedTasks, (task) => task.status === 'failed').map((task) => (
                  <EndedTask key={task.id} sessionId={sessionId} task={task} />
                ))}
              </EndedGroup>
            )}
          </section>
        )}
        {artifacts.length > 0 && (
          <section aria-label={t('sections.artifacts')}>
            <h3 className="kb-label">{t('sections.artifacts')}</h3>
            {artifacts.map((artifact) => (
              <ArtifactRow
                key={artifact.artifactId}
                sessionId={sessionId}
                entryId={artifact.entryId}
                artifactId={artifact.artifactId}
              />
            ))}
          </section>
        )}
      </div>
    )
  }

  return (
    <PaneBody className="kb-pane" aria-label={t('title')}>
      <div className="kb-head">
        <span className="kb-head__sum" aria-live="polite">
          {parts.running === null && parts.needs === null ? (
            t('summary.idle')
          ) : (
            <>
              {parts.running}
              {parts.running !== null && parts.needs !== null && ' · '}
              {parts.needs !== null && <b className="kb-head__needs">{parts.needs}</b>}
            </>
          )}
        </span>
        {(tasks.length > 0 || held.length > 0) && (
          <button
            type="button"
            className="kp-tool kb-head__refresh"
            aria-label={t('actions.refresh')}
            title={t('actions.refresh')}
            disabled={processes.reading}
            onClick={processes.refresh}
          >
            <RefreshIcon phase={processes.reading ? 'turning' : 'idle'} className="size-[15px]" />
          </button>
        )}
      </div>
      <div className="kb-body">{body}</div>
    </PaneBody>
  )
}
