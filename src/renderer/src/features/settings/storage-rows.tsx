// The Storage row: what the host's data folder holds, by what keeps it, and the clear of the
// pictures of sessions archived or idle for long.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  IMAGE_CLEAR_DAYS,
  type ImageClear,
  type ImageClearScope,
  type StorageUsage,
} from '@shared/data-usage'
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
import { storageBytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useHostScope } from '@renderer/stores/host-scope'
import { CONFIRM, ControlError, Segmented, SetButton, Skel } from './controls'
import { BlockLine } from './rows'

const PARTS = ['threads', 'media', 'attachments', 'artifacts', 'logs', 'usage'] as const

/** A clear's choice: the archived sessions, or those idle for one of the spans. */
type Choice = 'archived' | `older-${(typeof IMAGE_CLEAR_DAYS)[number]}`

const CHOICES: Choice[] = ['archived', ...IMAGE_CLEAR_DAYS.map((days) => `older-${days}` as const)]

function paramsOf(choice: Choice): { scope: ImageClearScope; days: number } {
  return choice === 'archived'
    ? { scope: 'archived', days: IMAGE_CLEAR_DAYS[0] }
    : { scope: 'older', days: Number(choice.slice('older-'.length)) }
}

export function StorageRow({ text }: { text: ReactNode }) {
  const { t } = useTranslation('settings')
  const { request } = useHostScope()
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const measure = useCallback(
    () =>
      request('storage.usage', undefined).then(
        (measured) => {
          setUsage(measured)
          setError(null)
        },
        (e: unknown) => setError(errorMessage(e)),
      ),
    [request],
  )
  useEffect(() => {
    void measure()
  }, [measure])
  const total = usage ? PARTS.reduce((sum, part) => sum + usage[part], 0) : null
  return (
    <>
      <BlockLine text={text}>
        <ControlError error={error} />
        {total !== null && (
          <span className="k-value k-num">
            {t('advanced.storage.total', { size: storageBytes(total) })}
          </span>
        )}
        <SetButton onClick={() => setOpen(true)}>{t('advanced.storage.clean')}</SetButton>
      </BlockLine>
      <div className="k-subrows">
        {PARTS.map((part) => (
          <div key={part} className="k-subrow">
            <span className="ui-sg-label">
              <b>{t(`advanced.storage.parts.${part}`)}</b>
            </span>
            {usage ? (
              <span className="k-value k-num">{storageBytes(usage[part])}</span>
            ) : error ? (
              <span className="k-muted">-</span>
            ) : (
              <Skel width={56} />
            )}
          </div>
        ))}
      </div>
      <ClearImages open={open} onOpenChange={setOpen} onCleared={() => void measure()} />
    </>
  )
}

function ClearImages({
  open,
  onOpenChange,
  onCleared,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCleared: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const { request } = useHostScope()
  const [choice, setChoice] = useState<Choice>('archived')
  const [preview, setPreview] = useState<{ choice: Choice; clear: ImageClear } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    let current = true
    request('storage.clearImages', { ...paramsOf(choice), dryRun: true }).then(
      (clear) => current && setPreview({ choice, clear }),
      (e: unknown) => current && setError(errorMessage(e)),
    )
    return () => {
      current = false
    }
  }, [open, choice, request])
  const counted = preview?.choice === choice ? preview.clear : null
  const clear = async () => {
    setBusy(true)
    setError(null)
    try {
      const done = await request('storage.clearImages', { ...paramsOf(choice), dryRun: false })
      toast(
        t('advanced.storage.cleared', {
          images: t('advanced.storage.images', { count: done.images }),
          size: storageBytes(done.bytes),
        }),
      )
      onOpenChange(false)
      onCleared()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <AlertDialogContent className={CONFIRM}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('advanced.storage.dialogTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('advanced.storage.dialogDescription')}</AlertDialogDescription>
        </AlertDialogHeader>
        <Segmented
          label={t('advanced.storage.scope')}
          value={choice}
          options={CHOICES.map((value) => ({
            value,
            label:
              value === 'archived'
                ? t('advanced.storage.archived')
                : t('advanced.storage.older', { count: paramsOf(value).days }),
          }))}
          onChange={(next) => {
            setError(null)
            setChoice(next)
          }}
        />
        <p
          className={cn('text-hint text-pretty', error ? 'text-destructive' : 'text-(--shell-ink)')}
          role={error ? 'alert' : undefined}
          aria-live="polite"
        >
          {error
            ? error
            : !counted
              ? t('advanced.storage.counting')
              : counted.images === 0
                ? t('advanced.storage.nothing')
                : t('advanced.storage.preview', {
                    images: t('advanced.storage.images', { count: counted.images }),
                    sessions: t('advanced.storage.sessions', { count: counted.sessions }),
                    size: storageBytes(counted.bytes),
                  })}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy || !counted || counted.images === 0}
            onClick={(event) => {
              // Stays open until the clear is done, so its error shows here.
              event.preventDefault()
              void clear()
            }}
          >
            {t('advanced.storage.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
