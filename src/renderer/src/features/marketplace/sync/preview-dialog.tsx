// Marketplace › Sync's confirmation: each file's exact changed lines, secrets masked, the changes
// left out and why; Write sends the preview back, which the host writes only while every file is
// as it read it.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { SyncFilePreview, SyncNote, SyncPreview, SyncProblem } from '@shared/agent-sync'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { toast } from '@renderer/components/ui/toast'
import { Pill, SetButton } from '@renderer/features/settings/controls'
import {
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
} from '@renderer/features/settings/settings-dialog'
import { bytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { FORMAT_NAMES, useAgentsLabel } from './labels'
import { shortPath } from './model'

export function PreviewDialog({
  preview,
  home,
  onClose,
  onApplied,
}: {
  preview: SyncPreview | null
  home: string
  onClose: () => void
  /** After a write; `written` says whether anything was written. */
  onApplied: (written: boolean) => void
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const files = preview?.files ?? []

  const apply = async () => {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const result = await scope.request('sync.apply', { previewId: preview.id })
      // The dialog stays with the reason; closing it reads the files again.
      if (!result.ok) {
        setError(t('sync.preview.changed', { files: result.changed.join(', ') }))
        return
      }
      const backup = result.backup
      if (result.failed) {
        toast(
          t('sync.preview.failed', { path: result.failed.path, error: result.failed.message }),
          undefined,
          { tone: 'warning' },
        )
      } else {
        toast(
          backup
            ? t('sync.preview.done', { count: result.written.length })
            : t('sync.preview.doneNoBackup', { count: result.written.length }),
          backup
            ? {
                label: t('sync.preview.showBackup'),
                onClick: () => void scope.api.showItem(backup),
              }
            : undefined,
          { tone: 'success' },
        )
      }
      onApplied(result.written.length > 0)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (busy || open) return
        setError(null)
        onClose()
      }}
    >
      <SettingsDialogContent className="sm:max-w-190">
        <SettingsDialogHeader title={t('sync.preview.title')}>
          {t('sync.preview.description')}
        </SettingsDialogHeader>
        <SettingsDialogBody className="k-sync-preview">
          {files.length === 0 && <p className="k-mkt-section-note">{t('sync.preview.nothing')}</p>}
          {files.map((file) => (
            <FileCard key={file.path} file={file} home={home} />
          ))}
          {preview && preview.problems.length > 0 && <Problems problems={preview.problems} />}
          {error && (
            <p role="alert" className="k-mkt-error">
              {error}
            </p>
          )}
        </SettingsDialogBody>
        <SettingsDialogFooter>
          <DialogClose render={<SetButton size="md" variant="ghost" />} disabled={busy}>
            {t('common:actions.cancel')}
          </DialogClose>
          <SetButton
            size="md"
            variant="primary"
            loading={busy}
            disabled={files.length === 0 || error !== null}
            onClick={() => void apply()}
          >
            {t('sync.preview.confirm', { count: files.length })}
          </SetButton>
        </SettingsDialogFooter>
      </SettingsDialogContent>
    </Dialog>
  )
}

function FileCard({ file, home }: { file: SyncFilePreview; home: string }) {
  const { t } = useTranslation('marketplace')
  const label = useAgentsLabel()
  return (
    <article className="k-sync-file">
      <header className="k-sync-file__head">
        <Pill tone={file.action === 'edit' ? 'neutral' : 'success'}>
          {t(`sync.preview.action.${file.action}`)}
        </Pill>
        <span className="k-sync-file__path k-mkt-mono" title={file.path}>
          {shortPath(file.path, home)}
        </span>
        <span className="k-sync-file__agents">{label(file.agentIds)}</span>
      </header>
      {file.notes.map((note, index) => (
        <p
          key={index}
          className="k-sync-file__note"
          data-warn={note.kind === 'outside-edit' || undefined}
        >
          {noteText(note, t)}
        </p>
      ))}
      {file.action === 'copy' ? (
        <p className="k-sync-file__note">
          {t('sync.preview.copyLine', { count: file.files, size: bytes(file.bytes) })}
        </p>
      ) : (
        <div className="k-sync-diff k-mkt-mono" role="group" aria-label={t('sync.preview.lines')}>
          {file.hunks.map((hunk, index) => (
            <div key={index} className="k-sync-diff__hunk">
              <div className="k-sync-diff__at">
                @@ -{hunk.oldStart} +{hunk.newStart} @@
              </div>
              {hunk.lines.map((line, i) => (
                <div key={i} className="k-sync-diff__line" data-kind={line.kind}>
                  <span aria-hidden className="k-sync-diff__sign">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                  </span>
                  <span className="sr-only">
                    {line.kind === 'add'
                      ? t('sync.preview.added')
                      : line.kind === 'del'
                        ? t('sync.preview.removed')
                        : ''}
                  </span>
                  {line.text || ' '}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

function noteText(note: SyncNote, t: TFunction<'marketplace'>): string {
  switch (note.kind) {
    case 'converted':
      return note.dropped.length > 0
        ? t('sync.preview.convertedDropped', {
            server: note.server,
            from: FORMAT_NAMES[note.from],
            to: FORMAT_NAMES[note.to],
            fields: note.dropped.join(', '),
          })
        : t('sync.preview.converted', {
            server: note.server,
            from: FORMAT_NAMES[note.from],
            to: FORMAT_NAMES[note.to],
          })
    case 'outside-edit':
      return t('sync.preview.outsideEdit')
    case 'new-file':
      return t('sync.preview.newFile')
  }
}

function Problems({ problems }: { problems: SyncProblem[] }) {
  const { t } = useTranslation('marketplace')
  return (
    <section className="k-sync-problems">
      <b>{t('sync.preview.problems')}</b>
      <ul>
        {problems.map((problem, index) => {
          const change = problem.change
          const subject =
            change.kind === 'skill-copy'
              ? change.skill
              : change.kind === 'instructions'
                ? change.place
                : change.server
          return (
            <li key={index}>
              <span className="k-mkt-mono">{subject}</span>
              {' — '}
              {t(`sync.problem.${problem.code}`, { detail: problem.detail ?? '' })}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
