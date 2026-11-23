import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserDownloadRequest } from '@shared/browser'
import { PaneSpinner } from '@renderer/features/shell/panel-button'
import { bytes } from '@renderer/lib/format'

/**
 * Huli: under the address, a large download of the agent's page waiting for the user: it goes
 * into the session's folder only once they allow it, and is cancelled otherwise.
 */
export function DownloadBar({
  request,
  onAnswer,
}: {
  request: BrowserDownloadRequest
  onAnswer: (allow: boolean) => void
}) {
  const { t } = useTranslation('browser')
  const [answering, setAnswering] = useState(false)
  const answer = (allow: boolean) => {
    setAnswering(true)
    onAnswer(allow)
  }
  return (
    <div role="alert" className="kp-origin" data-download-bar="">
      <span className="kp-origin__text">
        <span className="truncate">
          {request.size === null
            ? t('download.asksUnknown', { name: request.name })
            : t('download.asks', { name: request.name, size: bytes(request.size) })}
        </span>
      </span>
      <span className="kp-origin__acts">
        {answering ? (
          <PaneSpinner />
        ) : (
          <>
            <span className="kp-origin__gap" />
            <button type="button" className="kp-btn kp-btn--sm" onClick={() => answer(false)}>
              {t('download.cancel')}
            </button>
            <button
              type="button"
              className="kp-btn kp-btn--sm kp-btn--solid"
              onClick={() => answer(true)}
            >
              {t('download.allow')}
            </button>
          </>
        )}
      </span>
    </div>
  )
}
