// DeepSeek's balance on dsh's two routes: the replies, scrubbed from real ones (the public
// `/user/balance` as DeepSeek documents it), and where the credential may go.

import { describe, expect, it, vi } from 'vitest'
import {
  parseDeepSeekKeyBalance,
  parseDeepSeekProfile,
  parseDeepSeekWallets,
  readDeepSeekAccount,
  readDeepSeekKeyBalance,
} from './deepseek'
import keyBalance from './fixtures/deepseek-user-balance.json'
import profile from './fixtures/deepseek-users-current.json'
import summary from './fixtures/deepseek-user-summary.json'
import { UsageReadError, type SignInPlace } from './stored-sign-in'

const TOKEN = 'dsh-account-token-secret-0123456789'
const KEY = 'sk-deepseek-key-secret-0123456789'
const GRANT = { token: TOKEN, issuer: 'https://platform.deepseek.com' }
const OPTIONS = { profile: true, version: '0.2.2-rc.5', locale: 'zh-CN' }

function replies(...bodies: { body: unknown; status?: number }[]) {
  const queue = [...bodies]
  return vi.fn(async () => {
    const next = queue.shift() ?? { body: {} }
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 })
  })
}

function place(fetch: ReturnType<typeof replies>): SignInPlace {
  return {
    env: {},
    home: '/nowhere',
    platform: 'linux',
    now: Date.parse('2026-11-21T04:30:00Z'),
    fetch: fetch as unknown as typeof globalThis.fetch,
  }
}

function calls(fetch: ReturnType<typeof replies>): [string, RequestInit][] {
  return fetch.mock.calls as unknown as [string, RequestInit][]
}

describe('DeepSeek balance replies', () => {
  it('reads the account wallets as one balance per currency, the bonus as granted', () => {
    expect(parseDeepSeekWallets(summary)).toEqual([
      { label: 'Balance', amount: 18.34, currency: 'CNY', granted: 6 },
    ])
  })

  it('reads the decimal forms Platform sends, an empty paid wallet among them', () => {
    const reply = {
      code: 0,
      data: {
        biz_code: 0,
        biz_data: {
          normal_wallets: [{ currency: 'CNY', balance: '0E-16' }],
          bonus_wallets: [
            { currency: 'CNY', balance: '6.0000000000000000' },
            { currency: 'USD', balance: '.5' },
            { currency: 'EUR', balance: 'lots' },
          ],
        },
      },
    }
    expect(parseDeepSeekWallets(reply)).toEqual([
      { label: 'Balance', amount: 6, currency: 'CNY', granted: 6 },
      { label: 'Balance', amount: 0.5, currency: 'USD', granted: 0.5 },
    ])
  })

  it('reads the public key balance, its granted part apart', () => {
    expect(parseDeepSeekKeyBalance(keyBalance)).toEqual([
      { label: 'Balance', amount: 110, currency: 'CNY', granted: 10 },
      { label: 'Balance', amount: 5, currency: 'USD' },
    ])
    expect(parseDeepSeekKeyBalance({ is_available: false })).toBeNull()
  })

  it('takes the masked contact and the name from the profile, and nothing else of it', () => {
    const read = parseDeepSeekProfile(profile)
    expect(read).toEqual({ name: 'Kite Tester', contact: '138****0000' })
    expect(JSON.stringify(read)).not.toContain('scrubbed-session-token')
  })

  it('tells a refused token in the envelope from an answer it cannot read', () => {
    const refused = (() => {
      try {
        parseDeepSeekWallets({ code: 40003, msg: 'token invalid' })
      } catch (error) {
        return error
      }
      return null
    })()
    expect(refused).toBeInstanceOf(UsageReadError)
    expect((refused as UsageReadError).status).toBe(401)
    expect(() => parseDeepSeekWallets({ code: 0, data: { biz_code: 7 } })).toThrow(UsageReadError)
  })
})

