import { describe, expect, it } from 'vitest'
import type { AgentStatus, PlanLimit } from './agent-host'
import { fallbackAgent, hasExtraUsage, planQuota } from './plan-quota'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function limit(window: string, usedPercent: number | null, changes: Partial<PlanLimit> = {}) {
  return {
    window,
    label: window,
    usedPercent,
    resetsAt: NOW + HOUR,
    state: 'ok',
    observedAt: NOW,
    ...changes,
  } satisfies PlanLimit
}

function agent(id: string, changes: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id,
    name: id,
    state: 'ready',
    signIn: 'signed-in',
    hidden: false,
    limits: [],
    ...changes,
  } as AgentStatus
}

describe('planQuota', () => {
  it('is open with the fullest window used', () => {
    const status = agent('claude-code', {
      limits: [limit('five_hour', 12), limit('seven_day', 65)],
    })
    expect(planQuota(status, NOW)).toEqual({ kind: 'open', usedPercent: 65 })
  })

  it('is out until the latest reset of the used-up windows', () => {
    const week = limit('seven_day', 100, { resetsAt: NOW + 50 * HOUR })
    const status = agent('codex', {
      limits: [limit('five_hour', null, { state: 'reached' }), week],
    })
    expect(planQuota(status, NOW)).toEqual({ kind: 'out', limit: week, resetsAt: week.resetsAt })
  })

  it('holds without a reset when a used-up window gives none', () => {
    const forever = limit('monthly', 100, { resetsAt: null })
    const status = agent('codex', { limits: [limit('five_hour', 100), forever] })
    expect(planQuota(status, NOW)).toMatchObject({ kind: 'out', resetsAt: null })
  })

  it('lets a used-up window without a reset go once its reading is a period old', () => {
    const DAY = 24 * HOUR
    const monthly = limit('monthly', 100, { resetsAt: null, observedAt: NOW - 30 * DAY })
    expect(planQuota(agent('qoder', { limits: [monthly] }), NOW)).toMatchObject({ kind: 'out' })
    const old = { ...monthly, observedAt: NOW - 32 * DAY }
    expect(planQuota(agent('qoder', { limits: [old] }), NOW)).toEqual({ kind: 'unknown' })
    // OpenCode names a provider's window after the provider, and a window Kite does not know
    // lasts a month.
    const fiveHour = limit('zai:five_hour', 100, { resetsAt: null, observedAt: NOW - 6 * HOUR })
    expect(planQuota(agent('opencode', { limits: [fiveHour] }), NOW)).toEqual({ kind: 'unknown' })
    const odd = limit('budget_x', 100, { resetsAt: null, observedAt: NOW - 20 * DAY })
    expect(planQuota(agent('opencode', { limits: [odd] }), NOW)).toMatchObject({ kind: 'out' })
  })

  it('runs on extra usage once the windows are used up and credits are left', () => {
    const status = agent('codex', {
      limits: [limit('seven_day', 100)],
      balances: [{ label: 'Extra usage', amount: 62_500, currency: 'credits' }],
    })
    expect(planQuota(status, NOW)).toMatchObject({ kind: 'extra' })
    const spent = { ...status, balances: [{ label: 'Extra usage', amount: 0, currency: 'USD' }] }
    expect(planQuota(spent, NOW)).toMatchObject({ kind: 'out' })
  })

  it("takes Claude Code's open overage window for extra usage", () => {
    const limits = [limit('five_hour', null, { state: 'reached' }), limit('overage', 10)]
    expect(hasExtraUsage({}, limits, NOW)).toBe(true)
    expect(planQuota(agent('claude-code', { limits }), NOW)).toMatchObject({ kind: 'extra' })
    const closed = [limits[0]!, limit('overage', 100, { state: 'reached' })]
    expect(planQuota(agent('claude-code', { limits: closed }), NOW)).toMatchObject({ kind: 'out' })
  })

  it('skips windows whose reset has passed, and knows nothing without any', () => {
    const status = agent('codex', { limits: [limit('five_hour', 100, { resetsAt: NOW - 1 })] })
    expect(planQuota(status, NOW)).toEqual({ kind: 'unknown' })
  })
})

describe('fallbackAgent', () => {
  const codex = agent('codex', {
    limits: [limit('seven_day', 100, { state: 'reached' })],
    balances: [{ label: 'Extra usage', amount: 62_500, currency: 'credits' }],
  })
  const claude = agent('claude-code', { name: 'Claude Code', limits: [limit('seven_day', 65)] })

  it('suggests the agent with the most room left', () => {
    const gemini = agent('gemini', { limits: [limit('daily', 30)] })
    expect(fallbackAgent([codex, claude, gemini], 'codex', NOW)).toEqual({
      agentId: 'gemini',
      name: 'gemini',
      usedPercent: 30,
    })
  })

  it('never suggests the agent itself, nor one that is off, signed out or used up', () => {
    const off = agent('off', { disabled: true, limits: [limit('seven_day', 1)] })
    const signedOut = agent('out', { signIn: 'required', limits: [limit('seven_day', 1)] })
    const hidden = agent('hidden', { hidden: true, limits: [limit('seven_day', 1)] })
    const missing = agent('missing', { state: 'not-installed', limits: [limit('seven_day', 1)] })
    const full = agent('full', { limits: [limit('seven_day', 100)] })
    expect(fallbackAgent([off, signedOut, hidden, missing, full, codex], 'claude-code', NOW)).toBe(
      null,
    )
    expect(fallbackAgent([claude], 'claude-code', NOW)).toBe(null)
  })

  it('never suggests an agent whose use is unknown or that runs on extra usage', () => {
    const unknown = agent('opencode', { limits: [] })
    expect(fallbackAgent([codex, unknown], 'claude-code', NOW)).toBe(null)
  })

  it('judges by the whole plan, not a used-up window of one model', () => {
    const opus = agent('claude-code', {
      limits: [limit('seven_day', 40), limit('seven_day_opus', 100, { state: 'reached' })],
    })
    expect(fallbackAgent([opus], 'codex', NOW)).toMatchObject({ agentId: 'claude-code' })
  })

  it('leaves out agents at or over the share asked, and reads the windows given', () => {
    expect(fallbackAgent([claude], 'codex', NOW, { below: 65 })).toBe(null)
    expect(fallbackAgent([claude], 'codex', NOW, { below: 90 })).toMatchObject({
      usedPercent: 65,
    })
    const newer = [limit('seven_day', 20)]
    expect(fallbackAgent([claude], 'codex', NOW, { limitsOf: () => newer })).toMatchObject({
      usedPercent: 20,
    })
    expect(fallbackAgent([claude], 'codex', NOW, { eligible: () => false })).toBe(null)
  })
})
