// Huli: going back to one of the user's messages, from its actions: what leaves the conversation,
// how the agent takes it, and, when Kite or the agent kept them, the files that would be put back,
// file by file with their lines, before anything changes.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RewindChange, RewindFiles, RewindMode, RewindPreview } from '@shared/agent-host'
import { putBackUndone } from '@renderer/app/actions'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { LineCounts } from '../../git/rows'

const PARAGRAPH = '\n\n'

/** The parts of a path, so a long one is cut at its start and its name stays. */
function PathText({ path }: { path: string }) {
  const at = path.lastIndexOf('/')
  return (
    <span className="flex min-w-0 flex-1 font-mono text-code" title={path}>
      {at >= 0 && (
        <span className="min-w-0 truncate text-tertiary [direction:rtl]">
          <bdi>{path.slice(0, at + 1)}</bdi>
        </span>
      )}
      <span className="shrink-0 text-primary">{path.slice(at + 1)}</span>
    </span>
  )
}

function ChangeRow({ change }: { change: RewindChange }) {
  const { t } = useTranslation('session')
  return (
    <li className="flex h-7 items-center gap-2.25">
      <span
        className={cn(
          'w-14 shrink-0 text-hint',
          change.action === 'delete'
            ? 'text-danger'
            : change.action === 'recreate'
              ? 'text-success'
              : 'text-secondary',
        )}
      >
        {t(`rewind.action.${change.action}`)}
      </span>
      <PathText path={change.path} />
      {change.binary ? (
        <span className="shrink-0 text-hint text-tertiary">{t('rewind.binary')}</span>
      ) : (
        <LineCounts insertions={change.insertions} deletions={change.deletions} />
      )}
    </li>
  )
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder
}

function FilesState({ files }: { files: RewindFiles | null }) {
  const { t } = useTranslation('session')
  if (files === null) {
    return (
      <div className="flex flex-col gap-2 pt-1" aria-label={t('rewind.filesLoading')}>
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-1/2" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    )
  }
  if (files.state === 'unchanged') {
    return <p className="text-hint text-tertiary">{t('rewind.filesUnchanged')}</p>
  }
  if (files.state === 'unavailable') {
    const text =
      files.reason === 'busy'
        ? t('rewind.filesBusy', { session: files.detail ?? '' })
        : files.reason === 'failed'
          ? t('rewind.filesFailed', { error: files.detail ?? '' })
          : t('rewind.filesNone')
    return (
      <p className={cn('text-hint', files.reason === 'busy' ? 'text-warning' : 'text-tertiary')}>
        {text}
      </p>
    )
  }
  const several = files.folders.length > 1
  const count = files.folders.reduce((sum, folder) => sum + folder.changes.length, 0)
  const kept = files.folders.reduce((sum, folder) => sum + folder.kept, 0)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-hint text-secondary">
        <span className="min-w-0 flex-1">{t('rewind.fileCount', { count })}</span>
        <LineCounts insertions={files.insertions} deletions={files.deletions} />
      </div>
      <div className="-mx-1 max-h-56 overflow-y-auto px-1">
        {files.folders.map((folder) =>
          folder.changes.length === 0 && !several ? null : (
            <div key={folder.folder} className="flex flex-col">
              {several && (
                <p className="pt-1.5 text-hint font-medium text-secondary" title={folder.folder}>
                  {folderName(folder.folder)}
                  {folder.missing && (
                    <span className="font-normal text-tertiary">
                      {' '}
                      · {t('rewind.folderMissing')}
                    </span>
                  )}
                </p>
              )}
              <ul>
                {folder.changes.map((change) => (
                  <ChangeRow key={change.path} change={change} />
                ))}
              </ul>
            </div>
          ),
        )}
      </div>
      {kept > 0 && <p className="text-hint text-tertiary">{t('rewind.kept', { count: kept })}</p>}
      {files.source === 'agent' && (
        <p className="text-hint text-tertiary">{t('rewind.agentSource')}</p>
      )}
    </div>
  )
}

