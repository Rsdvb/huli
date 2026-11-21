// The GLM Coding Plan's quota windows. GLM Agent (`glm-acp-agent`, Apache-2.0, checked on 1.16.0
// and 1.17.1) reads them itself with the key it keeps and answers the ACP extension `_glm/usage`
// it advertises in `agentCapabilities._meta["glm-acp-agent/usage"]` (version 1), so Kite never
// touches that key. OpenCode's Z.AI and Zhipu providers ask the endpoint that extension and Z.AI's
// own usage plugin ask, `/api/monitor/usage/quota/limit`, with the key OpenCode stores.

import type { PlanLimit } from '@shared/agent-host'
import { number, object, percentLimit, time } from './common'

/** The first GLM Agent version that answers `_glm/usage`. */
export const GLM_USAGE_VERSION = '1.16.0'
export const GLM_USAGE_METHOD = '_glm/usage'
const GLM_USAGE_CAPABILITY = 'glm-acp-agent/usage'

/** Why GLM Agent could not read its quota, as `_glm/usage` names it. */
export type GlmUnavailable =
  | 'missingCredentials'
  | 'unsupportedEndpoint'
  | 'authenticationFailed'
  | 'requestFailed'
  | 'invalidResponse'

const REASONS: readonly GlmUnavailable[] = [
  'missingCredentials',
  'unsupportedEndpoint',
  'authenticationFailed',
  'requestFailed',
  'invalidResponse',
]

/** Whether an `initialize`'s agent capabilities advertise version 1 of the extension. */
export function offersGlmUsage(capabilities: unknown): boolean {
  const extension = object(object(object(capabilities)?._meta)?.[GLM_USAGE_CAPABILITY])
  return extension?.version === 1 && extension.method === GLM_USAGE_METHOD
}

const HOUR = 60
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** Kite's window for a quota window that lasts `minutes`, or of `kind` when its length is not told. */
function glmWindow(minutes: number | null, kind: unknown): { window: string; label: string } {
  if (minutes === 5 * HOUR) return { window: 'five_hour', label: '5-hour' }
  if (minutes === DAY) return { window: 'daily', label: 'Daily' }
  if (minutes === WEEK || (minutes === null && kind === 'weekly')) {
    return { window: 'seven_day', label: 'Weekly' }
  }
  if ((minutes !== null && minutes >= 30 * DAY) || (minutes === null && kind === 'monthly')) {
    return { window: 'monthly', label: 'Monthly' }
  }
  if (minutes !== null && minutes > 0 && minutes % HOUR === 0) {
    return { window: `${minutes / HOUR}_hour`, label: `${minutes / HOUR}-hour` }
  }
  return { window: 'glm', label: 'Usage' }
}

/** A window's name once per read: a second one of the same length gets a number. */
function uniqueWindow(taken: Set<string>, window: string): string {
  let name = window
  for (let n = 2; taken.has(name); n++) name = `${window}_${n}`
  taken.add(name)
  return name
}

/** What a `_glm/usage` answer gave: the model windows, when they were read, and what fell short. */
export interface GlmUsageRead {
  limits: PlanLimit[]
  /** The agent kept the windows of an earlier read, the last one having failed. */
  stale: boolean
  unavailable: GlmUnavailable | null
}

/**
 * A `_glm/usage` answer (version 1). Its MCP allowance (`calls`) is left out: web search and the
 * like run out there, never the model, and a used-up window would read as a plan used up.
 */
export function parseGlmUsage(value: unknown, now: number): GlmUsageRead | null {
  const root = object(value)
  if (!root || root.version !== 1 || !Array.isArray(root.windows)) return null
  const observedAt = Math.min(time(root.checkedAt) ?? now, now)
  const taken = new Set<string>()
  const limits: PlanLimit[] = []
  for (const item of root.windows.slice(0, 64)) {
    const read = object(item)
    const used = number(read?.usedPercent)
    if (!read || used === null || read.unit === 'calls') continue
    const named = glmWindow(number(read.windowDurationMins), read.kind)
    const window = uniqueWindow(taken, named.window)
    const limit = percentLimit(window, named.label, used, observedAt, time(read.resetsAt))
    const spent = number(read.used)
    const total = number(read.limit)
    limits.push(
      read.unit === 'credits' && spent !== null && total !== null && total > 0
        ? { ...limit, amount: { used: spent, total, unit: 'credits' } }
        : limit,
    )
  }
  const unavailable = object(root.unavailable)
  const reason = REASONS.find((known) => known === unavailable?.reason)
  return {
    limits,
    stale: root.stale === true,
    unavailable: unavailable ? (reason ?? 'requestFailed') : null,
  }
}

/** How long a quota row lasts by Z.AI's units, hours (3), days (4) and weeks (6); null else. */
function rowMinutes(unit: number | null, count: number | null): number | null {
  const each = unit === 3 ? HOUR : unit === 4 ? DAY : unit === 6 ? WEEK : null
  // Rows from before `number` was sent meant five hours and one week.
  const times = count ?? (unit === 3 ? 5 : 1)
  return each !== null && Number.isSafeInteger(times) && times > 0 ? each * times : null
}

/**
 * Z.AI's `/api/monitor/usage/quota/limit` reply, as OpenCode's Z.AI and Zhipu providers read it:
 * the model's `CREDIT_LIMIT` rows, the older `TOKENS_LIMIT` ones and the MCP allowance
 * `TIME_LIMIT`. Null when it is not that reply.
 */
export function parseGlmQuotaLimits(value: unknown, now: number): PlanLimit[] | null {
  const root = object(value)
  if (!root || root.success === false) return null
  const code = number(root.code)
  if (code !== null && code !== 200 && code !== 0) return null
  const rows = object(root.data)?.limits
  if (!Array.isArray(rows)) return null
  const taken = new Set<string>()
  const limits: PlanLimit[] = []
  for (const item of rows.slice(0, 64)) {
    const row = object(item)
    const used = number(row?.percentage)
    if (!row || used === null) continue
    const type = typeof row.type === 'string' ? row.type : ''
    const named =
      type === 'TIME_LIMIT'
        ? { window: 'tool_calls', label: 'Tool calls' }
        : type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT'
          ? glmWindow(rowMinutes(number(row.unit), number(row.number)), null)
          : type
            ? { window: `glm_${type.toLowerCase()}`, label: 'Usage' }
            : { window: 'glm', label: 'Usage' }
    const window = uniqueWindow(taken, named.window)
    limits.push(percentLimit(window, named.label, used, now, time(row.nextResetTime)))
  }
  return limits
}
