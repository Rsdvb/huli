// Huli: what going back to a message does beyond the conversation, for Edit from here's and
// Rewind to here's confirmation: how the agent takes it, and, with 同时还原文件, every file a restore
// would put back, with its lines, from Kite's checkpoint of the message.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RewindChange, RewindFiles, RewindPreview } from '@shared/agent-host'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useEntry } from '@renderer/lib/features'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { LineCounts } from '../../git/rows'

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
    <div className="flex h-6 items-center gap-2">
      <span
        className={cn(
          'w-10 shrink-0 text-hint',
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
    </div>
  )
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder
}

function FilesList({ files }: { files: Extract<RewindFiles, { state: 'ready' }> }) {
  const { t } = useTranslation('session')
  const several = files.folders.length > 1
  const count = files.folders.reduce((sum, folder) => sum + folder.changes.length, 0)
  const kept = files.folders.reduce((sum, folder) => sum + folder.kept, 0)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-hint text-secondary">
        <span className="min-w-0 flex-1">{t('rewind.fileCount', { count })}</span>
        <LineCounts insertions={files.insertions} deletions={files.deletions} />
      </div>
      <div className="-mx-1 max-h-44 overflow-y-auto px-1">
        {files.folders.map((folder) =>
          folder.changes.length === 0 && !several ? null : (
            <div key={folder.folder} className="flex flex-col">
              {several && (
                <p className="pt-1 text-hint font-medium text-secondary" title={folder.folder}>
                  {folderName(folder.folder)}
                  {folder.missing && (
                    <span className="font-normal text-tertiary">
                      {' '}
                      · {t('rewind.folderMissing')}
                    </span>
                  )}
                </p>
              )}
              {folder.changes.map((change) => (
                <ChangeRow key={change.path} change={change} />
              ))}
            </div>
          ),
        )}
      </div>
      {kept > 0 && <p className="text-hint text-tertiary">{t('rewind.kept', { count: kept })}</p>}
    </div>
  )
}

/**
 * The preview of going back to before `target`: the agent's part as a line, then 同时还原文件 with
 * the files. `onToken` hears the preview's token while the files are to be restored, else null.
 */
export function RewindFilesPart({
  sessionId,
  target,
  agent,
  onToken,
}: {
  sessionId: string
  target: string
  agent: string
  onToken: (token: string | null) => void
}) {
  const { t } = useTranslation('session')
  const filesOn = useEntry('rewind.files')
  const [preview, setPreview] = useState<RewindPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restore, setRestore] = useState(false)

  useEffect(() => {
    let live = true
    host('sessions.rewindPreview', { sessionId, entryId: target }).then(
      (answer) => live && setPreview(answer),
      (e: unknown) => live && setError(errorMessage(e)),
    )
    return () => {
      live = false
    }
  }, [sessionId, target])

  const files = preview?.files ?? null
  const ready = files?.state === 'ready' ? files : null
  useEffect(() => {
    onToken(restore && ready ? ready.token : null)
  }, [restore, ready, onToken])

  // A running turn, which the edit stops, still changes the files: nothing to preview yet.
  if (error) return <p className="kettu-edit__note">{t('rewind.filesLater')}</p>
  if (!preview) {
    return (
      <div className="kettu-edit__files" aria-label={t('rewind.filesLoading')}>
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
    )
  }
  const line =
    preview.conversation === 'fresh'
      ? t('rewind.fresh', { agent })
      : preview.conversation === 'empty'
        ? t('rewind.empty', { agent })
        : null
  return (
    <div className="kettu-edit__files">
      {line && <p className="text-hint text-secondary">{line}</p>}
      {filesOn && (
        <>
          <label
            className={cn(
              'flex items-center gap-2 text-control',
              ready ? 'text-primary' : 'text-tertiary',
            )}
          >
            <Checkbox
              checked={restore && !!ready}
              disabled={!ready}
              onCheckedChange={(on) => setRestore(on === true)}
            />
            {t('rewind.files')}
          </label>
          {files?.state === 'unchanged' && (
            <p className="text-hint text-tertiary">{t('rewind.filesUnchanged')}</p>
          )}
          {files?.state === 'unavailable' && (
            <p
              className={cn(
                'text-hint',
                files.reason === 'busy' ? 'text-warning' : 'text-tertiary',
              )}
            >
              {files.reason === 'busy'
                ? t('rewind.filesBusy', { session: files.detail ?? '' })
                : files.reason === 'failed'
                  ? t('rewind.filesFailed', { error: files.detail ?? '' })
                  : t('rewind.filesNone')}
            </p>
          )}
          {ready && <FilesList files={ready} />}
          {restore && ready && <p className="text-hint text-warning">{t('rewind.overwrite')}</p>}
        </>
      )}
    </div>
  )
}
