// Huli: the 工人 pane of a manager session: each worker with its role, agent and model, what it is
// doing and its last report line, the permission requests it waits on, answered here, and the
// controls for one worker or all of them. It draws from the session list and fetches a worker's
// requests only while that worker waits, so nothing here runs while the workers are idle.

import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Crown02Icon,
  Loading03Icon,
  PauseIcon,
  PlayIcon,
  StopCircleIcon,
  UserGroupIcon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { SecretRequestEntry, ThreadEntry, ToolEntry } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { PermissionEntry } from '@renderer/features/session/entries/permission-card'
import { SecretCard } from '@renderer/features/session/entries/secret-request-entry'
import { Glyph } from '@renderer/features/shell/glyph'
import {
  PaneBody,
  PaneContext,
  PaneEmpty,
  PaneIcon,
} from '@renderer/features/shell/panel-button'
import { clockTime } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession, panelSession } from '@renderer/stores/view'
import {
  isWorking,
  messageWorker,
  moreTurns,
  setDetached,
  setPaused,
  stopAll,
  stopWorker,
  usageText,
  useWorkerIds,
  workerState,
  workerTree,
  type WorkerState,
} from './model'
import './manager.css'

const STATE_GLYPH: Record<WorkerState, IconSvgElement> = {
  starting: Loading03Icon,
  running: Loading03Icon,
  waiting: Alert02Icon,
  limit: PauseIcon,
  done: CheckmarkCircle02Icon,
  failed: Alert02Icon,
  stopped: StopCircleIcon,
  idle: CheckmarkCircle02Icon,
}