describe('reading the DeepSeek account balance', () => {
  it('sends the grant only to DeepSeek Platform, as dsh does, and returns none of it', async () => {
    const fetch = replies({ body: summary }, { body: profile })
    const read = await readDeepSeekAccount(place(fetch), GRANT, OPTIONS)
    expect(read.balances).toEqual([
      { label: 'Balance', amount: 18.34, currency: 'CNY', granted: 6 },
    ])
    expect(read.profile).toEqual({ name: 'Kite Tester', contact: '138****0000' })
    expect(calls(fetch).map(([url]) => url)).toEqual([
      'https://platform.deepseek.com/api/v0/users/get_user_summary',
      'https://platform.deepseek.com/auth-api/v0/users/current',
    ])
    for (const [, init] of calls(fetch)) {
      const headers = init.headers as Record<string, string>
      expect(headers['x-dsh-auth-token']).toBe(TOKEN)
      expect(headers.authorization).toBeUndefined()
      expect(headers['x-client-locale']).toBe('zh_CN')
      expect(headers['x-client-version']).toBe('0.2.2-rc.5')
      expect(init.redirect).toBe('error')
      expect(init.method).toBe('GET')
    }
    expect(JSON.stringify(read)).not.toContain(TOKEN)
  })

  it('asks for the profile only when told to', async () => {
    const fetch = replies({ body: summary })
    const read = await readDeepSeekAccount(place(fetch), GRANT, { ...OPTIONS, profile: false })
    expect(read.profile).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('never sends a grant another Platform issued, or dsh’s mock one', async () => {
    const fetch = replies({ body: summary })
    for (const grant of [
      { token: TOKEN, issuer: 'https://platform.deepseek.com.evil.example' },
      { token: TOKEN, issuer: 'http://127.0.0.1:4000' },
      { token: 'dsh_mock_abc', issuer: 'https://platform.deepseek.com' },
    ]) {
      await expect(readDeepSeekAccount(place(fetch), grant, OPTIONS)).rejects.toThrow(
        UsageReadError,
      )
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails on a refused token without quoting the token or the answer', async () => {
    for (const fetch of [
      replies({ body: { code: 40003, msg: `bad ${TOKEN}` } }),
      replies({ body: { error: `bad ${TOKEN}` }, status: 401 }),
      replies({ body: { error: `bad ${TOKEN}` }, status: 500 }),
    ]) {
      const error = await readDeepSeekAccount(place(fetch), GRANT, OPTIONS).catch(
        (caught: unknown) => caught,
      )
      expect(error).toBeInstanceOf(UsageReadError)
      expect(String((error as Error).message)).not.toContain(TOKEN)
      expect(JSON.stringify(error)).not.toContain(TOKEN)
    }
  })

  it('keeps the balance when only the profile fails', async () => {
    const fetch = replies({ body: summary }, { body: {}, status: 502 })
    const read = await readDeepSeekAccount(place(fetch), GRANT, OPTIONS)
    expect(read.balances).toHaveLength(1)
    expect(read.profile).toBeNull()
  })
})

describe('reading an API key balance', () => {
  it('sends the key only to DeepSeek’s balance endpoint', async () => {
    const fetch = replies({ body: { ...keyBalance, echo: KEY } })
    const balances = await readDeepSeekKeyBalance(place(fetch), KEY)
    expect(balances).toHaveLength(2)
    const [[url, init]] = calls(fetch) as [[string, RequestInit]]
    expect(url).toBe('https://api.deepseek.com/user/balance')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    expect((init.headers as Record<string, string>)['x-dsh-auth-token']).toBeUndefined()
    expect(init.redirect).toBe('error')
    expect(JSON.stringify(balances)).not.toContain(KEY)
  })

  it('fails on a refused key without quoting it', async () => {
    const error = await readDeepSeekKeyBalance(
      place(replies({ body: { error: { message: `bad key ${KEY}` } }, status: 401 })),
      KEY,
    ).catch((caught: unknown) => caught)
    expect((error as UsageReadError).status).toBe(401)
    expect(JSON.stringify(error)).not.toContain(KEY)
    expect((error as Error).message).not.toContain(KEY)
  })
})
