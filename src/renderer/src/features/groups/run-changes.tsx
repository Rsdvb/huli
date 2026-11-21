import { useEffect, useState } from 'react'
import { ArrowDown01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ChangedFile, FileDiff } from '@shared/git'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { Diff } from '@renderer/features/session/markdown'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import type { ChangesState } from './use-run-changes'

const STATUS_LETTER: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U',
  conflicted: '!',
}

/** Huli: the files a run changed, each opening its diff against the run's base in place. */
export function RunChangesList({ sessionId, state }: { sessionId: string; state: ChangesState }) {
  const { t } = useTranslation('session')
  const { changes, error } = state
  if (!changes) {
    if (error) return <p className="px-1 py-2 text-xs text-danger">{error}</p>
    return (
      <div className="flex flex-col gap-1.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-7 w-full rounded-md" />
        ))}
      </div>
    )
  }
  if (changes.files.length === 0) {
    return <p className="px-1 py-2 text-xs text-tertiary">{t('group.changes.none')}</p>
  }
  return (
    <ul className="flex flex-col">
      {changes.files.map((file) => (
        <FileRow key={file.path} sessionId={sessionId} file={file} />
      ))}
      {changes.truncated && (
        <li className="px-2 py-1.5 text-xs text-tertiary">{t('group.changes.truncated')}</li>
      )}
    </ul>
  )
}

function FileRow({ sessionId, file }: { sessionId: string; file: ChangedFile }) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  return (
    <li className="flex flex-col border-b border-subtle last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Glyph
          icon={open ? ArrowDown01Icon : ArrowRight01Icon}
          size={12}
          className="shrink-0 text-tertiary"
        />
        <FileTypeIcon path={file.path} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-primary" title={file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span
          className="w-4 shrink-0 text-center font-mono text-tertiary"
          title={t(`group.changes.status.${file.status}`)}
        >
          {STATUS_LETTER[file.status]}
        </span>
        <LineCounts insertions={file.insertions} deletions={file.deletions} />
      </button>
      {open && <FileDiffView sessionId={sessionId} file={file} />}
    </li>
  )
}

export function LineCounts({
  insertions,
  deletions,
  className,
}: {
  insertions: number | null
  deletions: number | null
  className?: string
}) {
  if (insertions === null && deletions === null) return null
  return (
    <span className={cn('flex shrink-0 gap-1.5 font-mono tabular-nums', className)}>
      <span className="text-success">+{insertions ?? 0}</span>
      <span className="text-danger">−{deletions ?? 0}</span>
    </span>
  )
}

function FileDiffView({ sessionId, file }: { sessionId: string; file: ChangedFile }) {
  const { t } = useTranslation('session')
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    host('groups.fileDiff', { sessionId, path: file.path, oldPath: file.oldPath }).then(
      (read) => live && setDiff(read),
      (failure: unknown) => live && setError(errorMessage(failure)),
    )
    return () => {
      live = false
    }
  }, [sessionId, file.path, file.oldPath])
  if (error) return <p className="px-2 pb-2 text-xs text-danger">{error}</p>
  if (!diff) return <Skeleton className="mx-2 mb-2 h-16 rounded-md" />
  if (diff.binary || diff.tooLarge || diff.newText === null) {
    const note = diff.binary
      ? t('group.changes.binary')
      : diff.tooLarge
        ? t('group.changes.tooLarge')
        : t('group.changes.deleted')
    return <p className="px-2 pb-2 text-xs text-tertiary">{note}</p>
  }
  return (
    <div className="mx-2 mb-2 overflow-hidden rounded-md border border-subtle">
      <Diff path={file.path} oldText={diff.oldText} newText={diff.newText} />
    </div>
  )
}
