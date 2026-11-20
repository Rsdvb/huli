// One field of a session's summary, for a row of its conversation: the whole summary changes with
// each turn's status, time and counts, and a row that read it all for the agent's id was drawn
// again with each of those.

import { useCallback } from 'react'
import type { SessionSummary } from '@shared/agent-host'
import { useHostSelector, type HostData } from '../../host'

/**
 * `pick` of the session's summary, redrawn only when what it picks changes; undefined without one.
 * `pick` should be the same function each render, such as `agentIdOf`.
 */
export function useSessionField<T>(
  id: string | null | undefined,
  pick: (summary: SessionSummary) => T,
): T | undefined {
  return useHostSelector(
    useCallback(
      (d: HostData) => {
        const summary = id ? d.sessions.get(id) : undefined
        return summary ? pick(summary) : undefined
      },
      [id, pick],
    ),
  )
}

export const agentIdOf = (summary: SessionSummary): string => summary.agentId
