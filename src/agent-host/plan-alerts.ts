// Plan-limit alerts: when a window of an account's plan crosses 90% used, and again when it runs
// out, the host says so once in that window's reset period. What it already said is kept in the
// host's state, so a restart, which reads the same windows again, says nothing new.

import path from 'node:path'
import type { AgentStatus, PlanAlert, PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { JsonFile, type LogFn, type Migration } from './storage'

export type AlertLevel = PlanAlert['level']

/** What was said for one window: its reset then, and how far it had got. */
export interface AlertRecord {
  /** The agent, its account and the window, as `alertKey` joins them. */
  key: string
  resetsAt: number | null
  level: AlertLevel
  /** When it was said. */
  at: number
}

export interface PlanAlertsFile {
  version: 1
  alerted: AlertRecord[]
}

export const PLAN_ALERTS_VERSION = 1
export const PLAN_ALERTS_MIGRATIONS: Readonly<Record<number, Migration>> = {}

/**
 * How far a window's reset may move between readings and still be the same period: `/usage` gives
 * it to the minute and the rate-limit events to the second, and some agents count it from the time
 * of the reading.
 */
export const SAME_PERIOD_MS = 15 * 60_000
/** A record of a window that never says when it resets is dropped after this long. */
export const UNTIMED_KEEP_MS = 30 * 24 * 60 * 60_000
const MAX_RECORDS = 500
const MAX_KEY = 1000

/** The level a window has reached, by the whole percentage shown; null under 90%. */
export function alertLevel(limit: Pick<PlanLimit, 'usedPercent' | 'state'>): AlertLevel | null {
  if (limit.state === 'reached') return 100
  if (limit.usedPercent === null) return null
  const used = Math.round(limit.usedPercent)
  return used >= 100 ? 100 : used >= 90 ? 90 : null
}

/**
 * Who a status's plan belongs to: the account's email, or the agent alone without one. Not its
 * label, which changes once the agent reads the plan's name.
 */
export function accountOf(status: Pick<AgentStatus, 'account'>): string {
  return status.account?.email?.trim().toLowerCase() ?? ''
}

export function alertKey(agentId: AgentId, account: string, window: string): string {
  return [agentId, account, window].join('\n')
}

/** A record still in its period: its reset has not passed, or it never said one recently. */
function current(record: AlertRecord, now: number): boolean {
  return record.resetsAt === null ? now - record.at < UNTIMED_KEEP_MS : now < record.resetsAt
}

/**
 * What a new reading of a window means for what was said of it: a level to say now, or none, and
 * the record to keep (null drops it).
 */
export function crossing(
  record: AlertRecord | null,
  key: string,
  limit: Pick<PlanLimit, 'usedPercent' | 'state' | 'resetsAt'>,
  now: number,
): { say: AlertLevel | null; record: AlertRecord | null } {
  // A reading from before its window reset says nothing of the period now.
  if (limit.resetsAt !== null && limit.resetsAt <= now) {
    return { say: null, record: record && current(record, now) ? record : null }
  }
  const level = alertLevel(limit)
  let kept = record && current(record, now) ? record : null
  if (kept && level === null) {
    // Under 90% again: a window that names no reset, or whose reset moved, has started over.
    const moved =
      kept.resetsAt !== null &&
      limit.resetsAt !== null &&
      Math.abs(kept.resetsAt - limit.resetsAt) > SAME_PERIOD_MS
    if (kept.resetsAt === null || limit.resetsAt === null || moved) kept = null
  }
  if (level === null || (kept && kept.level >= level)) return { say: null, record: kept }
  return {
    say: level,
    record: { key, resetsAt: limit.resetsAt ?? kept?.resetsAt ?? null, level, at: now },
  }
}

const isLevel = (value: unknown): value is AlertLevel => value === 90 || value === 100
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Keeps the records that read as ones and drops the rest. */
export function parsePlanAlertsFile(data: Record<string, unknown>): PlanAlertsFile | string {
  if (!Array.isArray(data.alerted)) return 'alerted is not a list'
  const alerted: AlertRecord[] = []
  const seen = new Set<string>()
  for (const item of data.alerted.slice(-MAX_RECORDS)) {
    if (typeof item !== 'object' || item === null) continue
    const { key, resetsAt, level, at } = item as Record<string, unknown>
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY || seen.has(key)) {
      continue
    }
    if (!(resetsAt === null || isTime(resetsAt)) || !isLevel(level) || !isTime(at)) continue
    seen.add(key)
    alerted.push({ key, resetsAt, level, at })
  }
  return { version: 1, alerted }
}

