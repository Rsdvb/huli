import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_WEBHOOK_PORT,
  WEBHOOK_SECRET_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  webhookUrl,
  type RoutineView,
} from '@shared/routines'
import { Button } from '@renderer/components/affect/button'
import { CopyAction } from '@renderer/components/copy-action'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { errorMessage, routineHost } from '@renderer/lib/host'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSettingsStore } from '@renderer/stores/settings'
import { Row } from './kit'

/**
 * Huli: a routine that runs on its webhook: the loopback address it takes requests at, whether it
 * listens, and its secret, made here and shown once. A new routine has neither until it is saved.
 */
export function WebhookCard({ routine }: { routine: RoutineView | null }) {
  const { t } = useTranslation('routines')
  const setPort = useSettingsStore((s) => s.settings.webhooks?.port ?? DEFAULT_WEBHOOK_PORT)
  const [shown, setShown] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = routine?.webhook ?? null
  const local = routine ? routineHost(routine.id) === null : true
  const url = routine ? webhookUrl(state?.port ?? setPort, routine.id) : null

  const listening = !routine
    ? t('webhook.afterSave')
    : !local
      ? t('webhook.otherComputer')
      : !routine.enabled
        ? t('webhook.off')
        : state?.error
          ? t('webhook.cannotListen', { port: setPort, error: state.error })
          : state?.port
            ? t('webhook.listening', { port: state.port })
            : t('webhook.starting')

  const generate = () => {
    if (!routine || busy) return
    setBusy(true)
    setError(null)
    useRoutinesStore
      .getState()
      .webhookSecret(routine.id)
      .then(({ secret }) => setShown(secret))
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="ui-sg-card">
      <Row title={t('webhook.address')} note={listening}>
        {url && (
          <span className="k-webhook__value">
            <code className="k-webhook__code">{url}</code>
            <CopyAction text={url} label={t('webhook.copyAddress')} />
          </span>
        )}
      </Row>
      <Row
        title={t('webhook.secret')}
        note={error ?? t('webhook.secretHint', { header: WEBHOOK_SECRET_HEADER })}
      >
        <span className="k-webhook__value">
          <span className="k-value">
            {state?.secret ? t('webhook.secretSet') : t('webhook.secretNone')}
          </span>
          <Button
            size="md"
            variant="secondary"
            disabled={!routine || !local || busy}
            onClick={generate}
          >
            {state?.secret ? t('webhook.replace') : t('webhook.generate')}
          </Button>
        </span>
      </Row>
      <AlertDialog
        open={shown !== null}
        onOpenChange={(open) => {
          if (!open) setShown(null)
        }}
      >
        {shown !== null && url && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('webhook.shownTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('webhook.shownOnce')}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="k-webhook__shown">
              <span className="k-webhook__value">
                <code className="k-webhook__code k-webhook__code--secret">{shown}</code>
                <CopyAction text={shown} label={t('webhook.copySecret')} />
              </span>
              <small className="k-webhook__hint">
                {t('webhook.example', {
                  header: WEBHOOK_SECRET_HEADER,
                  signature: WEBHOOK_SIGNATURE_HEADER,
                })}
              </small>
              <span className="k-webhook__value">
                <code className="k-webhook__code">
                  {`curl -X POST -H "${WEBHOOK_SECRET_HEADER}: <secret>" -H "Content-Type: application/json" -d '{"text":"hi"}' ${url}`}
                </code>
                <CopyAction
                  text={`curl -X POST -H "${WEBHOOK_SECRET_HEADER}: ${shown}" -H "Content-Type: application/json" -d '{"text":"hi"}' ${url}`}
                  label={t('webhook.copyExample')}
                />
              </span>
            </div>
            <AlertDialogFooter>
              <AlertDialogAction onClick={() => setShown(null)}>
                {t('webhook.done')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  )
}
