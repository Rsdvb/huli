import { useEffect, useState } from 'react'
import { FileUploadIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import type { UploadConsent } from '@shared/control'
import { Button } from '@renderer/components/ui/button'
import { bytes } from '@renderer/lib/format'

/**
 * How long the answers stay off after the question shows, so a click the user meant for the page
 * that lands as the card appears answers nothing.
 */
const ARM_MS = 600

/**
 * Over the page while the agent waits: the files it wants to upload and the site they would go
 * to, with Allow and Deny. Main settles the call with the answer; no answer is a refusal.
 */
export function UploadConsentCard({
  consent,
  agentName,
  onAnswer,
}: {
  consent: UploadConsent
  agentName: string
  onAnswer: (allow: boolean) => void
}) {
  const { t } = useTranslation('control')
  const [armed, setArmed] = useState(false)
  const [answered, setAnswered] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(timer)
  }, [])

  const answer = (allow: boolean) => {
    if (!armed || answered) return
    setAnswered(true)
    onAnswer(allow)
  }
  const b = <b dir="auto" />
  const [only] = consent.files
  const one = consent.files.length === 1 && only !== undefined
  return (
    <div
      role="alertdialog"
      aria-labelledby="ctl-consent-title"
      className="ctl-consent"
      onKeyDown={(event) => {
        if (event.key === 'Escape') answer(false)
      }}
    >
      <div className="ctl-consent__head">
        <span className="ctl-consent__icon">
          <HugeiconsIcon icon={FileUploadIcon} strokeWidth={1.9} aria-hidden className="size-4" />
        </span>
        <p id="ctl-consent-title" className="ctl-consent__title">
          {one ? (
            <Trans
              t={t}
              i18nKey="upload.one"
              values={{ name: only.name, site: consent.site }}
              components={{ b }}
            />
          ) : (
            <Trans
              t={t}
              i18nKey="upload.many"
              values={{ count: consent.files.length, site: consent.site }}
              components={{ b }}
            />
          )}
        </p>
      </div>
      <ul className="ctl-consent__files">
        {consent.files.map((file, index) => (
          <li key={index}>
            <span className="truncate" dir="auto">
              {file.name}
            </span>
            <span className="ctl-consent__size">{bytes(file.size)}</span>
          </li>
        ))}
      </ul>
      <p className="ctl-consent__hint">{t('upload.hint', { agent: agentName })}</p>
      <div className="ctl-consent__acts">
        <Button
          variant="secondary"
          size="dialog"
          disabled={!armed || answered}
          onClick={() => answer(false)}
        >
          {t('upload.deny')}
        </Button>
        <Button size="dialog" disabled={!armed || answered} onClick={() => answer(true)}>
          {t('upload.allow')}
        </Button>
      </div>
    </div>
  )
}