export function planAlertsFile(userDataPath: string, log: LogFn): JsonFile<PlanAlertsFile> {
  return new JsonFile<PlanAlertsFile>({
    file: path.join(userDataPath, 'state', 'plan-alerts.json'),
    version: PLAN_ALERTS_VERSION,
    migrations: PLAN_ALERTS_MIGRATIONS,
    parse: parsePlanAlertsFile,
    empty: () => ({ version: 1, alerted: [] }),
    log,
  })
}

export interface PlanAlertsDeps {
  file: Pick<JsonFile<PlanAlertsFile>, 'load' | 'save' | 'flush'>
  /** A window crossed a level, said once. */
  alert(alert: PlanAlert): void
  log: LogFn
  now?: () => number
}

/** The windows a status reports: its own plan's, and each OpenCode provider's. */
function windowsOf(status: AgentStatus): { provider?: string; limits: readonly PlanLimit[] }[] {
  return [
    { limits: status.limits },
    ...(status.providers ?? []).map((provider) => ({
      provider: provider.id,
      limits: provider.usage?.limits ?? [],
    })),
  ]
}

export class PlanAlerts {
  private records = new Map<string, AlertRecord>()
  private readonly loaded: Promise<void>
  /** Statuses that arrived before the records were read, the latest of each agent. */
  private waiting = new Map<AgentId, AgentStatus>()
  private ready = false

  constructor(private readonly deps: PlanAlertsDeps) {
    this.loaded = deps.file.load().then(
      (data) => {
        const now = this.now()
        for (const record of data.alerted) {
          if (current(record, now)) this.records.set(record.key, record)
        }
      },
      (error: unknown) => {
        deps.log('warn', `Could not read the plan-limit alerts: ${(error as Error).message}`)
      },
    )
    void this.loaded.then(() => {
      this.ready = true
      const waiting = [...this.waiting.values()]
      this.waiting.clear()
      for (const status of waiting) this.observe(status)
    })
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Resolves once the records have been read. */
  whenLoaded(): Promise<void> {
    return this.loaded
  }

  /** An agent reported its status, its plan windows among it. */
  observe(status: AgentStatus): void {
    if (!this.ready) {
      this.waiting.set(status.id, status)
      return
    }
    if (status.disabled || status.uninstalled) return
    const now = this.now()
    const account = accountOf(status)
    let changed = false
    for (const { provider, limits } of windowsOf(status)) {
      for (const limit of limits) {
        const scope = provider === undefined ? limit.window : `${provider}/${limit.window}`
        const key = alertKey(status.id, account, scope)
        const before = this.records.get(key) ?? null
        const { say, record } = crossing(before, key, limit, now)
        if (record !== before) {
          changed = true
          if (record) this.records.set(key, record)
          else this.records.delete(key)
        }
        if (say === null) continue
        this.deps.alert({
          agentId: status.id,
          agentName: status.name,
          ...(provider === undefined ? {} : { provider }),
          window: limit.window,
          label: limit.label,
          level: say,
          usedPercent: limit.usedPercent,
          resetsAt: limit.resetsAt,
        })
      }
    }
    if (changed) this.save(now)
  }

  private save(now: number): void {
    for (const [key, record] of this.records) {
      if (!current(record, now)) this.records.delete(key)
    }
    const alerted = [...this.records.values()].sort((a, b) => a.at - b.at).slice(-MAX_RECORDS)
    this.deps.file.save({ version: 1, alerted })
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }
}
