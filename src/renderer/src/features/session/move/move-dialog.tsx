// Huli: the dialog of 搬到另一台电脑… in a session's menu: the computer to move it to, what main
// found on both sides and would do, then the move's steps as main runs them, and the session
// there once it is. Mounted once for the window.

import { useRef, useState } from 'react'
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
import { useHostsStore, useOtherHosts } from '@renderer/stores/hosts'
import { hostOfSession, sessionTitle } from '@renderer/stores/sessions'
import { closeMove, openMoved, previewMove, startMove, useMoveStore } from './move'

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
  const [target, setTarget] = useState<MoveHost | undefined>(undefined)
  const [preview, setPreview] = useState<MovePreviewResult | 'loading' | null>(null)
  const [moveId, setMoveId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const progress = useMoveStore((s) => (moveId ? (s.moves[moveId] ?? null) : null))
  // The latest pick, so an earlier pick's late answer is dropped.
  const asked = useRef(0)

  const choose = (host: MoveHost) => {
    const ask = ++asked.current
    setTarget(host)
    setPreview('loading')
    previewMove(summary, host).then(
      (result) => ask === asked.current && setPreview(result),
      (e: unknown) =>
        ask === asked.current && setPreview({ ok: false, reason: null, message: errorMessage(e) }),
    )
  }

  const start = async () => {
    if (target === undefined) return
    setStarting(true)
    setError(null)
    try {
      setMoveId(await startMove(summary, target))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setStarting(false)
    }
  }

  const ready =
    preview !== null && preview !== 'loading' && preview.ok && preview.preview.problems.length === 0
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('move.title')}</DialogTitle>
        <DialogDescription className="truncate">{sessionTitle(summary)}</DialogDescription>
      </DialogHeader>
      {moveId ? (
        <MoveSteps progress={progress} />
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
            <MovePlan preview={preview.preview} />
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
            {progress?.state === 'done' && progress.result && (
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

/** What main found on both sides and would do, what stops it, and what to know. */
function MovePlan({ preview }: { preview: MovePreview }) {
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
  const values = { agent, name: targetName }
  const problems = preview.problems.map((item: MoveProblem) => t(`move.problems.${item}`, values))
  const notes = preview.notes.map((item: MoveNote) => t(`move.notes.${item}`, values))
  return (
    <div className="flex flex-col gap-3">
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
