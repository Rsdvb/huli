// An account's plan limits are its own, wherever it is signed in: each host reads them for its
// agents, and every view shows the newest of those readings, the window's and the island's alike.

import type { AgentStatus, PlanLimit } from './agent-host'

/** What picking an account's newest plan limit reading inspects on each agent. */
export type PlanReadingAgent = Pick<AgentStatus, 'harnessId' | 'account' | 'limits'>

/** A computer's agents, null being this computer. */
export interface HostAgentList {
  hostId: string | null
  agents: readonly AgentStatus[]
}

/** One host's agents for picking each account's newest reading, null being this computer. */
export interface HostPlanList {
  hostId: string | null
  agents: readonly PlanReadingAgent[]
}

/** When the limits were read, the latest window's; null while there are none. */
export const readAtOf = (limits: readonly PlanLimit[]): number | null =>
  limits.length > 0 ? Math.max(...limits.map((limit) => limit.observedAt)) : null

/**
 * What tells one subscription account on any computer: the harness, the email, the plan and its
 * tier. Null when the agent signs in some other way or reports no email, so its account cannot be
 * told.
 */
export function accountKey(agent: Pick<AgentStatus, 'harnessId' | 'account'>): string | null {
  const account = agent.account
  if (account?.kind !== 'account') return null
  const email = account.email?.trim().toLowerCase()
  if (!email) return null
  return [agent.harnessId, email, account.label, account.tier ?? ''].join('\n')
}

/** An account's newest reading, kept whole. */
export interface PlanReading {
  hostId: string | null
  limits: PlanLimit[]
  readAt: number
}

/**
 * The newest reading of each account on any of `hosts`. Limits belong to the account, so one
 * signed in on several computers shows one reading everywhere; windows of two readings are never
 * mixed, so a window only an older one has does not come back.
 */
export function newestReadings(hosts: readonly HostPlanList[]): Map<string, PlanReading> {
  const readings = new Map<string, PlanReading>()
  for (const { hostId, agents } of hosts) {
    for (const agent of agents) {
      const key = accountKey(agent)
      const readAt = readAtOf(agent.limits)
      if (key === null || readAt === null) continue
      const kept = readings.get(key)
      if (kept && kept.readAt >= readAt) continue
      readings.set(key, { hostId, limits: agent.limits, readAt })
    }
  }
  return readings
}

/** The agent's limits as last read of its account on any host; its own when its account cannot be told. */
export function newestLimits(
  readings: ReadonlyMap<string, PlanReading>,
  agent: PlanReadingAgent,
): PlanLimit[] {
  const key = accountKey(agent)
  return (key === null ? undefined : readings.get(key)?.limits) ?? agent.limits
}
