// Huli: the ways into an import from Kettu: a row in Settings > General, and an offer over the
// sidebar's account row while this computer has no session yet. Huli's own; see
// tools/huli/README.md.

import { useEffect, useState } from 'react'
import { Download04Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Glyph } from '@renderer/features/shell/glyph'
import { Button } from '@renderer/components/ui/button'
import { NoticeCard } from '@renderer/features/updates/update-notice'
import { SetButton } from '@renderer/features/settings/controls'
import { readJson, writeJson } from '@renderer/lib/storage'
import { hostOfSession, listedOrigin, useSessionsStore } from '@renderer/stores/sessions'
import { useFoundText } from './found-text'
import { KettuImportDialog } from './kettu-import-dialog'
import { scanKettu, useKettuImportStore } from './store'

/** Whether the offer was answered on this device, by Import or by closing it. */
const OFFERED_KEY = 'huli.kettu-import.offered'

/** Settings > General's row's line: the description, then what the last look found. */
export function KettuImportStatus() {
  const { t } = useTranslation('kettuImport')
  const scan = useKettuImportStore((s) => s.scan)
  const scanError = useKettuImportStore((s) => s.scanError)
  const found = useFoundText(scan)
  useEffect(() => {
    void scanKettu()
  }, [])
  const status = scanError
    ? t('error.scan', { error: scanError })
    : !scan
      ? t('row.looking')
      : !scan.found
        ? t('row.notFound')
        : scan.error
          ? t(`error.${scan.error}`)
          : scan.counts.importable === 0 && scan.counts.sessions > 0
            ? t('row.allImported', found)
            : t('row.found', found)
  return (
    <>
      {t('row.description')}
      <br />
      {status}
    </>
  )
}

/** The row's button, which opens the choice of sessions once Kettu's were found. */
export function KettuImportButton() {
  const { t } = useTranslation('kettuImport')
  const scan = useKettuImportStore((s) => s.scan)
  const [open, setOpen] = useState(false)
  return (
    <>
      <SetButton disabled={!scan?.found || scan.error !== null} onClick={() => setOpen(true)}>
        {t('row.choose')}
      </SetButton>
      {open && <KettuImportDialog open={open} onOpenChange={setOpen} />}
    </>
  )
}

/**
 * Once, while this computer has no session of its own: Kettu's sessions were found, to import.
 * Closing it or opening the import answers it for good on this device.
 */
export function KettuImportOffer({ blocked }: { blocked: boolean }) {
  const { t } = useTranslation('kettuImport')
  const [answered, setAnswered] = useState(() => readJson(OFFERED_KEY, false))
  const [open, setOpen] = useState(false)
  const loaded = useSessionsStore((s) => s.loaded)
  const empty = useSessionsStore(
    (s) =>
      !Object.values(s.byId).some(
        (x) => listedOrigin(x) && !x.archivedAt && hostOfSession(x) === null,
      ),
  )
  const importable = useKettuImportStore((s) =>
    s.scan?.found && !s.scan.error ? s.scan.counts.importable : 0,
  )
  const asking = loaded && empty && !answered
  useEffect(() => {
    if (asking) void scanKettu()
  }, [asking])
  const answer = () => {
    writeJson(OFFERED_KEY, true)
    setAnswered(true)
  }
  const label = t('offer.text', { count: importable })
  return (
    <>
      {asking && !blocked && importable > 0 && (
        <NoticeCard
          icon={<Glyph icon={Download04Icon} size={14} />}
          text={label}
          label={label}
          detail={t('offer.detail')}
          onOpen={() => setOpen(true)}
          action={
            <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
              {t('offer.action')}
            </Button>
          }
          onDismiss={answer}
        />
      )}
      {open && (
        <KettuImportDialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) answer()
          }}
        />
      )}
    </>
  )
}