/** Asks before going back to the message, with what it would do to the conversation and files. */
export function RewindDialog({
  sessionId,
  entryId,
  mode,
  agent,
  onClose,
}: {
  sessionId: string
  entryId: string
  mode: RewindMode
  /** The session's agent, by name. */
  agent: string
  onClose: () => void
}) {
  const { t } = useTranslation(['session', 'common'])
  const [preview, setPreview] = useState<RewindPreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [restore, setRestore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    host('sessions.rewindPreview', { sessionId, entryId, mode }).then(
      (answer) => {
        if (live) setPreview(answer)
      },
      (e: unknown) => {
        if (live) setLoadError(errorMessage(e))
      },
    )
    return () => {
      live = false
    }
  }, [sessionId, entryId, mode])

  const files = preview?.files ?? null
  const canRestore = files?.state === 'ready'
  const later = Math.max(0, (preview?.messages ?? 1) - (mode === 'edit' ? 1 : 0))

  const go = async () => {
    setBusy(true)
    setError(null)
    // Read before the message leaves the thread.
    const entry = useThreadsStore.getState().replicas[sessionId]?.state?.byId[entryId]
    const text =
      mode === 'edit' && entry?.kind === 'user'
        ? entry.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(PARAGRAPH)
        : ''
    try {
      const done = await host('sessions.rewind', {
        sessionId,
        entryId,
        mode,
        ...(restore && files?.state === 'ready' ? { restoreFiles: true, token: files.token } : {}),
      })
      onClose()
      if (mode === 'edit') putBackUndone(sessionId, text)
      const restored = done.files
      if (restored) {
        const backup = restored.backup
        toast(
          restored.failed > 0
            ? t('rewind.doneSomeFailed', { count: restored.restored, failed: restored.failed })
            : t('rewind.doneFiles', { count: restored.restored }),
          backup
            ? {
                label: t('rewind.undoFiles'),
                onClick: () => {
                  host('sessions.undoRewindFiles', { sessionId, backup }).then(
                    () => toast(t('rewind.undoneFiles'), undefined, { tone: 'success' }),
                    (e: unknown) => toast(errorMessage(e), undefined, { tone: 'warning' }),
                  )
                },
              }
            : undefined,
          { tone: restored.failed > 0 ? 'warning' : 'success', duration: 10_000 },
        )
      }
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const conversation =
    preview === null
      ? null
      : preview.conversation === 'agent'
        ? t('rewind.byAgent', { agent })
        : preview.conversation === 'fresh'
          ? t('rewind.fresh', { agent })
          : t('rewind.empty', { agent })

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="grid-cols-[minmax(0,1fr)] gap-0 p-0 sm:max-w-115"
      >
        <DialogHeader className="px-5.5 pt-5">
          <DialogTitle>
            {t(mode === 'edit' ? 'rewind.editTitle' : 'rewind.rewindTitle')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'edit'
              ? later === 0
                ? t('rewind.editLatest')
                : t('rewind.editBody', { count: later })
              : t('rewind.rewindBody', { count: later })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 px-5.5 pt-3">
          {loadError !== null ? (
            <p className="text-hint text-danger">{loadError}</p>
          ) : (
            <>
              {conversation === null ? (
                <Skeleton className="h-3.5 w-4/5" />
              ) : (
                <p className="text-hint text-secondary">{conversation}</p>
              )}
              <label
                className={cn(
                  'flex items-center gap-2.25 text-control',
                  canRestore ? 'text-primary' : 'text-tertiary',
                )}
              >
                <Checkbox
                  checked={restore && canRestore}
                  disabled={!canRestore || busy}
                  onCheckedChange={(on) => setRestore(on === true)}
                />
                {t('rewind.files')}
              </label>
              <FilesState files={files} />
              {restore && canRestore && (
                <p className="text-hint text-warning">{t('rewind.overwrite')}</p>
              )}
            </>
          )}
          {error !== null && <p className="text-hint text-danger">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5.5 py-4.5 *:data-[slot=button]:h-7.5">
          <DialogClose render={<Button variant="outline" size="compact" disabled={busy} />}>
            {t('common:actions.cancel')}
          </DialogClose>
          <Button
            variant="destructive"
            size="compact"
            disabled={busy || preview === null}
            onClick={() => void go()}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {t(mode === 'edit' ? 'rewind.confirmEdit' : 'rewind.confirmRewind')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
