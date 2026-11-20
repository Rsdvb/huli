// Huli: the controls of Settings › Backup (backup-section.tsx). Main makes and restores the
// backups and owns every path; the page only shows them and asks.

import { useState, type ReactNode } from 'react'
import { FolderOpenIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { RestoreCandidate } from '@shared/backup'
import {
  BACKUP_KEEP_MAX,
  BACKUP_KEEP_MIN,
  isBackupTime,
  type SettingsPatch,
} from '@shared/settings'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { toast } from '@renderer/components/ui/toast'
import { fullTime, mediumAgo, storageBytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useBackupStore } from '@renderer/stores/backup'
import { useSettingsStore } from '@renderer/stores/settings'
import { openSettings } from '@renderer/stores/view'
import {
  CONFIRM,
  ControlError,
  Meter,
  PathText,
  SetButton,
  SetInput,
  SettingSelect,
  SettingSwitch,
  Skel,
} from './controls'
import { BlockLine, Notice } from './rows'

const KEEP_CHOICES = [1, 3, 5, 7, 10, 14, 30, 60].filter(
  (n) => n >= BACKUP_KEEP_MIN && n <= BACKUP_KEEP_MAX,
)

/** Changes this computer's settings; a failure shows beside the control. */
function useUpdate(): [(patch: SettingsPatch) => void, string | null] {
  const [error, setError] = useState<string | null>(null)
  const update = (patch: SettingsPatch) => {
    setError(null)
    useSettingsStore
      .getState()
      .update(patch)
      .catch((e: unknown) => setError(errorMessage(e)))
  }
  return [update, error]
}

export function EnabledSwitch({ label }: { label: string }) {
  const checked = useSettingsStore((s) => s.settings.backup.enabled)
  const [update, error] = useUpdate()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(enabled) => update({ backup: { enabled } })}
      />
    </>
  )
}

export function TimeField({ label }: { label: string }) {
  const time = useSettingsStore((s) => s.settings.backup.time)
  const enabled = useSettingsStore((s) => s.settings.backup.enabled)
  const [draft, setDraft] = useState<string | null>(null)
  const [update, error] = useUpdate()
  return (
    <>
      <ControlError error={error} />
      <SetInput
        type="time"
        aria-label={label}
        className="k-input--short w-28"
        value={draft ?? time}
        disabled={!enabled}
        onChange={(event) => {
          const value = event.target.value
          setDraft(value)
          if (isBackupTime(value) && value !== time) update({ backup: { time: value } })
        }}
        onBlur={() => setDraft(null)}
      />
    </>
  )
}

export function KeepSelect({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const keep = useSettingsStore((s) => s.settings.backup.keep)
  const [update, error] = useUpdate()
  const choices = KEEP_CHOICES.includes(keep)
    ? KEEP_CHOICES
    : [...KEEP_CHOICES, keep].sort((a, b) => a - b)
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={label}
        value={String(keep)}
        options={choices.map((n) => ({
          value: String(n),
          label: t('backup.keep.option', { count: n }),
        }))}
        onChange={(value) => update({ backup: { keep: Number(value) } })}
      />
    </>
  )
}

/** How the backup under way goes, and Back up now. */
export function StatusControl() {
  const { t } = useTranslation('settings')
  const running = useBackupStore((s) => s.status?.running ?? false)
  const progress = useBackupStore((s) => s.status?.progress ?? null)
  const known = useBackupStore((s) => s.status !== null)
  const [error, setError] = useState<string | null>(null)
  const api = window.kettu.backup
  if (!known || !api) return <Skel width={96} />
  const run = () => {
    setError(null)
    api
      .run()
      .then((next) => useBackupStore.setState({ status: next }))
      .catch((e: unknown) => setError(errorMessage(e)))
  }
  return (
    <>
      <ControlError error={error} />
      {running && progress !== null && (
        <Meter value={progress * 100} label={t('backup.status.running')} />
      )}
      <SetButton loading={running} disabled={running} onClick={run}>
        {running ? t('backup.status.running') : t('backup.status.now')}
      </SetButton>
    </>
  )
}

