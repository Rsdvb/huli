// Huli: the dialog of 搬到另一台电脑… in a session's menu: the computer to move it to, what main
// found on both sides and would do, then the move's steps as main runs them, and the session
// there once it is. Mounted once for the window.

import { useEffect, useRef, useState } from 'react'
import {
  Alert02Icon,
  Cancel01Icon,
  InformationCircleIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import type {
  MoveHost,
  MoveNote,
  MovePreview,
  MovePreviewResult,
  MoveProblem,
  MoveProgress,
} from '@shared/session-move'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { RadioGroup, RadioGroupTile } from '@renderer/components/ui/radio-group'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { HostIcon, OnlineDot } from '@renderer/features/settings/remote-parts'
import { Glyph } from '@renderer/features/shell/glyph'
import { bytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { onHost } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { useHostsStore, useOtherHosts } from '@renderer/stores/hosts'
import { hostOfSession, sessionTitle } from '@renderer/stores/sessions'
import {
  closeMove,
  openMoved,
  previewMove,
  runningMove,
  startMove,
  useMoveStore,
  type MoveDrop,
} from './move'

export function SessionMoveDialog() {
  const summary = useMoveStore((s) => s.summary)
  return (
    <Dialog open={summary !== null} onOpenChange={(open) => !open && closeMove()}>
      <DialogContent className="sm:max-w-lg">
        {summary && <MoveForm key={summary.id} summary={summary} />}
      </DialogContent>
    </Dialog>
  )
}

interface Computer {
  host: MoveHost
  name: string
  platform: Platform
  online: boolean
}

/** The computers a session of `from` can move to: every other one this computer knows. */
function useComputers(from: MoveHost): Computer[] {
  const others = useOtherHosts()
  const self = useHostsStore((s) => s.status?.self ?? null)
  const list: Computer[] = others
    .filter((host) => host.id !== from)
    .map((host) => ({
      host: host.id,
      name: host.name,
      platform: host.platform,
      online: host.connection.state === 'online',
    }))
  if (from !== null && self) {
    list.unshift({ host: null, name: self.name, platform: self.platform, online: true })
  }
  return list
}

const key = (host: MoveHost): string => host ?? 'this-computer'

function MoveForm({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation(['session', 'common'])
  const from = hostOfSession(summary)
  const computers = useComputers(from)
  // Huli: dropped on another computer's project in the sidebar, with any other picked sessions.
  const more = useMoveStore((s) => s.more)
  const dropped = useMoveStore((s) => s.dropped)
  const [target, setTarget] = useState<MoveHost | undefined>(dropped?.host)
  const preview = useMoveStore((s) => s.preview)
  const others = useOtherPreviews(more)
  // A move of this session main runs already shows its steps, as when the dialog opens again.
  const [moveIds, setMoveIds] = useState<string[]>(() => {
    const running = runningMove(summary.id)
    return running ? [running] : []
  })
  const moveId = moveIds.at(-1) ?? null
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const progress = useMoveStore((s) => (moveId ? (s.moves[moveId] ?? null) : null))
  const sessions = [summary, ...more]

  const choose = (host: MoveHost) => {
    setTarget(host)
    previewMove(summary, host)
    others.ask(host)
  }

  // The computer of the project the sessions were dropped on is picked as the dialog opens.
  const asked = useRef(false)
  const askOthers = others.ask
  useEffect(() => {
    if (asked.current || !dropped) return
    asked.current = true
    previewMove(summary, dropped.host)
    askOthers(dropped.host)
  }, [dropped, summary, askOthers])

  // Several sessions move one after another; one that fails stops the rest.
  const next = sessions[moveIds.length]
  useEffect(() => {
    if (progress?.state !== 'done' || !next || target === undefined) return
    let gone = false
    startMove(next, target).then(
      (id) => !gone && setMoveIds((ids) => [...ids, id]),
      (e: unknown) => !gone && setError(errorMessage(e)),
    )
    return () => {
      gone = true
    }
  }, [progress?.state, next, target])

  const start = async () => {
    if (target === undefined) return
    setStarting(true)
    setError(null)
    try {
      setMoveIds([await startMove(summary, target)])
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setStarting(false)
    }
  }

  const ready =
    preview !== null &&
    preview !== 'loading' &&
    preview.ok &&
    preview.preview.problems.length === 0 &&
    others.ready
  const finished = progress?.state === 'done' && !next
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {more.length > 0 ? t('move.titleMany', { count: sessions.length }) : t('move.title')}
        </DialogTitle>
        <DialogDescription className="truncate">
          {sessions.map((item) => sessionTitle(item)).join(t('move.titleSeparator'))}
        </DialogDescription>
      </DialogHeader>
      {moveId ? (
        <div className="flex flex-col gap-4">
          {sessions.length > 1 && <MoveQueue sessions={sessions} moveIds={moveIds} />}
          <MoveSteps progress={progress} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {computers.length === 0 ? (
            <p className="text-control text-muted-foreground">{t('move.noComputers')}</p>
          ) : (
            <RadioGroup
              aria-label={t('move.to')}
              value={target === undefined ? '' : key(target)}
              onValueChange={(value) => {
                const picked = computers.find((computer) => key(computer.host) === value)
                if (picked) choose(picked.host)
              }}
              className="gap-1.5"
            >
              {computers.map((computer) => (
                <RadioGroupTile
                  key={key(computer.host)}
                  value={key(computer.host)}
                  disabled={!computer.online}
                >
                  <div className="flex items-center gap-2">
                    <HostIcon platform={computer.platform} className="size-4 text-icon" />
                    <span className="min-w-0 flex-1 truncate text-control font-medium text-foreground">
                      {computer.name}
                    </span>
                    {computer.online ? (
                      <OnlineDot />
                    ) : (
                      <span className="text-hint text-muted-foreground">{t('move.offline')}</span>
                    )}
                  </div>
                </RadioGroupTile>
              ))}
            </RadioGroup>
          )}
          {preview === 'loading' && (
            <div className="flex flex-col gap-2" aria-busy>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}
          {preview !== null && preview !== 'loading' && !preview.ok && (
            <p role="alert" className="text-hint text-danger">
              {preview.reason
                ? t(`move.problems.${preview.reason}`, { agent: '' })
                : preview.message}
            </p>
          )}
          {preview !== null && preview !== 'loading' && preview.ok && (
            <MovePlan preview={preview.preview} host={target ?? null} dropped={dropped} />
          )}
          {others.problems.length > 0 && (
            <ul className="flex flex-col gap-1.5" role="alert">
              {others.problems.map(({ id, text }) => (
                <li key={id} className="flex items-start gap-2 text-control text-danger">
                  <Glyph icon={Alert02Icon} size={15} className="mt-0.5 shrink-0" />
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="text-hint text-danger">
              {error}
            </p>
          )}
        </div>
      )}
      <DialogFooter>
        {moveId ? (
          <>
            <DialogClose render={<Button variant="outline" size="dialog" />}>
              {t('common:actions.close')}
            </DialogClose>
            {finished && progress.result && (
              <Button
                size="dialog"
                onClick={() => {
                  openMoved(
                    progress.targetHost,
                    progress.result!.sessionId,
                    progress.result!.projectPath,
                  )
                  closeMove()
                }}
              >
                {t('move.open')}
              </Button>
            )}
          </>
        ) : (
          <>
            <DialogClose render={<Button variant="outline" size="dialog" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <Button size="dialog" disabled={!ready || starting} onClick={() => void start()}>
              {starting && <Spinner />}
              {t('move.start')}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  )
}

/**
 * Huli: what main found for each of the other sessions dropped with the first, for the computer
 * picked: whether they are ready, and what stops each one.
 */
function useOtherPreviews(more: readonly SessionSummary[]) {
  const { t } = useTranslation('session')
  const [results, setResults] = useState<Record<string, MovePreviewResult | 'loading'>>({})
  const turn = useRef(0)
  const [ask] = useState(() => (host: MoveHost) => {
    const mine = ++turn.current
    setResults(Object.fromEntries(more.map((item) => [item.id, 'loading' as const])))
    for (const item of more) {
      const done = (result: MovePreviewResult) => {
        if (mine === turn.current) setResults((all) => ({ ...all, [item.id]: result }))
      }
      window.kettu
        .moves!.preview(hostOfSession(item), item.id, host)
        .then(done, (e: unknown) => done({ ok: false, reason: null, message: errorMessage(e) }))
    }
  })
  const problems = more.flatMap((item) => {
    const result = results[item.id]
    if (!result || result === 'loading') return []
    const reasons = result.ok
      ? result.preview.problems.map((problem) =>
          t(`move.problems.${problem}`, { agent: result.preview.target.agent?.name ?? '' }),
        )
      : [result.reason ? t(`move.problems.${result.reason}`, { agent: '' }) : result.message]
    return reasons.map((why) => ({
      id: `${item.id}:${why}`,
      text: t('move.oneOf', { title: sessionTitle(item), why }),
    }))
  })
  const ready = more.every((item) => {
    const result = results[item.id]
    return !!result && result !== 'loading' && result.ok && result.preview.problems.length === 0
  })
  return { ask, problems, ready }
}

/** Huli: the sessions of a drop of several, each with how its move went so far. */
function MoveQueue({ sessions, moveIds }: { sessions: SessionSummary[]; moveIds: string[] }) {
  const moves = useMoveStore((s) => s.moves)
  return (
    <ol className="flex flex-col gap-1.5">
      {sessions.map((item, index) => {
        const moveId = moveIds[index]
        const state = moveId ? (moves[moveId]?.state ?? 'running') : 'pending'
        return (
          <li key={item.id} className="flex items-center gap-2.5 text-control">
            <span className="flex size-4 shrink-0 items-center justify-center">
              {state === 'running' ? (
                <Spinner />
              ) : state === 'done' ? (
                <Glyph icon={Tick02Icon} size={15} className="text-success" />
              ) : state === 'failed' ? (
                <Glyph icon={Cancel01Icon} size={15} className="text-danger" />
              ) : (
                <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/40" />
              )}
            </span>
            <span
              className={cn(
                'min-w-0 truncate',
                state === 'pending' ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {sessionTitle(item)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** What main found on both sides and would do, what stops it, and what to know. */
function MovePlan({
  preview,
  host,
  dropped,
}: {
  preview: MovePreview
  host: MoveHost
  dropped: MoveDrop | null
}) {
  const { t } = useTranslation('session')
  const { source, target, targetName } = preview
  const agent = target.agent?.name ?? source.agentName
  const git = source.git
  const remote = git?.remotes.find((item) => item.name === git.remote)
  const lines: string[] = []
  if (target.project)
    lines.push(t('move.plan.project', { name: targetName, path: target.project.path }))
  else if (target.clonePath && remote) {
    lines.push(t('move.plan.clone', { name: targetName, url: remote.url, path: target.clonePath }))
  }
  if (git) {
    lines.push(
      git.changes > 0
        ? t('move.plan.branchChanges', {
            branch: git.branch ?? git.head.slice(0, 8),
            count: git.changes,
          })
        : t('move.plan.branch', { branch: git.branch ?? git.head.slice(0, 8) }),
    )
    lines.push(t(source.worktree || target.project ? 'move.plan.worktree' : 'move.plan.inClone'))
  }
  lines.push(t(source.conversation === 'carry' ? 'move.plan.carry' : 'move.plan.resume', { agent }))
  lines.push(t('move.plan.here'))
  // Huli: dropped on a project of that computer that is not the session's repository there.
  const into = target.project ? onHost(host, target.project.path) : null
  const elsewhere =
    dropped && dropped.host === host && into?.toLowerCase() !== dropped.projectPath.toLowerCase()
      ? target.project
        ? t('move.plan.otherProject', { name: dropped.projectName, path: target.project.path })
        : t('move.plan.otherProjectClone', {
            name: dropped.projectName,
            path: target.clonePath ?? '',
          })
      : null
  const values = { agent, name: targetName }
  const problems = preview.problems.map((item: MoveProblem) => t(`move.problems.${item}`, values))
  const notes = preview.notes.map((item: MoveNote) => t(`move.notes.${item}`, values))
  return (
    <div className="flex flex-col gap-3">
      {elsewhere && (
        <p className="flex items-start gap-2 text-control text-warning">
          <Glyph icon={InformationCircleIcon} size={15} className="mt-0.5 shrink-0" />
          <span>{elsewhere}</span>
        </p>
      )}
      {preview.problems.length > 0 && (
        <ul className="flex flex-col gap-1.5" role="alert">
          {problems.map((text) => (
            <li key={text} className="flex items-start gap-2 text-control text-danger">
              <Glyph icon={Alert02Icon} size={15} className="mt-0.5 shrink-0" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1.5">
        <div className="text-hint font-medium text-muted-foreground">{t('move.plan.title')}</div>
        <ul className="flex flex-col gap-1.5">
          {lines.map((text) => (
            <li key={text} className="text-control break-words text-foreground">
              {text}
            </li>
          ))}
        </ul>
      </div>
      {preview.notes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {notes.map((text) => (
            <li key={text} className="flex items-start gap-2 text-hint text-muted-foreground">
              <Glyph icon={InformationCircleIcon} size={14} className="mt-0.5 shrink-0" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The move's steps as main runs them, and how it ended. */
function MoveSteps({ progress }: { progress: MoveProgress | null }) {
  const { t } = useTranslation('session')
  if (!progress) {
    return (
      <div className="flex items-center gap-2 text-control text-muted-foreground">
        <Spinner />
        {t('move.starting')}
      </div>
    )
  }
  const name = progress.targetName
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2">
        {progress.steps.map(({ step, state }) => (
          <li key={step} className="flex items-center gap-2.5 text-control">
            <span className="flex size-4 shrink-0 items-center justify-center">
              {state === 'running' ? (
                <Spinner />
              ) : state === 'done' ? (
                <Glyph icon={Tick02Icon} size={15} className="text-success" />
              ) : state === 'failed' ? (
                <Glyph icon={Cancel01Icon} size={15} className="text-danger" />
              ) : (
                <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/40" />
              )}
            </span>
            <span className={state === 'pending' ? 'text-muted-foreground' : 'text-foreground'}>
              {t(`move.steps.${step}`, { name })}
            </span>
            {step === 'transfer' && state === 'running' && progress.transfer && (
              <span className="ml-auto text-hint text-muted-foreground tabular-nums">
                {bytes(progress.transfer.sent)} / {bytes(progress.transfer.total)}
              </span>
            )}
          </li>
        ))}
      </ol>
      {progress.state === 'done' && (
        <p className="text-control text-foreground">{t('move.done', { name })}</p>
      )}
      {progress.state === 'failed' && (
        <div role="alert" className="flex flex-col gap-1">
          <p className="text-control text-danger">
            {progress.reason
              ? t(`move.problems.${progress.reason}`, { agent: '', name })
              : t('move.failed', { message: progress.error ?? '' })}
          </p>
          <p className="text-hint text-muted-foreground">
            {progress.undone ? t('move.undone') : t('move.notUndone', { name })}
          </p>
        </div>
      )}
    </div>
  )
}
