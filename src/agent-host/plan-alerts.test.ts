import { describe, expect, it } from 'vitest'
import type { AgentStatus, PlanAlert, PlanLimit } from '@shared/agent-host'
import {
  alertKey,
  alertLevel,
  crossing,
  parsePlanAlertsFile,
  PlanAlerts,
  SAME_PERIOD_MS,
  type AlertRecord,
  type PlanAlertsFile,
} from './plan-alerts'

const HOUR = 60 * 60_000
const NOW = Date.UTC(2026, 10, 18, 22, 0)
const RESET = NOW + 2 * HOUR

function limit(usedPercent: number | null, changes: Partial<PlanLimit> = {}): PlanLimit {
  return {
    window: 'five_hour',
    label: '5-hour',
    usedPercent,
    resetsAt: RESET,
    state: 'ok',
    observedAt: NOW,
    ...changes,
  }
}

function status(limits: PlanLimit[], changes: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    account: { kind: 'account', label: 'Claude Max', email: 'me@example.com' },
    limits,
    ...changes,
  } as AgentStatus
}

/** A file kept in memory, as a restart reads it again. */
function memoryFile(initial: PlanAlertsFile = { version: 1, alerted: [] }) {
  const file = {
    data: initial,
    load: async () => file.data,
    save: (data: PlanAlertsFile) => {
      file.data = data
    },
    flush: async () => {},
  }
  return file
}

async function started(file: ReturnType<typeof memoryFile>, clock: { now: number }) {
  const alerts: PlanAlert[] = []
  const planAlerts = new PlanAlerts({
    file,
    alert: (alert) => alerts.push(alert),
    log: () => {},
    now: () => clock.now,
  })
  await planAlerts.whenLoaded()
  // The records are taken in a step after they are read.
  await Promise.resolve()
  return { planAlerts, alerts }
}

const key = alertKey('claude-code', 'account:me@example.com', 'five_hour')

describe('alertLevel', () => {
  it('goes by the whole percentage shown, and a reached window is used up', () => {
    expect(alertLevel(limit(89.4))).toBeNull()
    expect(alertLevel(limit(89.5))).toBe(90)
    expect(alertLevel(limit(99))).toBe(90)
    expect(alertLevel(limit(100))).toBe(100)
    expect(alertLevel(limit(null, { state: 'reached' }))).toBe(100)
    expect(alertLevel(limit(null))).toBeNull()
  })
})

describe('crossing', () => {
  it('says 90 once, then 100 once, in one period', () => {
    const first = crossing(null, key, limit(91), NOW)
    expect(first.say).toBe(90)
    const again = crossing(first.record, key, limit(95), NOW + 1000)
    expect(again.say).toBeNull()
    expect(again.record).toBe(first.record)
    const out = crossing(again.record, key, limit(100), NOW + 2000)
    expect(out.say).toBe(100)
    expect(crossing(out.record, key, limit(null, { state: 'reached' }), NOW + 3000).say).toBeNull()
  })

  it('says 100 alone when a window runs out without a reading at 90 first', () => {
    const { say, record } = crossing(null, key, limit(100), NOW)
    expect(say).toBe(100)
    expect(crossing(record, key, limit(93), NOW).say).toBeNull()
  })

  it('says nothing under 90% or for a reading from before its reset', () => {
    expect(crossing(null, key, limit(89), NOW)).toEqual({ say: null, record: null })
    const stale = limit(97, { resetsAt: NOW - 1000 })
    expect(crossing(null, key, stale, NOW)).toEqual({ say: null, record: null })
  })

  it('keeps the period when the reset moves a little between readings', () => {
    const { record } = crossing(null, key, limit(92), NOW)
    const moved = limit(96, { resetsAt: RESET + SAME_PERIOD_MS / 2 })
    expect(crossing(record, key, moved, NOW + HOUR).say).toBeNull()
  })

  it('says it again in the next period', () => {
    const { record } = crossing(null, key, limit(100), NOW)
    const next = limit(90, { resetsAt: RESET + 5 * HOUR })
    expect(crossing(record, key, next, RESET + 1000).say).toBe(90)
  })

  it('starts over when a window without a reset time falls under 90%', () => {
    const untimed = (used: number) => limit(used, { resetsAt: null })
    const { record } = crossing(null, key, untimed(92), NOW)
    expect(crossing(record, key, untimed(95), NOW).say).toBeNull()
    const fell = crossing(record, key, untimed(10), NOW + HOUR)
    expect(fell.record).toBeNull()
    expect(crossing(fell.record, key, untimed(91), NOW + 2 * HOUR).say).toBe(90)
  })

  it('keeps the period when a timed window reads under 90% before its reset', () => {
    const { record } = crossing(null, key, limit(92), NOW)
    const lower = crossing(record, key, limit(80), NOW + HOUR)
    expect(lower.record).toBe(record)
    expect(crossing(lower.record, key, limit(93), NOW + HOUR).say).toBeNull()
  })
})

