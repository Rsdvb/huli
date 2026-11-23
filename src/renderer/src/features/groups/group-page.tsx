import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { runPhase } from '@shared/run-groups'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { Glyph } from '@renderer/features/shell/glyph'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { basename } from '@renderer/lib/format'
import { errorMessage, host, hostAt } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { receiveGitStatus, useGitStore } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { groupRuns, useSessionsStore } from '@renderer/stores/sessions'
import { openNewSession } from '@renderer/stores/view'
import { GROUP_ICON } from './group-icon'
import { RunCard } from './run-card'
import { modelNameOf, runLabel, useModelName } from './run-label'
import { useAgentOptionsStore } from '@renderer/stores/agent-options'
import { RunChangesList } from './run-changes'
import { useRunChanges } from './use-run-changes'

/**
 * Huli: a best-of-N group's page: its runs side by side, each with where it stands, how long it
 * ran and what it changed; one run's files below with their diffs; and "Keep this", which merges a
 * run into the project's own checkout and then offers to set the others aside.
 */
export default function GroupPage({ groupId }: { groupId: string }) {
  const { t } = useTranslation('session')
  const loaded = useSessionsStore((s) => s.loaded)
  const ids = useSessionsStore(
    useShallow((s) => groupRuns(s.byId, groupId).flatMap((r) => (r.archivedAt ? [] : [r.id]))),
  )
  const archived = useSessionsStore(
    (s) => groupRuns(s.byId, groupId).filter((r) => r.archivedAt).length,
  )
  const head = useSessionsStore((s) => groupRuns(s.byId, groupId)[0])
  const folders = useSessionsStore(
    useShallow((s) =>
      groupRuns(s.byId, groupId).flatMap((r) =>
        !r.archivedAt && r.worktree?.path ? [r.worktree.path] : [],
      ),
    ),
  )
  const projectPath = head?.projectPath ?? null
  // The host's word on the kept run arrives just after the keep's answer; until then the page's.
  const [keptNow, setKeptNow] = useState<string | null>(null)
  const keptId = head?.group?.kept ?? keptNow
  const [selected, setSelected] = useState<string | null>(null)
  const [keeping, setKeeping] = useState<string | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const shown = selected && ids.includes(selected) ? selected : (keptId ?? ids[0] ?? null)

  useWatchedFolders(groupId, projectPath, folders)

  if (!head) {
    return loaded ? <Missing /> : <Loading />
  }
  const projectName =
    useProjectsStore.getState().projects.find((p) => p.path === head.projectPath)?.name ??
    basename(head.projectPath)
  const others = ids.filter((id) => id !== keptId)

  return (
    <div className="ks-session flex h-full min-h-0 flex-col">
      <TopBar>
        <NoDrag className="min-w-0 gap-2">
          <Glyph icon={GROUP_ICON} size={15} className="shrink-0 text-icon" />
          <span className="truncate text-label font-medium" title={head.group?.title}>
            {head.group?.title}
          </span>
        </NoDrag>
        <span className="flex-1" />
      </TopBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-8 pt-5 pb-10">
          <p className="text-xs text-secondary">
            {t('group.page.summary', {
              count: head.group?.size ?? ids.length,
              project: projectName,
              base: head.worktree?.base ?? 'HEAD',
            })}
            {archived > 0 && ` · ${t('group.page.archived', { count: archived })}`}
          </p>
          {keptId && (
            <KeptNote
              keptId={keptId}
              others={others.length}
              onDiscard={() => setDiscarding(true)}
            />
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
            {ids.map((id) => (
              <CardWithChanges
                key={id}
                sessionId={id}
                selected={id === shown}
                keptId={keptId}
                onSelect={() => setSelected(id)}
                onKeep={() => setKeeping(id)}
              />
            ))}
          </div>
          {shown && <ShownChanges sessionId={shown} />}
        </div>
      </div>
      <KeepDialog
        sessionId={keeping}
        projectPath={head.projectPath}
        onClose={() => setKeeping(null)}
        onKept={(sessionId) => {
          setKeeping(null)
          setKeptNow(sessionId)
          if (ids.some((id) => id !== sessionId)) setDiscarding(true)
        }}
      />
      <DiscardDialog
        open={discarding}
        projectPath={head.projectPath}
        sessionIds={others}
        onClose={() => setDiscarding(false)}
      />
    </div>
  )
}

/** Keeps the git status of the project and each run's worktree live while the page shows. */
function useWatchedFolders(groupId: string, projectPath: string | null, folders: string[]) {
  const key = [projectPath ?? '', ...folders].join('\n')
  useEffect(() => {
    const paths = key.split('\n').filter(Boolean)
    const watcher = `group:${groupId}`
    for (const path of paths) {
      host('git.status', { projectPath: path, watcher }).then(receiveGitStatus, () => {})
    }
    return () => {
      for (const path of paths)
        void host('git.unwatch', { projectPath: path, watcher }).catch(() => {})
    }
  }, [groupId, key])
}

function CardWithChanges({
  sessionId,
  selected,
  keptId,
  onSelect,
  onKeep,
}: {
  sessionId: string
  selected: boolean
  keptId: string | null
  onSelect: () => void
  onKeep: () => void
}) {
  const path = useSessionsStore((s) => s.byId[sessionId]?.worktree?.path ?? null)
  const phase = useSessionsStore((s) => {
    const run = s.byId[sessionId]
    return run ? runPhase(run) : 'done'
  })
  const changes = useRunChanges(sessionId, path, phase)
  return (
    <RunCard
      sessionId={sessionId}
      changes={changes}
      selected={selected}
      keptId={keptId}
      onSelect={onSelect}
      onKeep={onKeep}
    />
  )
}

/** The shown run's files; its changes are read for this list as the card reads them. */
function ShownChanges({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('session')
  const run = useSessionsStore((s) => s.byId[sessionId])
  const path = run?.worktree?.path ?? null
  const phase = run ? runPhase(run) : 'done'
  const state = useRunChanges(sessionId, path, phase)
  const model = useModelName(run)
  if (!run) return null
  return (
    <section aria-label={t('group.changes.title')} className="flex flex-col gap-2">
      <h2 className="text-ui font-medium text-primary">
        {t('group.changes.of', { agent: runLabel(run, model) })}
      </h2>
      <div className="rounded-xl border border-default bg-surface p-1.5">
        <RunChangesList sessionId={sessionId} state={state} />
      </div>
    </section>
  )
}

function KeptNote({
  keptId,
  others,
  onDiscard,
}: {
  keptId: string
  others: number
  onDiscard: () => void
}) {
  const { t } = useTranslation('session')
  const kept = useSessionsStore((s) => s.byId[keptId])
  const model = useModelName(kept)
  const name = kept ? runLabel(kept, model) : ''
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-success-tint px-3.5 py-2.5 text-ui text-primary"
    >
      <span className="min-w-0 flex-1">{t('group.page.keptNote', { agent: name })}</span>
      {others > 0 && (
        <Button size="sm" variant="outline" onClick={onDiscard}>
          {t('group.discard.action', { count: others })}
        </Button>
      )}
    </div>
  )
}

function KeepDialog({
  sessionId,
  projectPath,
  onClose,
  onKept,
}: {
  sessionId: string | null
  projectPath: string
  onClose: () => void
  onKept: (sessionId: string) => void
}) {
  const { t } = useTranslation('session')
  const run = useSessionsStore((s) => (sessionId ? s.byId[sessionId] : undefined))
  const branch = useGitStore((s) => s.status[projectPath]?.head.branch ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(run)
  if (run && run !== shown) setShown(run)
  const model = useModelName(shown)
  const name = shown ? runLabel(shown, model) : ''
  const keep = async () => {
    if (!sessionId) return
    setBusy(true)
    setError(null)
    try {
      const kept = await host('groups.keep', { sessionId })
      toast(t('group.keep.done', { agent: name, branch: kept.branch }), undefined, {
        tone: 'success',
      })
      onKept(sessionId)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog
      open={sessionId !== null}
      onOpenChange={(open) => {
        if (open || busy) return
        setError(null)
        onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('group.keep.title', { agent: name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('group.keep.body', {
              branch: branch ?? t('group.keep.currentBranch'),
              runBranch: shown?.worktree?.branch ?? '',
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('group.keep.cancel')}</AlertDialogCancel>
          <Button size="dialog" disabled={busy} onClick={() => void keep()}>
            {busy && <Spinner />}
            {t('group.keep.confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function DiscardDialog({
  open,
  projectPath,
  sessionIds,
  onClose,
}: {
  open: boolean
  projectPath: string
  sessionIds: string[]
  onClose: () => void
}) {
  const { t } = useTranslation('session')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const names = useSessionsStore(
    useShallow((s) =>
      sessionIds.map((id) => {
        const run = s.byId[id]
        return run ? runLabel(run, modelNameOf(useAgentOptionsStore.getState(), run)) : id
      }),
    ),
  )
  const discard = async () => {
    setBusy(true)
    setError(null)
    try {
      await hostAt(hostOfPath(projectPath), 'groups.discard', { sessionIds })
      toast(t('group.discard.done', { count: sessionIds.length }), undefined, { tone: 'success' })
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog
      open={open && sessionIds.length > 0}
      onOpenChange={(next) => {
        if (next || busy) return
        setError(null)
        onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('group.discard.title', { count: sessionIds.length })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('group.discard.body', { runs: names })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('group.discard.cancel')}</AlertDialogCancel>
          <Button size="dialog" disabled={busy} onClick={() => void discard()}>
            {busy && <Spinner />}
            {t('group.discard.confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function Loading() {
  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <Skeleton className="h-4 w-48" />
      </TopBar>
      <div className="mx-auto grid w-full max-w-6xl grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3 px-8 pt-8">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-44 rounded-xl" />
        ))}
      </div>
    </div>
  )
}

/** A group whose runs are all gone from this window's list. */
function Missing() {
  const { t } = useTranslation('session')
  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <span />
      </TopBar>
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Glyph icon={GROUP_ICON} size={18} />
          </EmptyMedia>
          <EmptyTitle>{t('group.page.missing')}</EmptyTitle>
          <EmptyDescription>{t('group.page.missingBody')}</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" onClick={() => openNewSession(null, null)}>
          {t('group.page.newSession')}
        </Button>
      </Empty>
    </div>
  )
}
