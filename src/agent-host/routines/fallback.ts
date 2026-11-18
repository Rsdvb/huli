// What a routine's run does when its agent's plan is used up: wait for it, as every routine did, or
// go on with another agent whose plan has room, when the routine chose that and one has.

import type { AgentStatus } from '@shared/agent-host'
import { fallbackAgent, type Fallback } from '@shared/plan-quota'
import type { OnLimit } from '@shared/routines'
import type { AgentId } from '@shared/thread'
import { NEAR_LIMIT_PERCENT } from './scheduler'

export type LimitDecision = { kind: 'wait' } | { kind: 'switch'; to: Fallback }

/**
 * The run's choice once `from`'s plan holds it back. Another agent counts only below the share
 * that would hold its own routines back, so a switch never lands on a plan about to pause.
 */
export function limitDecision(
  onLimit: OnLimit,
  from: AgentId,
  statuses: readonly AgentStatus[],
  now: number,
): LimitDecision {
  if (onLimit !== 'switch') return { kind: 'wait' }
  const to = fallbackAgent(statuses, from, now, { below: NEAR_LIMIT_PERCENT })
  return to ? { kind: 'switch', to } : { kind: 'wait' }
}