describe('PlanAlerts', () => {
  it('alerts once per window and account, with what the window shows', async () => {
    const clock = { now: NOW }
    const { planAlerts, alerts } = await started(memoryFile(), clock)
    planAlerts.observe(status([limit(92), limit(40, { window: 'seven_day', label: 'Weekly' })]))
    planAlerts.observe(status([limit(94)]))
    expect(alerts).toEqual([
      {
        agentId: 'claude-code',
        agentName: 'Claude Code',
        window: 'five_hour',
        label: '5-hour',
        level: 90,
        usedPercent: 92,
        resetsAt: RESET,
      },
    ])
    // Another account of the same agent has a plan of its own.
    const other = { kind: 'account' as const, label: 'Claude Pro', email: 'work@example.com' }
    planAlerts.observe(status([limit(95)], { account: other }))
    expect(alerts).toHaveLength(2)
  })

  it('remembers what it said across a restart', async () => {
    const file = memoryFile()
    const clock = { now: NOW }
    const first = await started(file, clock)
    first.planAlerts.observe(status([limit(92)]))
    expect(first.alerts).toHaveLength(1)

    clock.now = NOW + 10 * 60_000
    const second = await started(file, clock)
    second.planAlerts.observe(status([limit(93)]))
    expect(second.alerts).toEqual([])
    second.planAlerts.observe(status([limit(100)]))
    expect(second.alerts.map((alert) => alert.level)).toEqual([100])
  })

  it('takes a status that came before the records were read once they are', async () => {
    const file = memoryFile({
      version: 1,
      alerted: [{ key, resetsAt: RESET, level: 90, at: NOW - HOUR }],
    })
    let loaded!: () => void
    const gate = new Promise<void>((resolve) => (loaded = resolve))
    const alerts: PlanAlert[] = []
    const planAlerts = new PlanAlerts({
      file: { ...file, load: () => gate.then(() => file.data) },
      alert: (alert) => alerts.push(alert),
      log: () => {},
      now: () => NOW,
    })
    planAlerts.observe(status([limit(95)]))
    planAlerts.observe(status([limit(100)]))
    expect(alerts).toEqual([])
    loaded()
    await planAlerts.whenLoaded()
    await Promise.resolve()
    // The 90% it said before the restart is not said again; the latest reading is.
    expect(alerts.map((alert) => alert.level)).toEqual([100])
  })

  it('drops the records whose period is over when it saves', async () => {
    const old: AlertRecord = { key: 'old', resetsAt: NOW - HOUR, level: 100, at: NOW - 2 * HOUR }
    const file = memoryFile({ version: 1, alerted: [old] })
    const { planAlerts } = await started(file, { now: NOW })
    planAlerts.observe(status([limit(92)]))
    expect(file.data.alerted.map((record) => record.key)).toEqual([key])
  })

  it("watches each OpenCode provider's windows apart", async () => {
    const { planAlerts, alerts } = await started(memoryFile(), { now: NOW })
    const provider = (id: string, used: number) => ({
      id,
      name: id,
      methods: [],
      accounts: [],
      loginCommand: '',
      usage: {
        state: 'ready' as const,
        limits: [limit(used)],
        balances: [],
        observedAt: NOW,
        error: null,
      },
    })
    planAlerts.observe(
      status([], {
        id: 'opencode',
        name: 'OpenCode',
        account: null,
        providers: [provider('go', 96), provider('zen', 50)],
      }),
    )
    expect(alerts).toMatchObject([{ agentId: 'opencode', provider: 'go', level: 90 }])
  })
})

describe('parsePlanAlertsFile', () => {
  it('keeps the records that read as ones', () => {
    const good = { key, resetsAt: RESET, level: 90, at: NOW }
    const parsed = parsePlanAlertsFile({
      alerted: [
        good,
        { ...good, key: 'b', level: 80 },
        { ...good, key: 'c', resetsAt: 'soon' },
        { ...good, key: '' },
        { ...good },
        { key: 'd', resetsAt: null, level: 100, at: NOW },
        'x',
      ],
    })
    expect(parsed).toEqual({
      version: 1,
      alerted: [good, { key: 'd', resetsAt: null, level: 100, at: NOW }],
    })
    expect(typeof parsePlanAlertsFile({ alerted: 'none' })).toBe('string')
  })
})
