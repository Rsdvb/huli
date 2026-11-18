// Huli: the way into an import from Kettu, a row in Settings > General. Nothing looks for Kettu's
// data until the import is opened, as a look copies Kettu's whole thread database. Huli's own; see
// tools/huli/README.md.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SetButton } from '@renderer/features/settings/controls'
import { useFoundText } from './found-text'
import { KettuImportDialog } from './kettu-import-dialog'
import { useKettuImportStore } from './store'

/** Settings > General's row's line: the description, then what the last look found, if any. */
export function KettuImportStatus() {
  const { t } = useTranslation('kettuImport')
  const scan = useKettuImportStore((s) => s.scan)
  const scanError = useKettuImportStore((s) => s.scanError)
  const found = useFoundText(scan)
  const status = scanError
    ? t('error.scan', { error: scanError })
    : !scan
      ? null
      : !scan.found
        ? t('row.notFound')
        : scan.error
          ? t(`error.${scan.error}`)
          : scan.counts.sessions > 0 && scan.counts.imported === scan.counts.sessions
            ? t('row.allImported', found)
            : scan.counts.imported > 0
              ? t('row.foundSome', { ...found, count: scan.counts.imported })
              : t('row.found', found)
  return (
    <>
      {t('row.description')}
      {status && (
        <>
          <br />
          {status}
        </>
      )}
    </>
  )
}

/** The row's button, which opens the import; the dialog looks for Kettu's data as it opens. */
export function KettuImportButton() {
  const { t } = useTranslation('kettuImport')
  const [open, setOpen] = useState(false)
  return (
    <>
      <SetButton onClick={() => setOpen(true)}>{t('row.choose')}</SetButton>
      {open && <KettuImportDialog open={open} onOpenChange={setOpen} />}
    </>
  )
}
