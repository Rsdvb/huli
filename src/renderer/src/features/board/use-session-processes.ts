import { useCallback, useEffect, useRef, useState } from 'react'
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

/**
 * Huli: the session's background processes while the board shows them: read when it opens, when
 * `key` changes (a task starts or ends, a turn ends) and on `refresh`, never on a timer.
 */
export function useSessionProcesses(sessionId: string, key: string): ProcessesState {
  const [data, setData] = useState<SessionProcesses | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asked, setAsked] = useState(0)
  const latest = useRef(0)

  useEffect(() => {
    const run = ++latest.current
    setReading(true)
    host('sessions.processes', { sessionId })
      .then((answer) => {
        if (run !== latest.current) return
        setData(answer)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (run === latest.current) setError(errorMessage(reason))
      })
      .finally(() => {
        if (run === latest.current) setReading(false)
      })
  }, [sessionId, key, asked])

  useEffect(() => {
    setData(null)
    setError(null)
  }, [sessionId])

  const refresh = useCallback(() => setAsked((n) => n + 1), [])
  return { data, reading, error, refresh }
}
