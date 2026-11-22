import { useCallback, useEffect, useState } from 'react'
import type { SessionProcesses } from '@shared/task-processes'
import { errorMessage, host } from '@renderer/lib/host'

export interface ProcessesState {
  /** The latest reading; null before the first. */
  data: SessionProcesses | null
  reading: boolean
  /** Why the latest reading failed; the one before it stays. */
  error: string | null
  refresh(): void
}

interface Answer {
  /** The reading it answers, as `ask` names one. */
  ask: string
  sessionId: string
  data: SessionProcesses | null
  error: string | null
}

/**
 * Huli: the session's background processes while the board shows them: read when it opens, when
 * `key` changes (a task starts or ends, a turn ends) and on `refresh`, never on a timer.
 */
export function useSessionProcesses(sessionId: string, key: string): ProcessesState {
  const [asked, setAsked] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const ask = `${sessionId}\n${key}\n${asked}`

  useEffect(() => {
    let current = true
    host('sessions.processes', { sessionId })
      .then((data) => {
        if (current) setAnswer({ ask, sessionId, data, error: null })
      })
      .catch((reason: unknown) => {
        if (!current) return
        setAnswer((prev) => ({
          ask,
          sessionId,
          data: prev?.sessionId === sessionId ? prev.data : null,
          error: errorMessage(reason),
        }))
      })
    return () => {
      current = false
    }
  }, [ask, sessionId])

  const refresh = useCallback(() => setAsked((n) => n + 1), [])
  const own = answer?.sessionId === sessionId ? answer : null
  return {
    data: own?.data ?? null,
    reading: answer?.ask !== ask,
    error: own?.error ?? null,
    refresh,
  }
}
