import { describe, expect, it, vi } from 'vitest'
import deepSeekBalance from '../vendor-usage/fixtures/deepseek-user-balance.json'
import openRouterKey from '../vendor-usage/fixtures/openrouter-key.json'
import siliconFlowUser from '../vendor-usage/fixtures/siliconflow-user-info.json'
import zaiQuota from '../vendor-usage/fixtures/zai-quota-limit.json'
import {
  failedUsage,
  parseOpenRouterKey,
  parseSiliconFlowUser,
  readProviderUsage,
  unsupportedUsage,
  USAGE_ERROR,
} from './provider-usage'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fetchOnce(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => json(body, status)) as unknown as typeof fetch
}

describe('readProviderUsage', () => {
  it('leaves a provider without a known endpoint unsupported and sends nothing', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch
    expect(await readProviderUsage({ providerId: 'mystery', key: 'k', now: 7, fetch })).toEqual(
      unsupportedUsage(7),
    )
    expect(await readProviderUsage({ providerId: 'constructor', key: 'k', now: 7, fetch })).toEqual(
      unsupportedUsage(7),
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('turns a failed request, a redirect and a malformed answer into one generic error', async () => {
    const server = await readProviderUsage({
      providerId: 'deepseek',
      key: 'sk-leak',
      now: 8,
      fetch: fetchOnce({ error: 'bad key sk-leak' }, 500),
    })
    expect(server).toEqual(failedUsage(8))
    expect(JSON.stringify(server)).not.toContain('sk-leak')

    const redirect = await readProviderUsage({
      providerId: 'deepseek',
      key: 'sk-leak',
      now: 8,
      fetch: vi.fn(async () => {
        throw new TypeError('unexpected redirect')
      }) as unknown as typeof globalThis.fetch,
    })
    expect(redirect).toEqual(failedUsage(8))

    const malformed = await readProviderUsage({
      providerId: 'deepseek',
      key: 'k',
      now: 8,
      fetch: fetchOnce({ balance_infos: 'no' }),
    })
    expect(malformed).toEqual(failedUsage(8))
  })

  it('refuses an answer larger than the bound without reading it all', async () => {
    const usage = await readProviderUsage({
      providerId: 'deepseek',
      key: 'k',
      now: 8,
      fetch: fetchOnce({ balance_infos: [], padding: 'x'.repeat(70 * 1024) }),
    })
    expect(usage).toEqual(failedUsage(8))
  })

  it('uses one generic error text', () => {
    expect(USAGE_ERROR).toBe('Usage could not be read.')
  })
})

// Huli: the vendors' documented replies, scrubbed, and where each key may go.
describe('provider balances and key limits', () => {
  const NOW = Date.parse('2026-11-21T04:30:00Z')
  const KEY = 'sk-provider-key-secret-0123456789'

  function asked(fetch: typeof globalThis.fetch): [string, RequestInit][] {
    return (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][]
  }

  it("reads an ordinary OpenRouter key's own limit from /api/v1/key, never /credits", async () => {
    const fetch = fetchOnce(openRouterKey)
    const usage = await readProviderUsage({ providerId: 'openrouter', key: KEY, now: NOW, fetch })
    expect(usage).toEqual({
      state: 'ready',
      limits: [
        {
          window: 'monthly',
          label: 'Monthly',
          usedPercent: 26.25,
          resetsAt: Date.parse('2026-12-01T00:00:00Z'),
          state: 'ok',
          observedAt: NOW,
          amount: { used: 5.25, total: 20, unit: 'USD' },
        },
      ],
      balances: [],
      observedAt: NOW,
      error: null,
    })
    const [[url, init]] = asked(fetch)
    expect(url).toBe('https://openrouter.ai/api/v1/key')
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
  })

  it('shows nothing for an OpenRouter key without a limit, and fails on another shape', () => {
    const unlimited = { data: { ...openRouterKey.data, limit: null, limit_remaining: null } }
    expect(parseOpenRouterKey(unlimited, NOW)).toEqual({
      state: 'ready',
      limits: [],
      balances: [],
      observedAt: NOW,
      error: null,
    })
    expect(parseOpenRouterKey({ data: { total_credits: 10, total_usage: 2 } }, NOW)).toBeNull()
    const noBudget = { data: { ...openRouterKey.data, limit_reset: null, budgets: [] } }
    expect(parseOpenRouterKey(noBudget, NOW)?.limits[0]).toMatchObject({
      window: 'key_limit',
      label: 'Key limit',
      resetsAt: null,
    })
  })

  it("reads SiliconFlow's balance on each site from /v1/user/info, its granted part apart", async () => {
    for (const [providerId, host, currency] of [
      ['siliconflow-cn', 'api.siliconflow.cn', 'CNY'],
      ['siliconflow', 'api.siliconflow.com', 'USD'],
    ] as const) {
      const fetch = fetchOnce(siliconFlowUser)
      const usage = await readProviderUsage({ providerId, key: KEY, now: NOW, fetch })
      expect(usage.balances).toEqual([{ label: 'Balance', amount: 88.88, currency, granted: 0.88 }])
      const [[url, init]] = asked(fetch)
      expect(url).toBe(`https://${host}/v1/user/info`)
      expect(init.redirect).toBe('error')
    }
  })

  it('tells no granted part when the SiliconFlow amounts do not add up, and refuses errors', () => {
    const odd = { ...siliconFlowUser, data: { ...siliconFlowUser.data, balance: '3.00' } }
    expect(parseSiliconFlowUser(odd, 'CNY', NOW)?.balances).toEqual([
      { label: 'Balance', amount: 88.88, currency: 'CNY' },
    ])
    expect(parseSiliconFlowUser({ code: 30001, status: false }, 'CNY', NOW)).toBeNull()
    expect(parseSiliconFlowUser({ code: 20000, status: true, data: {} }, 'CNY', NOW)).toBeNull()
  })

  it('reads the granted part of an OpenCode DeepSeek key as DeepSeek Harness does', async () => {
    const fetch = fetchOnce(deepSeekBalance)
    const usage = await readProviderUsage({ providerId: 'deepseek', key: KEY, now: NOW, fetch })
    expect(usage.balances).toEqual([
      { label: 'Balance', amount: 110, currency: 'CNY', granted: 10 },
      { label: 'Balance', amount: 5, currency: 'USD' },
    ])
    expect(asked(fetch)[0]![0]).toBe('https://api.deepseek.com/user/balance')
  })

  it("reads Z.AI's credit windows for the coding plan providers, the key sent bare", async () => {
    for (const [providerId, host] of [
      ['zai-coding-plan', 'api.z.ai'],
      ['zhipuai-coding-plan', 'open.bigmodel.cn'],
    ] as const) {
      const fetch = fetchOnce(zaiQuota)
      const usage = await readProviderUsage({ providerId, key: KEY, now: NOW, fetch })
      expect(usage.limits.map((limit) => limit.window)).toEqual([
        'five_hour',
        'seven_day',
        'tool_calls',
      ])
      const [[url, init]] = asked(fetch)
      expect(url).toBe(`https://${host}/api/monitor/usage/quota/limit`)
      expect((init.headers as Record<string, string>).authorization).toBe(KEY)
      expect(init.redirect).toBe('error')
    }
  })

  it('never puts a key into a result, whatever the vendor answers', async () => {
    for (const providerId of ['openrouter', 'siliconflow', 'siliconflow-cn', 'deepseek', 'zai']) {
      for (const body of [{ error: { message: `bad key ${KEY}` } }, { data: { label: KEY } }]) {
        for (const status of [200, 401, 500]) {
          const usage = await readProviderUsage({
            providerId,
            key: KEY,
            now: NOW,
            fetch: fetchOnce(body, status),
          })
          expect(JSON.stringify(usage)).not.toContain(KEY)
        }
      }
    }
  })
})