/** Where backups go: Choose…, back to the default, and the folder in the file manager. */
export function FolderRow({ text }: { text: ReactNode }) {
  const { t } = useTranslation('settings')
  const folder = useBackupStore((s) => s.status?.folder ?? null)
  const isDefault = useBackupStore((s) => s.status?.defaultFolder ?? true)
  const [error, setError] = useState<string | null>(null)
  const [update, resetError] = useUpdate()
  const api = window.kettu.backup
  const act = (run: () => Promise<unknown>) => {
    setError(null)
    run().catch((e: unknown) => setError(errorMessage(e)))
  }
  return (
    <>
      <BlockLine text={text}>
        <ControlError error={error ?? resetError} />
        {!isDefault && (
          <SetButton variant="ghost" onClick={() => update({ backup: { folder: null } })}>
            {t('backup.folder.reset')}
          </SetButton>
        )}
        <SetButton
          variant="ghost"
          icon={<Icon icon={FolderOpenIcon} size={14} />}
          disabled={!api || !folder}
          onClick={() => api && act(() => api.openFolder())}
        >
          {t('backup.folder.open')}
        </SetButton>
        <SetButton disabled={!api} onClick={() => api && act(() => api.chooseFolder())}>
          {t('backup.folder.choose')}
        </SetButton>
      </BlockLine>
      <div className="k-inset">{folder ? <PathText path={folder} /> : <Skel width={240} />}</div>
    </>
  )
}

export function RestoreControl() {
  const { t } = useTranslation(['settings', 'common'])
  const running = useBackupStore((s) => s.status?.running ?? false)
  const [candidate, setCandidate] = useState<RestoreCandidate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const api = window.kettu.backup
  if (!api) return null
  const pick = async () => {
    setError(null)
    setBusy(true)
    try {
      const picked = await api.pickRestore()
      if (picked?.kind === 'invalid') {
        setError(t('backup.restore.invalid', { message: picked.message }))
      } else if (picked) setCandidate(picked.candidate)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const restore = async (token: string) => {
    setCandidate(null)
    try {
      await api.restore(token)
      toast(t('backup.restore.restoring'), undefined, { tone: 'info' })
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <>
      <ControlError error={error} wrap />
      <SetButton loading={busy} disabled={busy || running} onClick={() => void pick()}>
        {t('backup.restore.button')}
      </SetButton>
      <AlertDialog open={candidate !== null} onOpenChange={(open) => !open && setCandidate(null)}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('backup.restore.title')}</AlertDialogTitle>
            <AlertDialogDescription render={<div className="flex flex-col gap-2" />}>
              {candidate && (
                <>
                  <p>
                    {t('backup.restore.made', {
                      file: candidate.file,
                      date: fullTime(candidate.created),
                      version: candidate.app,
                      count: candidate.files,
                      size: storageBytes(candidate.bytes),
                    })}
                  </p>
                  <p>{t('backup.restore.replaces')}</p>
                  <p>{t('backup.restore.keeps')}</p>
                  <p>{t('backup.restore.restart')}</p>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => candidate && void restore(candidate.token)}
            >
              {t('backup.restore.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** What went wrong with the last backup, and how the last restore went. */
export function BackupNotices() {
  const { t } = useTranslation('settings')
  const error = useBackupStore((s) => s.status?.error ?? null)
  const restore = useBackupStore((s) => s.status?.restore ?? null)
  if (!error && !restore) return null
  return (
    <div className="mt-3 flex flex-col gap-2">
      {error && (
        <Notice
          variant={error.problem === 'migrating' ? 'info' : 'error'}
          title={t(`backup.problem.${error.problem}`)}
        >
          {error.message ? `${mediumAgo(error.at)} · ${error.message}` : mediumAgo(error.at)}
        </Notice>
      )}
      {restore && (
        <Notice
          variant={restore.ok ? 'success' : 'error'}
          title={
            restore.ok
              ? t('backup.restore.done', { from: restore.from, when: mediumAgo(restore.at) })
              : t('backup.restore.failed', { from: restore.from })
          }
        >
          {restore.ok
            ? t('backup.restore.safety', { safety: restore.safety ?? '' })
            : restore.message}
        </Notice>
      )}
    </div>
  )
}

/** Advanced › Data's way to the Backup page, beside the storage the backup keeps. */
export function OpenBackupSettings() {
  const { t } = useTranslation('settings')
  return <SetButton onClick={() => openSettings('backup')}>{t('advanced.backup.open')}</SetButton>
}