export default function WorkersPane({ panel }: { panel: string }) {
  const { t } = useTranslation('session')
  const managerId = panelSession(panel) ?? ''
  const summary = useSessionsStore((s) => s.byId[managerId])
  const ids = useWorkerIds(managerId)
  const byId = useSessionsStore((s) => s.byId)
  const manager = summary?.manager
  const tree = workerTree(ids, byId)
  const spent = manager ? manager.turns >= manager.maxTurns : false

  return (
    <PaneBody>
      <PaneContext>
        <span className="km-head">
          <b>{t('manager.pane.title')}</b>
          {manager && (
            <span>
              {t('manager.pane.turns', { turns: manager.turns, max: manager.maxTurns })}
              {' · '}
              {usageText(manager.tokens, manager.cost, manager.unpriced)}
            </span>
          )}
        </span>
      </PaneContext>
      <div className="kp-body km-body">
        {!manager ? (
          <PaneEmpty
            icon={<PaneIcon icon={Crown02Icon} />}
            title={t('manager.pane.notManager')}
            text={t('manager.pane.notManagerText')}
          />
        ) : (
          <>
            <ManagerState summary={summary} spent={spent} />
            {tree.length === 0 ? (
              <PaneEmpty
                icon={<PaneIcon icon={UserGroupIcon} />}
                title={t('manager.pane.empty')}
                text={t('manager.pane.emptyText')}
              />
            ) : (
              <ul className="km-list">
                {tree.map((node) => (
                  <li key={node.id}>
                    <WorkerRow id={node.id} />
                    {node.children.length > 0 && (
                      <ul className="km-children">
                        {node.children.map((child) => (
                          <li key={child}>
                            <WorkerRow id={child} nested />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {manager.answers.length > 0 && (
              <section className="km-answers" aria-label={t('manager.pane.answers')}>
                <h3>{t('manager.pane.answers')}</h3>
                <ul>
                  {manager.answers
                    .slice()
                    .reverse()
                    .map((answer) => (
                      <li key={`${answer.at}:${answer.workerId}`}>
                        <span className={answer.allowed ? 'text-success' : 'text-danger'}>
                          {answer.allowed ? t('manager.pane.allowed') : t('manager.pane.denied')}
                        </span>{' '}
                        {answer.name} · {answer.what}
                        <span className="km-faint"> · {clockTime(answer.at)}</span>
                      </li>
                    ))}
                </ul>
              </section>
            )}
            <div className="km-foot">
              {manager.held > 0 && (
                <span className="km-faint">{t('manager.pane.held', { count: manager.held })}</span>
              )}
              <span className="flex-1" />
              {spent && (
                <Button size="sm" variant="outline" onClick={() => void moreTurns(managerId)}>
                  {t('manager.pane.moreTurns')}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void setPaused(managerId, !manager.paused)}
              >
                <Glyph icon={manager.paused ? PlayIcon : PauseIcon} size={14} />
                {manager.paused ? t('manager.pane.resume') : t('manager.pane.pause')}
              </Button>
              <Button size="sm" variant="destructive" onClick={() => void stopAll(managerId)}>
                <Glyph icon={StopCircleIcon} size={14} />
                {t('manager.stopAll')}
              </Button>
            </div>
          </>
        )}
      </div>
    </PaneBody>
  )
}

/** What holds the manager back now: paused, stopped, its budget, a report waiting to go. */
function ManagerState({ summary, spent }: { summary: SessionSummary; spent: boolean }) {
  const { t } = useTranslation('session')
  const manager = summary.manager!
  const lines: { key: string; tone: 'warn' | 'info'; text: string }[] = []
  if (manager.stopped)
    lines.push({ key: 'stopped', tone: 'info', text: t('manager.state.stopped') })
  else if (manager.paused)
    lines.push({ key: 'paused', tone: 'info', text: t('manager.state.paused') })
  if (spent) lines.push({ key: 'spent', tone: 'warn', text: t('manager.state.spent') })
  if (manager.budget !== null && manager.tokens >= manager.budget) {
    lines.push({ key: 'tokens', tone: 'warn', text: t('manager.state.tokens') })
  }
  if (manager.pending && summary.status === 'failed') {
    lines.push({ key: 'pending', tone: 'warn', text: t('manager.state.pending') })
  }
  const choices = [
    manager.autoReview ? t('manager.state.autoReviewOn') : t('manager.state.autoReviewOff'),
    manager.approvals === 'low' ? t('manager.approvals.low') : t('manager.approvals.user'),
  ].join(' · ')
  return (
    <div className="km-state">
      <span className="km-faint">{choices}</span>
      {lines.map((line) => (
        <p key={line.key} className={cn('km-note', line.tone === 'warn' && 'km-note--warn')}>
          {line.text}
        </p>
      ))}
    </div>
  )
}

const WorkerRow = memo(function WorkerRow({ id, nested }: { id: string; nested?: boolean }) {
  const { t } = useTranslation('session')
  const summary = useSessionsStore((s) => s.byId[id])
  const [writing, setWriting] = useState(false)
  if (!summary?.worker) return null
  const worker = summary.worker
  const state = workerState(summary)
  const hostId = hostOfPath(summary.projectPath)
  const runs = [agentName(summary.agentId, hostId), summary.model].filter(Boolean).join(' · ')
  const loop =
    worker.reviewOf && worker.loop === 'fixing'
      ? t('manager.loop.waitingFix', { round: worker.round ?? 1 })
      : worker.loop === 'reviewing' || worker.loop === 'fixing'
        ? t(`manager.loop.${worker.loop}`, { round: worker.round ?? 1 })
        : worker.loop === 'approved'
          ? t('manager.loop.approved', { round: worker.round ?? 1 })
          : worker.loop === 'out_of_rounds'
            ? t('manager.loop.outOfRounds')
            : null
  return (
    <div className={cn('km-row', nested && 'km-row--nested')} data-state={state}>
      <div className="km-row__top">
        <AgentMark agent={summary.agentId} size={16} hostId={hostId} />
        <button
          type="button"
          className="km-row__name"
          onClick={() => openSession(summary.id, summary.projectPath)}
        >
          <b>{worker.name}</b>
          <span className="km-faint"> · {t(`manager.role.${worker.kind}`)}</span>
        </button>
        <span className="km-pill" data-state={state}>
          <Glyph
            icon={STATE_GLYPH[state]}
            size={12}
            className={cn(isWorking(state) && state !== 'waiting' && 'km-spin')}
          />
          {worker.detached ? t('manager.state.takenOver') : t(`manager.worker.${state}`)}
        </span>
      </div>
      <div className="km-row__meta">
        <span className="truncate">{worker.title || sessionTitle(summary)}</span>
        <span className="km-faint">
          {runs}
          {summary.turnStartedAt
            ? ` · ${t('manager.worker.since', { time: clockTime(summary.turnStartedAt) })}`
            : ''}
          {worker.tokens > 0 ? ` · ${usageText(worker.tokens, worker.cost)}` : ''}
        </span>
      </div>
      {loop && <p className="km-row__loop">{loop}</p>}
      {state === 'limit' && (
        <p className="km-row__loop">
          {summary.limitPause
            ? t('manager.worker.limitResumes', { time: clockTime(summary.limitPause.resumeAt) })
            : t('manager.worker.limitStopped')}
        </p>
      )}
      {worker.line && <p className="km-row__line">“{worker.line}”</p>}
      {summary.permissionCount > 0 && <WorkerRequests summary={summary} />}
      <div className="km-row__actions">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => openSession(summary.id, summary.projectPath)}
        >
          {t('manager.worker.open')}
        </Button>
        {!worker.detached && (
          <Button size="xs" variant="ghost" onClick={() => setWriting((v) => !v)}>
            {t('manager.worker.message')}
          </Button>
        )}
        {isWorking(state) && (
          <Button size="xs" variant="ghost" onClick={() => void stopWorker(summary.id)}>
            {t('manager.worker.stop')}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void setDetached(summary.id, !worker.detached)}
        >
          {worker.detached ? t('manager.worker.handBack') : t('manager.worker.takeOver')}
        </Button>
      </div>
      {writing && (
        <WorkerMessage id={summary.id} name={worker.name} onDone={() => setWriting(false)} />
      )}
    </div>
  )
})

/** A message from the user to one worker; it waits behind the worker's turn, as a queued one does. */
function WorkerMessage({ id, name, onDone }: { id: string; name: string; onDone: () => void }) {
  const { t } = useTranslation('session')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const send = async () => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    const sent = await messageWorker(id, trimmed)
    setSending(false)
    if (sent) onDone()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') onDone()
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    void send()
  }
  return (
    <div className="km-message">
      <Textarea
        ref={ref}
        rows={2}
        value={text}
        placeholder={t('manager.worker.messagePlaceholder', { name })}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="km-message__foot">
        <span className="km-faint">{t('manager.worker.messageNote')}</span>
        <Button size="xs" disabled={!text.trim() || sending} onClick={() => void send()}>
          {t('manager.worker.send')}
        </Button>
      </div>
    </div>
  )
}

type Waiting = ToolEntry | SecretRequestEntry

/** The requests and secret cards a worker waits on, answered here as in its own thread. */
function WorkerRequests({ summary }: { summary: SessionSummary }) {
  const [entries, setEntries] = useState<Waiting[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const { id, permissionCount } = summary
  useEffect(() => {
    let live = true
    host('sessions.requests', { sessionId: id })
      .then(({ entries: all }) => {
        if (!live) return
        setEntries(
          all.filter(
            (entry: ThreadEntry): entry is Waiting =>
              (entry.kind === 'tool' && !!entry.permission) ||
              (entry.kind === 'secret_request' && entry.outcome === null),
          ),
        )
        setError(null)
      })
      .catch((failed: unknown) => live && setError(errorMessage(failed)))
    return () => {
      live = false
    }
  }, [id, permissionCount])
  if (error) return <p className="km-note km-note--warn">{error}</p>
  if (!entries) return null
  const name = agentName(summary.agentId, hostOfPath(summary.projectPath))
  return (
    <div ref={ref} className="km-requests">
      {entries.map((entry) =>
        entry.kind === 'secret_request' ? (
          <SecretCard key={entry.id} sessionId={id} entry={entry} agentName={name} />
        ) : (
          <PermissionEntry
            key={entry.permission?.requestId ?? entry.id}
            ref={ref}
            sessionId={id}
            entry={entry}
            projectPath={summary.projectPath}
            agentName={name}
            media={[]}
          />
        ),
      )}
    </div>
  )
}
