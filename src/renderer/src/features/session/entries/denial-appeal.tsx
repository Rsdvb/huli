// Huli: a call the agent's automatic review denied, which the user may still allow once: the
// host's risk of it, as a permission request's card shows, and Allow anyway, which a high risk
// confirms first.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { appealConfirms, type ToolEntry } from '@shared/thread'
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
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, host } from '@renderer/lib/host'
import { RiskBadge } from './risk-badge'

export function DenialAppeal({ sessionId, entry }: { sessionId: string; entry: ToolEntry }) {
  const { t } = useTranslation(['session', 'common'])
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const review = entry.review
  const appeal = review?.status === 'denied' ? review.appeal : undefined
  if (!review || !appeal) return null
  const confirms = appealConfirms(review)
  const allow = (confirmed: boolean) => {
    setBusy(true)
    setError(null)
    host('sessions.allowDenied', {
      sessionId,
      entryId: entry.id,
      ...(confirmed ? { confirmed } : {}),
    })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="ks-appeal" data-selectable="">
      {appeal.risk && (
        <p className="ks-appeal__risk">
          <RiskBadge level={appeal.risk.level} />
          <span>{appeal.risk.reason}</span>
        </p>
      )}
      {appeal.allowed ? (
        <p className="ks-appeal__done">{t('tool.appeal.allowed')}</p>
      ) : (
        <div className="ks-appeal__actions">
          <Button
            size="dialog"
            variant="outline"
            disabled={busy || !appeal.risk}
            onClick={() => (confirms ? setAsking(true) : allow(false))}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {t('tool.appeal.allow')}
          </Button>
          <span className="ks-appeal__hint">{t('tool.appeal.hint')}</span>
        </div>
      )}
      {error && <p className="ks-card-error">{error}</p>}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent className="gap-0 px-5.5 pt-5 pb-4.5 data-[size=default]:sm:max-w-[440px]">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tool.appeal.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              {[
                appeal.risk && t('tool.appeal.confirmRisk', { reason: appeal.risk.reason }),
                review.rationale && t('tool.appeal.confirmReview', { reason: review.rationale }),
                t('tool.appeal.confirmBody'),
              ]
                .filter(Boolean)
                .join('\n')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-4.5">
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setAsking(false)
                allow(true)
              }}
            >
              {t('tool.appeal.allow')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
