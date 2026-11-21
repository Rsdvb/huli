// The GLM Coding Plan's windows: GLM Agent's own `_glm/usage` answer, in the shape its README and
// parser (1.17.1) give, and Z.AI's quota reply that OpenCode's providers read.

import { describe, expect, it } from 'vitest'
import usage from './fixtures/glm-usage.json'
import quota from './fixtures/zai-quota-limit.json'
import { offersGlmUsage, parseGlmQuotaLimits, parseGlmUsage } from './glm'

const NOW = Date.parse('2026-11-21T04:30:00.000Z')
const CHECKED = Date.parse('2026-11-21T04:29:30.000Z')

describe('GLM Agent quota', () => {
  it('reads only version 1 of the extension the agent advertises', () => {
    const meta = { 'glm-acp-agent/usage': { version: 1, method: '_glm/usage' } }
    expect(offersGlmUsage({ loadSession: true, _meta: meta })).toBe(true)
    expect(
      offersGlmUsage({ _meta: { 'glm-acp-agent/usage': { version: 2, method: '_glm/usage' } } }),
    ).toBe(false)
    expect(offersGlmUsage({ loadSession: true })).toBe(false)
    expect(offersGlmUsage(null)).toBe(false)
  })

  it('maps the model windows by length, as read when the agent checked, MCP left out', () => {
    expect(parseGlmUsage(usage, NOW)).toEqual({
      limits: [
        {
          window: 'five_hour',
          label: '5-hour',
          usedPercent: 25,
          resetsAt: Date.parse('2026-11-21T08:00:00.000Z'),
          state: 'ok',
          observedAt: CHECKED,
          amount: { used: 500, total: 2000, unit: 'credits' },
        },
        {
          window: 'seven_day',
          label: 'Weekly',
          usedPercent: 12.5,
          resetsAt: Date.parse('2026-11-24T00:00:00.000Z'),
          state: 'ok',
          observedAt: CHECKED,
          amount: { used: 1250, total: 10000, unit: 'credits' },
        },
      ],
      stale: false,
      unavailable: null,
    })
  })

  it('tells why the agent could not read its quota, and keeps windows it kept', () => {
    const failed = {
      version: 1,
      checkedAt: '2026-11-21T04:30:00.000Z',
      stale: false,
      windows: [],
      unavailable: { reason: 'authenticationFailed', message: 'Z.AI rejected the key' },
    }
    expect(parseGlmUsage(failed, NOW)).toEqual({
      limits: [],
      stale: false,
      unavailable: 'authenticationFailed',
    })
    const odd = { ...failed, unavailable: { reason: 'somethingNew', message: '' } }
    expect(parseGlmUsage(odd, NOW)?.unavailable).toBe('requestFailed')
    const kept = { ...usage, stale: true, unavailable: { reason: 'requestFailed', message: '' } }
    const read = parseGlmUsage(kept, NOW)
    expect(read?.stale).toBe(true)
    expect(read?.limits.map((limit) => limit.window)).toEqual(['five_hour', 'seven_day'])
  })

  it('refuses another answer, and never names two windows alike', () => {
    expect(parseGlmUsage({ version: 2, windows: [] }, NOW)).toBeNull()
    expect(parseGlmUsage({ version: 1 }, NOW)).toBeNull()
    const twice = {
      version: 1,
      checkedAt: usage.checkedAt,
      windows: [usage.windows[0], usage.windows[0]],
    }
    expect(parseGlmUsage(twice, NOW)?.limits.map((limit) => limit.window)).toEqual([
      'five_hour',
      'five_hour_2',
    ])
  })
})

describe("Z.AI's quota reply", () => {
  it('reads the credit windows by unit and number, and the MCP allowance', () => {
    expect(
      parseGlmQuotaLimits(quota, NOW)?.map(({ window, label, usedPercent, resetsAt }) => ({
        window,
        label,
        usedPercent,
        resetsAt,
      })),
    ).toEqual([
      { window: 'five_hour', label: '5-hour', usedPercent: 25, resetsAt: 1795320000000 },
      { window: 'seven_day', label: 'Weekly', usedPercent: 12.5, resetsAt: 1795564800000 },
      { window: 'tool_calls', label: 'Tool calls', usedPercent: 3, resetsAt: 1796083200000 },
    ])
  })

  it('reads the older token rows, which sent no number', () => {
    const older = {
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, percentage: 40 },
          { type: 'TOKENS_LIMIT', unit: 6, percentage: 10 },
        ],
      },
    }
    expect(parseGlmQuotaLimits(older, NOW)?.map((limit) => limit.window)).toEqual([
      'five_hour',
      'seven_day',
    ])
  })

  it('refuses an error answer', () => {
    expect(parseGlmQuotaLimits({ code: 401, success: false, msg: 'no' }, NOW)).toBeNull()
    expect(parseGlmQuotaLimits({ code: 200, success: true, data: {} }, NOW)).toBeNull()
  })
})
