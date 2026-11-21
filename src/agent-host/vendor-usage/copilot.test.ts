import { describe, expect, it } from 'vitest'
import { parseCopilotQuota } from './copilot'
import quota from './fixtures/copilot-get-quota.json'

describe('Copilot quota reply', () => {
  it('maps recorded premium request counts', () => {
    const result = parseCopilotQuota(
      {
        quota_snapshots: {
          premium_interactions: { entitlement: 300, quota_remaining: 288, percent_remaining: 96 },
        },
      },
      10,
    )
    expect(result?.limits[0].amount).toEqual({ used: 12, total: 300, unit: 'requests' })
  })

  it("reads the CLI's typed quota snapshots with the date the month resets", () => {
    expect(parseCopilotQuota(quota, 10)?.limits).toEqual([
      {
        window: 'monthly',
        label: 'Monthly',
        usedPercent: 4,
        resetsAt: Date.parse('2026-12-01T00:00:00.000Z'),
        state: 'ok',
        observedAt: 10,
        amount: { used: 12, total: 300, unit: 'requests' },
      },
    ])
  })

  it("takes GitHub's own quota_reset_date when a snapshot names none", () => {
    const result = parseCopilotQuota(
      {
        quota_reset_date: '2026-12-01',
        quota_snapshots: { premium_interactions: { entitlement: 300, quota_remaining: 0 } },
      },
      10,
    )
    expect(result?.limits[0]).toMatchObject({
      resetsAt: Date.parse('2026-12-01T00:00:00Z'),
      state: 'reached',
    })
  })

  it('gives no window for an unlimited entitlement, and nothing for another reply', () => {
    const unlimited = {
      quotaSnapshots: {
        premium_interactions: {
          ...quota.quotaSnapshots.premium_interactions,
          isUnlimitedEntitlement: true,
        },
      },
    }
    expect(parseCopilotQuota(unlimited, 10)).toEqual({ limits: [], balances: [] })
    expect(
      parseCopilotQuota({ quotaSnapshots: { chat: quota.quotaSnapshots.chat } }, 10),
    ).toBeNull()
  })
})
