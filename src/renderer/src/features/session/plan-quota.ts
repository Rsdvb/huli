// What the pickers and the thread say of a used-up plan, and the agent they suggest in its place.

import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import { fallbackAgent, planQuota, type Fallback, type PlanQuota } from '@shared/plan-quota'
import type { AgentId } from '@shared/thread'
import { menuAgents } from './new-session/start-options'
import { backTime, limitPhrase } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { newestLimits } from '@renderer/lib/plan-readings'
import { agentsOn, usableAgents, useAgentsStore, usePlanReadings } from '@renderer/stores/agents'

/**
 * A used-up plan in a line: "Weekly limit used up · back Mon 2:00 PM", or that extra usage pays
 * on; null while the plan has room or its use is unknown.
 */
export function quotaText(quota: PlanQuota, now: number): string | null {
  if (quota.kind === 'extra') {
    return i18n.t('session:quota.extra', { limit: limitPhrase(quota.limit) })
  }
  if (quota.kind !== 'out') return null
  const limit = limitPhrase(quota.limit)
  return quota.resetsAt !== null && quota.resetsAt > now
    ? i18n.t('session:quota.out', { limit, time: backTime(quota.resetsAt, now) })
    : i18n.t('session:quota.outNoReset', { limit })
}

/** The agent's plan by the account's newest reading. */
export function agentQuota(
  status: AgentStatus,
  readings: ReturnType<typeof usePlanReadings>,
  now: number,
): PlanQuota {
  return planQuota(status, now, newestLimits(readings, status))
}

/**
 * The agent of `hostId` to suggest in place of `from` while `wanted`, such as while its plan is
 * out: one New session can start whose plan has the most room.
 */
export function useFallback(
  hostId: string | null,
  from: AgentId | null,
  wanted: boolean,
  now: number,
): Fallback | null {
  const readings = usePlanReadings()
  const statuses = useAgentsStore(
    useShallow((s) => {
      const { order, byId } = agentsOn(s, hostId)
      return menuAgents(usableAgents(order, byId))
    }),
  )
  if (!from || !wanted) return null
  return fallbackAgent(statuses, from, now, {
    limitsOf: (status) => newestLimits(readings, status),
  })
}
