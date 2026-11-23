// Huli: Moli for background web reading in Settings › Browser, and its switch in Settings ›
// Features. Moli is downloaded only after the user saw its size in a dialog, and removable here;
// its status is read once when the row shows, then kept by the host's events. Huli's own; see
// tools/huli/README.md (Background web reading).

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { featureOn } from '@shared/features'
import { megabytes } from '@shared/web-reader'
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
import { errorMessage } from '@renderer/lib/host'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  downloadWebReader,
  loadWebReader,
  removeWebReader,
  stopWebReaderDownload,
  useWebReaderStore,
} from '@renderer/stores/web-reader'
import {
  CONFIRM,
  ControlError,
  DangerButton,
  Meter,
  SetButton,
  SettingSwitch,
  Spin,
} from './controls'
import { BlockLine } from './rows'

/** Asks before the download, with its size and where it comes from. */
function ConfirmDownload({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const download = useWebReaderStore((s) => s.status?.download ?? null)
  const mb = download ? megabytes(download.bytes) : 0
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent className={CONFIRM}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('browser.webReader.confirm.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('browser.webReader.confirm.body', { version: download?.version ?? '', mb })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tc('actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onClose()
              void downloadWebReader()
            }}
          >
            {t('browser.webReader.confirm.action', { mb })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The row in Settings › Browser: what is on disk, the download's progress, download and remove. */
export function WebReaderRow({ text }: { text: ReactNode }) {
  const { t } = useTranslation('settings')
  const status = useWebReaderStore((s) => s.status)
  const error = useWebReaderStore((s) => s.error)
  const on = useSettingsStore((s) => featureOn(s.settings.features, 'webReader'))
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  useEffect(() => {
    void loadWebReader()
  }, [])
  const task = status?.task ?? null
  const running = task?.state === 'running'
  const failed = task?.state === 'failed' ? task.error : null
  const installed = status?.installed ?? null
  const line = !status ? (
    <Spin />
  ) : running && task.kind === 'install' && task.phase === 'downloading' ? (
    <Meter
      value={(task.progress ?? 0) * 100}
      label={t('browser.webReader.downloading', {
        percent: Math.round((task.progress ?? 0) * 100),
      })}
      long
    />
  ) : running ? (
    t(`browser.webReader.${task.phase}`)
  ) : installed ? (
    t('browser.webReader.present', {
      version: installed.version,
      mb: megabytes(installed.bytes),
    })
  ) : status.download ? (
    t('browser.webReader.missing', {
      version: status.download.version,
      mb: megabytes(status.download.bytes),
    })
  ) : (
    t('browser.webReader.unsupported')
  )
  const control = !status ? null : running ? (
    task.kind === 'install' ? (
      <SetButton onClick={stopWebReaderDownload}>{t('browser.webReader.stop')}</SetButton>
    ) : (
      <Spin />
    )
  ) : installed ? (
    <DangerButton
      busy={removing}
      onClick={() => {
        setRemoving(true)
        void removeWebReader().finally(() => setRemoving(false))
      }}
    >
      {t('browser.webReader.remove', { mb: megabytes(installed.bytes) })}
    </DangerButton>
  ) : status.download ? (
    <SetButton onClick={() => setConfirming(true)}>
      {failed ? t('browser.webReader.retry') : t('browser.webReader.download')}
    </SetButton>
  ) : null
  return (
    <>
      <BlockLine text={text}>{control}</BlockLine>
      <div className="k-block-foot">
        <span>
          {line}
          {(failed ?? error) && <span className="k-error"> {failed ?? error}</span>}
        </span>
        {installed && !on && !running && (
          <span className="k-end">
            <span>{t('browser.webReader.off')}</span>
            <SetButton
              variant="ghost"
              onClick={() => {
                void useSettingsStore
                  .getState()
                  .update({ features: { webReader: true } })
                  .catch((e: unknown) => useWebReaderStore.setState({ error: errorMessage(e) }))
              }}
            >
              {t('browser.webReader.turnOn')}
            </SetButton>
          </span>
        )}
      </div>
      <ConfirmDownload open={confirming} onClose={() => setConfirming(false)} />
    </>
  )
}

/**
 * The feature's switch in Settings › Features: turning it on while Moli is not downloaded asks
 * first with its size, then downloads it; off leaves Moli on disk for the Browser row to remove.
 */
export function WebReaderSwitch({ label }: { label: string }) {
  const on = useSettingsStore((s) => featureOn(s.settings.features, 'webReader'))
  const installed = useWebReaderStore((s) => s.status?.installed ?? null)
  const known = useWebReaderStore((s) => s.status !== null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void loadWebReader()
  }, [])
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={on}
        disabled={!known && !on}
        onChange={(next) => {
          setError(null)
          if (next && !installed) {
            setConfirming(true)
            return
          }
          useSettingsStore
            .getState()
            .update({ features: { webReader: next } })
            .catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
      <ConfirmDownload open={confirming} onClose={() => setConfirming(false)} />
    </>
  )
}
