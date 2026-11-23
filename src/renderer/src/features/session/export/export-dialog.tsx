// Huli: the dialog of Export… in a session's menu: the format, what to include, and Export…,
// after which main's save dialog asks where. Mounted once for the window.

import { useId, useState } from 'react'
import { FileExportIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ExportFormat, ExportOptions } from '@shared/session-export'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
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
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { sessionTitle } from '@renderer/stores/sessions'
import { exportSession, keepChoice, lastChoice, useExportStore, type ExportChoice } from './export'

const FORMATS: ExportFormat[] = ['html', 'md', 'zip', 'pdf']
const OPTIONS: (keyof ExportOptions)[] = ['thoughts', 'tools', 'subagents']

export function SessionExportDialog() {
  const summary = useExportStore((s) => s.summary)
  return (
    <Dialog
      open={summary !== null}
      onOpenChange={(open) => !open && useExportStore.setState({ summary: null })}
    >
      <DialogContent className="sm:max-w-md">
        {summary && <ExportForm key={summary.id} />}
      </DialogContent>
    </Dialog>
  )
}

function ExportForm() {
  const { t } = useTranslation(['session', 'common'])
  const summary = useExportStore((s) => s.summary)!
  const [choice, setChoice] = useState<ExportChoice>(lastChoice)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()

  const run = async () => {
    setBusy(true)
    setError(null)
    keepChoice(choice)
    try {
      const saved = await exportSession(summary, choice)
      if (saved) {
        useExportStore.setState({ summary: null })
        toast(t('export.saved'), undefined, { icon: FileExportIcon })
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('export.title')}</DialogTitle>
        <DialogDescription className="truncate">{sessionTitle(summary)}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <RadioGroup
          aria-label={t('export.format')}
          value={choice.format}
          onValueChange={(format) => setChoice({ ...choice, format: format as ExportFormat })}
          className="gap-1.5"
        >
          {FORMATS.map((format) => (
            <RadioGroupTile key={format} value={format} disabled={busy}>
              <div className="text-control font-medium text-foreground">
                {t(`export.formats.${format}.name`)}
              </div>
              <div className="text-hint text-muted-foreground">
                {t(`export.formats.${format}.hint`)}
              </div>
            </RadioGroupTile>
          ))}
        </RadioGroup>
        <fieldset className="flex flex-col gap-2.5" disabled={busy}>
          <legend className="mb-2 text-hint font-medium text-muted-foreground">
            {t('export.include')}
          </legend>
          {OPTIONS.map((option) => (
            <label
              key={option}
              htmlFor={`${id}-${option}`}
              className="flex items-start gap-2.5 text-control text-foreground"
            >
              <Checkbox
                id={`${id}-${option}`}
                className="mt-0.5"
                checked={choice.options[option]}
                onCheckedChange={(checked) =>
                  setChoice({ ...choice, options: { ...choice.options, [option]: checked } })
                }
              />
              <span>{t(`export.options.${option}`)}</span>
            </label>
          ))}
        </fieldset>
        <p className="text-hint text-muted-foreground">{t('export.masked')}</p>
        {error && (
          <p role="alert" className="text-hint text-danger">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="dialog" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button size="dialog" disabled={busy} onClick={() => void run()}>
          {busy && <Spinner />}
          {busy ? t('export.building') : t('export.export')}
        </Button>
      </DialogFooter>
    </>
  )
}
