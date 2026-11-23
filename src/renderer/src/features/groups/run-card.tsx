import { memo } from 'react'
import { CheckmarkCircle02Icon, GitBranchIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { runPhase, type RunPhase } from '@shared/run-groups'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { Glyph } from '@renderer/features/shell/glyph'
import { runningFor } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { LineCounts } from './run-changes'
import { useModelName } from './run-label'
import type { ChangesState } from './use-run-changes'

const PHASE_BADGE: Record<RunPhase, 'info' | 'attention' | 'success' | 'error'> = {
  working: 'info',
  waiting: 'attention',
  done: 'success',
  failed: 'error',
}

/**
 * Huli: one run of a best-of-N group, side by side with the others: its agent and model, where it
 * stands, how long it has run, what it changed, and the ways to look at it, open it and keep it.
 */
export const RunCard = memo(function RunCard({
  sessionId,
  changes,
  selected,
  keptId,
  onSelect,
  onKeep,
}: {
  sessionId: string
  changes: ChangesState
  selected: boolean
  /** The run kept from this group, if any. */
  keptId: string | null
  onSelect: () => void
  onKeep: () => void
}) {
  const { t } = useTranslation('session')
  const run = useSessionsStore((s) => s.byId[sessionId])
  const model = useModelName(run)
  if (!run) return null
  const phase = runPhase(run)
  const kept = keptId === run.id
  const stats = changes.changes
  const changedNothing = !!stats && stats.files.length === 0 && stats.commits === 0
  const canKeep =
    keptId === null && phase === 'done' && run.worktree?.state === 'ready' && !changedNothing
  return (
    <article
      aria-label={agentName(run.agentId, hostOfSession(run))}
      data-selected={selected || undefined}
      data-kept={kept || undefined}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-xl border border-default bg-surface p-3.5 transition-colors',
        'data-selected:border-strong data-selected:bg-raised data-kept:border-success',
      )}
    >
      <header className="flex min-w-0 items-start gap-2.5">
        <AgentMark
          agent={run.agentId}
          size={20}
          className="mt-0.5 shrink-0"
          hostId={hostOfSession(run)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-medium text-primary">
            {agentName(run.agentId, hostOfSession(run))}
          </span>
          <span className="truncate text-xs text-secondary">
            {model ?? t('group.runs.ownModel')}
          </span>
        </div>
        {kept ? (
          <Badge variant="success">
            <Glyph icon={CheckmarkCircle02Icon} size={12} />
            {t('group.kept')}
          </Badge>
        ) : (
          <Badge variant={PHASE_BADGE[phase]}>
            {phase === 'working' && <TurnDots phase="working" className="size-2.5" />}
            {t(`group.phase.${phase}`)}
          </Badge>
        )}
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-tertiary">{t('group.card.time')}</dt>
        <dd className="text-primary tabular-nums">
          <Elapsed run={run} working={phase === 'working' || phase === 'waiting'} />
        </dd>
        <dt className="text-tertiary">{t('group.card.changes')}</dt>
        <dd className="flex min-w-0 items-center gap-2 text-primary">
          {stats ? (
            <>
              <span className="tabular-nums">
                {t('group.card.files', { count: stats.files.length })}
              </span>
              <LineCounts insertions={stats.insertions} deletions={stats.deletions} />
            </>
          ) : changes.error ? (
            <span className="truncate text-danger" title={changes.error}>
              {t('group.card.changesFailed')}
            </span>
          ) : (
            <span className="text-tertiary">…</span>
          )}
        </dd>
        {run.worktree && (
          <>
            <dt className="text-tertiary">{t('group.card.branch')}</dt>
            <dd className="flex min-w-0 items-center gap-1 text-secondary">
              <Glyph icon={GitBranchIcon} size={12} className="shrink-0" />
              <span className="truncate font-mono" title={run.worktree.branch}>
                {run.worktree.branch}
              </span>
            </dd>
          </>
        )}
      </dl>
      {run.worktree?.state === 'setup-failed' && (
        <p className="text-xs text-danger">{t('group.card.setupFailed')}</p>
      )}
      <footer className="mt-auto flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={selected ? 'secondary' : 'ghost'}
          onClick={onSelect}
          aria-pressed={selected}
        >
          {t('group.card.showChanges')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openSession(run.id, run.projectPath)}>
          {t('group.card.open')}
        </Button>
        {keptId === null && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={!canKeep}
            title={
              canKeep
                ? undefined
                : changedNothing
                  ? t('group.changes.none')
                  : t('group.card.keepWhenDone')
            }
            onClick={onKeep}
          >
            {t('group.card.keep')}
          </Button>
        )}
      </footer>
    </article>
  )
})

/** How long the run has worked: on the shared clock while it works, else until it last changed. */
function Elapsed({ run, working }: { run: SessionSummary; working: boolean }) {
  if (working) return <LiveElapsed since={run.createdAt} />
  return <>{runningFor(run.updatedAt - run.createdAt)}</>
}

function LiveElapsed({ since }: { since: number }) {
  const now = useNow()
  return <>{runningFor(now - since)}</>
}
