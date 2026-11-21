// Huli: the API provider profiles the agent host holds: what a client sees of them, what a session
// is handed, and where a profile's key may go to read its balance.

import { describe, expect, it, vi } from 'vitest'
import { claudeProfileEnv, presetOf, type StoredProfile } from '@shared/provider-profiles'
import { ProviderProfiles } from './provider-profiles'

const KEY = 'sk-profile-SECRET-0123456789abcd'

const deepseek: StoredProfile = {
  id: 'p-deepseek',
  name: 'DeepSeek',
  preset: 'deepseek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-flash[1m]',
  fastModel: 'deepseek-flash',
  key: KEY,
}

const kimi: StoredProfile = {
  id: 'p-kimi',
  name: 'Kimi',
  preset: 'kimi',
  baseUrl: 'https://api.moonshot.cn/anthropic',
  key: 'sk-kimi-SECRET-0123456789',
}

function replies(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

function calls(fetch: ReturnType<typeof replies>): [string, RequestInit][] {
  return fetch.mock.calls as unknown as [string, RequestInit][]
}

describe('the profiles the agent host holds', () => {
  it('shows a client each profile without its key, but the key’s last four characters', () => {
    const profiles = new ProviderProfiles()
    profiles.set({ 'claude-code': { items: [deepseek], defaultId: deepseek.id } })
    const view = profiles.view('claude-code')
    expect(view).toEqual({
      defaultId: deepseek.id,
      items: [
        {
          id: deepseek.id,
          name: 'DeepSeek',
          preset: 'deepseek',
          baseUrl: deepseek.baseUrl,
          model: 'deepseek-flash[1m]',
          fastModel: 'deepseek-flash',
          keyEnd: 'abcd',
        },
      ],
    })
    expect(JSON.stringify(view)).not.toContain('SECRET')
    expect(profiles.view('codex')).toBeNull()
  })

  it('keeps no profile that is not whole, and none for an agent that takes none', () => {
    const profiles = new ProviderProfiles()
    const changed = profiles.set({
      'claude-code': {
        items: [
          { ...deepseek, baseUrl: 'javascript:alert(1)' },
          { ...kimi, key: 'two words' },
          { ...kimi, id: 'p-ok' },
        ],
        defaultId: 'p-gone',
      },
      codex: { items: [deepseek], defaultId: null },
    })
    expect(changed).toEqual([{ agentId: 'claude-code', profileIds: [] }])
    expect(profiles.view('claude-code')?.items.map((p) => p.id)).toEqual(['p-ok'])
    expect(profiles.defaultOf('claude-code')).toBeNull()
    expect(profiles.set(undefined)).toEqual([{ agentId: 'claude-code', profileIds: ['p-ok'] }])
    expect(profiles.get('claude-code', 'p-ok')).toBeNull()
  })

  it('hands a session the address and models in plain variables, and the key apart', () => {
    const { plain, secret } = claudeProfileEnv(deepseek)
    expect(JSON.stringify(plain)).not.toContain('SECRET')
    expect(secret).toEqual({ ANTHROPIC_AUTH_TOKEN: KEY })
    expect(plain).toMatchObject({
      ANTHROPIC_BASE_URL: deepseek.baseUrl,
      ANTHROPIC_AUTH_TOKEN: '',
      // The agent's own settings cannot send their key or headers to the profile's provider.
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_CUSTOM_HEADERS: '',
      CLAUDE_CODE_USE_BEDROCK: '',
      ANTHROPIC_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
      ...presetOf('deepseek')!.env,
    })
    // A custom profile without a model asks none of the agent's own.
    const custom = claudeProfileEnv({
      id: 'c',
      name: 'Gateway',
      preset: 'custom',
      baseUrl: 'https://llm.example.com',
      key: KEY,
    })
    expect(custom.plain.ANTHROPIC_MODEL).toBe('')
    expect(custom.plain.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('')
  })
})

describe('the balances of the profiles’ keys', () => {
  it('reads DeepSeek’s documented balance with the key, at its own origin only', async () => {
    const fetch = replies({
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '12.50',
          granted_balance: '2.00',
          topped_up_balance: '10.50',
        },
      ],
    })
    const profiles = new ProviderProfiles({ now: () => 1_000, fetch: fetch as never })
    profiles.set({ 'claude-code': { items: [deepseek], defaultId: null } })
    expect(await profiles.readBalances('claude-code', false)).toBe(true)
    expect(calls(fetch).map(([url]) => url)).toEqual(['https://api.deepseek.com/user/balance'])
    expect(new Headers(calls(fetch)[0]![1].headers).get('authorization')).toBe(`Bearer ${KEY}`)
    expect(profiles.balancesOf('claude-code')).toEqual([
      {
        profileId: deepseek.id,
        balances: [{ label: 'Balance', amount: 12.5, currency: 'CNY', granted: 2 }],
        observedAt: 1_000,
        error: null,
      },
    ])
    // Within the minute a look reads nothing again; the user's refresh does.
    expect(await profiles.readBalances('claude-code', false)).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    await profiles.readBalances('claude-code', true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reads Moonshot’s documented balance on the site of the profile’s preset', async () => {
    const fetch = replies({
      code: 0,
      data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
      scode: '0x0',
      status: true,
    })
    const profiles = new ProviderProfiles({ now: () => 5, fetch: fetch as never })
    profiles.set({ 'claude-code': { items: [kimi], defaultId: null } })
    await profiles.readBalances('claude-code', true)
    expect(calls(fetch)[0]![0]).toBe('https://api.moonshot.cn/v1/users/me/balance')
    expect(profiles.balancesOf('claude-code')[0]?.balances).toEqual([
      { label: 'Balance', amount: 49.59, currency: 'CNY', granted: 46.59 },
    ])
  })

  it('sends no key for a profile that left its preset’s address, or has no balance API', async () => {
    const fetch = replies({})
    const profiles = new ProviderProfiles({ now: () => 5, fetch: fetch as never })
    profiles.set({
      'claude-code': {
        items: [
          { ...deepseek, baseUrl: 'https://proxy.example.com/anthropic' },
          {
            ...kimi,
            id: 'glm',
            preset: 'zhipu',
            baseUrl: 'https://open.bigmodel.cn/api/anthropic',
          },
        ],
        defaultId: null,
      },
    })
    expect(await profiles.readBalances('claude-code', true)).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('says a read failed without the key, and forgets a balance once the key changes', async () => {
    const ok = replies({ balance_infos: [{ currency: 'CNY', total_balance: '1' }] })
    const profiles = new ProviderProfiles({ now: () => 5, fetch: ok as never })
    profiles.set({ 'claude-code': { items: [deepseek], defaultId: null } })
    await profiles.readBalances('claude-code', true)
    const refused = new ProviderProfiles({
      now: () => 9,
      fetch: replies({ error: KEY }, 401) as never,
    })
    refused.set({ 'claude-code': { items: [deepseek], defaultId: null } })
    await refused.readBalances('claude-code', true)
    const failed = refused.balancesOf('claude-code')[0]!
    expect(failed.error).toBeTruthy()
    expect(JSON.stringify(failed)).not.toContain('SECRET')
    profiles.set({
      'claude-code': { items: [{ ...deepseek, key: 'sk-new-0123456789' }], defaultId: null },
    })
    expect(profiles.balancesOf('claude-code')).toEqual([])
  })
})
