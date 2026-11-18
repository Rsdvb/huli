// Whether an agent's plan can take another turn, and which other agent can when it cannot: what
// New session, the composer, a turn stopped at its limit and a routine's run all decide by.

import type { AgentStatus, PlanLimit } from './agent-host'
import type { AgentId } from './thread'

/** The balance a vendor bills once the plan's windows run out, as the hosts label it. */
export const EXTRA_USAGE = 'Extra usage'

/** Claude Code's window for extra usage, which pays past the plan's own windows. */
const OVERAGE_WINDOW = 'overage'

/**
 * Where an agent's plan stands: `open` with room left and the share of its fullest window used,
 * `extra` with its windows used up but extra usage paying on, `out` used up until `resetsAt`,
 * the latest of the used-up windows' resets, null when one gives none; `unknown` with no window
 * read.
 */
export type PlanQuota =
  | { kind: 'open'; usedPercent: number | null }
  | { kind: 'extra'; limit: PlanLimit; resetsAt: number | null }
  | { kind: 'out'; limit: PlanLimit; resetsAt: number | null }
  | { kind: 'unknown' }

/** A window used up: reached, or at 100% by the whole percentage shown. */
export function windowUsedUp(limit: Pick<PlanLimit, 'usedPercent' | 'state'>): boolean {
  return limit.state === 'reached' || Math.round(limit.usedPercent ?? 0) >= 100
}

const current = (limit: PlanLimit, now: number): boolean =>
  limit.resetsAt === null || limit.resetsAt > now

/** Whether extra usage pays once the plan's windows run out: a positive balance or an open overage window. */
export function hasExtraUsage(
  status: Pick<AgentStatus, 'balances'>,
  limits: readonly PlanLimit[],
  now: number,
): boolean {
  if ((status.balances ?? []).some((b) => b.label === EXTRA_USAGE && b.amount > 0)) return true
  return limits.some((l) => l.window === OVERAGE_WINDOW && current(l, now) && !windowUsedUp(l))
}

/**
 * Where the agent's plan stands by `limits`, its own unless a caller passes the windows that hold
 * back one model or a newer reading of the account. A window whose reset has passed is skipped.
 */
export function planQuota(
  status: Pick<AgentStatus, 'balances' | 'limits'>,
  now: number,
  limits: readonly PlanLimit[] = status.limits,
): PlanQuota {
  const windows = limits.filter((l) => l.window !== OVERAGE_WINDOW && current(l, now))
  if (windows.length === 0) return { kind: 'unknown' }
  const out = windows.filter(windowUsedUp)
  if (out.length > 0) {
    // The plan answers again once every used-up window has reset; one without a reset holds.
    const limit = out.reduce((a, b) =>
      a.resetsAt === null ? a : b.resetsAt === null || b.resetsAt > a.resetsAt ? b : a,
    )
    const kind = hasExtraUsage(status, limits, now) ? 'extra' : 'out'
    return { kind, limit, resetsAt: limit.resetsAt }
  }
  const known = windows.flatMap((l) => (l.usedPercent === null ? [] : [l.usedPercent]))
  return { kind: 'open', usedPercent: known.length > 0 ? Math.max(...known) : null }
}

/**
 * The windows that count the whole plan: not a model group's, nor a weekly window of one model,
 * such as Claude Code's `seven_day_opus`, which leaves the plan's other models open.
 */
export function planWideLimits(limits: readonly PlanLimit[]): PlanLimit[] {
  return limits.filter((l) => !l.models?.length && !/^seven_day_./.test(l.window))
}

/** An agent with room left to take over, and the share of its fullest window used. */
export interface Fallback {
  agentId: AgentId
  name: string
  usedPercent: number
}

/** Whether an agent could take a turn now: added, turned on, installed and signed in. */
export function canTakeOver(status: AgentStatus): boolean {
  return (
    status.registered !== false &&
    !status.disabled &&
    !status.hidden &&
    status.uninstalled !== true &&
    status.signIn === 'signed-in' &&
    status.state !== 'not-installed' &&
    status.state !== 'node-missing' &&
    status.state !== 'node-outdated'
  )
}

/**
 * The agent to suggest in place of `from` once its plan is used up: of the others that could take
 * a turn, the one whose plan is open with the least of its fullest window used, below `below`
 * percent. Agents whose use is not known, or that would run on extra usage, are never suggested,
 * since neither is room the plan has. Ties keep the order given.
 */
export function fallbackAgent(
  statuses: readonly AgentStatus[],
  from: AgentId,
  now: number,
  options: {
    /** Only agents under this share used; 100 by default. */
    below?: number
    /** The windows to judge an agent by, such as the account's newest reading; its own by default. */
    limitsOf?: (status: AgentStatus) => readonly PlanLimit[]
    /** Narrows the agents further, such as to those New session can start. */
    eligible?: (status: AgentStatus) => boolean
  } = {},
): Fallback | null {
  const below = options.below ?? 100
  let best: Fallback | null = null
  for (const status of statuses) {
    if (status.id === from || !canTakeOver(status)) continue
    if (options.eligible && !options.eligible(status)) continue
    const limits = planWideLimits(options.limitsOf?.(status) ?? status.limits)
    const quota = planQuota(status, now, limits)
    if (quota.kind !== 'open' || quota.usedPercent === null) continue
    if (Math.round(quota.usedPercent) >= below) continue
    if (!best || quota.usedPercent < best.usedPercent) {
      best = { agentId: status.id, name: status.name, usedPercent: quota.usedPercent }
    }
  }
  return best
}
