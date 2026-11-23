import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage, host } from '@renderer/lib/host'

/** Huli: moves what holds up a tool call to the background; `error` says why the last try failed. */
export function useToBackground(sessionId: string, toolCallId: string) {
  const { t } = useTranslation('board')
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const move = () => {
    setMoving(true)
    setError(null)
    host('sessions.toBackground', { sessionId, toolCallId })
      .then(({ moved }) => {
        if (!moved) setError(t('held.notMoved'))
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setMoving(false))
  }
  return { move, moving, error }
}
