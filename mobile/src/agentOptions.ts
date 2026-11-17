// What each agent's new sessions start with, from `agents.options`: the options its last new session
// reported (the host lists them only in answer to a session's start), for New session's controls
// and for the default model the Switch agent page names.

import { useCallback, useEffect, useState } from 'react'
import type { AgentOptions } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import { call, errorText } from './git'

export interface AgentOptionsView {
  options: AgentOptions[] | null
  error: string | null
  reload(): void
}

export function useAgentOptions(link: HostLink, enabled: boolean): AgentOptionsView {
  const [options, setOptions] = useState<AgentOptions[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let live = true
    setError(null)
    call(link, 'agents.options', undefined).then(
      (next) => live && setOptions(next),
      (failed: unknown) => live && setError(errorText(failed, '没能读取 Agent 的选项。')),
    )
    return () => {
      live = false
    }
  }, [link, enabled, round])

  const reload = useCallback(() => setRound((n) => n + 1), [])
  return { options, error, reload }
}
