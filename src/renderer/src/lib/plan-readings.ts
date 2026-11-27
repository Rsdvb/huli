// An account's plan limits are its own, wherever it is signed in: each host reads them for its
// agents, and every view shows the newest of those readings.

import type { AgentStatus, PlanLimit, PlanResets, ResetsError } from '@shared/agent-host'
import {
  accountKey,
  newestLimits,
  type HostAgentList,
  type PlanReading,
} from '@shared/plan-readings'
import type { AgentId } from '@shared/thread'

export {
  accountKey,
  newestLimits,
  newestReadings,
  readAtOf,
  type HostAgentList,
  type PlanReading,
} from '@shared/plan-readings'

/** A key for what is one computer's own, such as an agent whose account cannot be told. */
export const ownKey = (hostId: string | null, id: string): string => `${hostId ?? ''}/${id}`

/** The key of an account's card or read, the same on every computer. */
export const accountCardKey = (account: string): string => `account:${account}`

/** The reset credits an account holds, as last read on any of its computers. */
export interface CardResets {
  /** How many it holds; 0 when only why they could not be read is known. */
  count: number
  /** Each credit, the soonest to run out first; null while the expiries are unknown. */
  each: NonNullable<PlanResets['each']> | null
  error: ResetsError | null
  observedAt: number
  /** The computer and agent that read them, which one is spent through. */
  hostId: string | null
  agentId: AgentId
}

/** What an agent read of its account's reset credits; null when it holds and reports none. */
export function resetsOf(agent: AgentStatus, hostId: string | null): CardResets | null {
  const held = agent.resets && agent.resets.count > 0 ? agent.resets : null
  if (!held && !agent.resetsError) return null
  return {
    count: held?.count ?? 0,
    each: held?.each ?? null,
    error: agent.resetsError ?? null,
    observedAt: held?.observedAt ?? 0,
    hostId,
    agentId: agent.id,
  }
}

/** The later reading of two, since the credits are the account's wherever it is signed in. */
export const newerResets = (a: CardResets | null, b: CardResets | null): CardResets | null =>
  a && b ? (b.observedAt > a.observedAt ? b : a) : (a ?? b)

/** An agent standing for its account among the hosts shown, with the account's newest limits. */
export interface AccountAgent {
  key: string
  hostId: string | null
  /** Every host shown that it is on, in order. */
  hostIds: (string | null)[]
  agent: AgentStatus
  limits: PlanLimit[]
  /** The account's reset credits at their newest reading; null when it holds none. */
  resets: CardResets | null
  /** The agent's name, or the account's email when its agents go by different names. */
  name: string
}

/**
 * The agents of `hosts` by account: one signed in on several computers or agents once, the first
 * in order, with its newest reading in `readings`; an agent whose account cannot be told, as itself.
 */
export function accountAgents(
  hosts: readonly HostAgentList[],
  readings: ReadonlyMap<string, PlanReading>,
): AccountAgent[] {
  const found: AccountAgent[] = []
  const names = new Map<string, Set<string>>()
  for (const { hostId, agents } of hosts) {
    for (const agent of agents) {
      const account = accountKey(agent)
      const key = account === null ? ownKey(hostId, agent.id) : accountCardKey(account)
      names.set(key, (names.get(key) ?? new Set()).add(agent.name))
      const same = found.find((other) => other.key === key)
      if (same) {
        if (!same.hostIds.includes(hostId)) same.hostIds.push(hostId)
        same.resets = newerResets(same.resets, resetsOf(agent, hostId))
        continue
      }
      found.push({
        key,
        hostId,
        hostIds: [hostId],
        agent,
        limits: newestLimits(readings, agent),
        resets: resetsOf(agent, hostId),
        name: agent.name,
      })
    }
  }
  for (const entry of found) {
    const email = entry.agent.account?.email?.trim()
    if (email && names.get(entry.key)!.size > 1) entry.name = email
  }
  return found
}

/** A computer's agent a refresh can read a card's limits through. */
export interface LimitWay {
  hostId: string | null
  agentId: AgentId
}

/**
 * What a refresh reads, by card key: an account once, through its computers in turn, an agent
 * that runs before one only installed; an OpenCode agent's providers and any other agent with
 * limits on their own computer. `reachable` says which computers answer now.
 */
export function limitWays(
  hosts: readonly HostAgentList[],
  reachable: (hostId: string | null) => boolean,
): Map<string, LimitWay[]> {
  const ways = new Map<string, (LimitWay & { running: boolean })[]>()
  for (const { hostId, agents } of hosts) {
    if (!reachable(hostId)) continue
    for (const agent of agents) {
      if (agent.disabled || agent.registered === false) continue
      const running = agent.state === 'ready'
      const account = accountKey(agent)
      if (agent.providers !== undefined) {
        ways.set(ownKey(hostId, agent.id), [{ hostId, agentId: agent.id, running }])
        continue
      }
      // One that is not started is read too, or its card would keep an old reading.
      if (!running && agent.state !== 'available') continue
      if (agent.limits.length === 0 && !agent.capabilities.reports) continue
      if (account === null) {
        ways.set(ownKey(hostId, agent.id), [{ hostId, agentId: agent.id, running }])
        continue
      }
      const key = accountCardKey(account)
      ways.set(key, [...(ways.get(key) ?? []), { hostId, agentId: agent.id, running }])
    }
  }
  return new Map(
    [...ways].map(([key, list]) => [
      key,
      [...list.filter((way) => way.running), ...list.filter((way) => !way.running)].map(
        ({ hostId, agentId }) => ({ hostId, agentId }),
      ),
    ]),
  )
}
