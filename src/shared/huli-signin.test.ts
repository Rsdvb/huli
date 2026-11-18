import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AccountNetworkError, AccountServiceError, type TokenSet } from './account-api'
import { MOBILE_CLIENT, MOBILE_REDIRECT } from './huli-cloud'
import { CloudSession, redirectQuery, type CloudSessionEnv } from './huli-signin'
import { encodeRelayBytes } from './remote/relay'

const BASE = 'https://cloud.test'
const ME = {
  account: { id: 'acct', email: 'me@example.com', name: 'Me', avatarUrl: null },
  subscription: 'active',
  plan: null,
  usage: null,
  points: null,
}

function setup(now = { t: 1_000_000 }) {
  let vault: string | null = null
  const writes: string[] = []
  let issued = 0
  const tokens = (): TokenSet => {
    issued++
    return {
      accessToken: `access-${issued}`,
      refreshToken: `refresh-${issued}`,
      accessExpiresAt: now.t + 60_000,
    }
  }
  const api = {
    base: BASE,
    exchangeCode: vi.fn<(input: { code: string; verifier: string }) => Promise<TokenSet>>(
      async () => tokens(),
    ),
    refresh: vi.fn<(client: string, token: string) => Promise<TokenSet>>(async () => tokens()),
    revoke: vi.fn<(client: string, token: string) => Promise<void>>(async () => {}),
    me: vi.fn(async () => ME),
    relayToken: vi.fn(async (token: string) => ({
      token: `relay-for-${token}`,
      expiresAt: now.t + 60 * 60_000,
    })),
  }
  let answer: (url: string) => string | null = () => null
  const opened: string[] = []
  const env: CloudSessionEnv = {
    api,
    vault: {
      read: async () => vault,
      write: async (text) => {
        vault = text
        writes.push(text)
      },
      clear: async () => {
        vault = null
      },
    },
    authenticate: async (url, redirect) => {
      expect(redirect).toBe(MOBILE_REDIRECT)
      opened.push(url)
      return answer(url)
    },
    random: (bytes) => Uint8Array.from({ length: bytes }, (_, i) => (i * 13 + issued) & 0xff),
    sha256: async (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest()),
    info: { name: 'iPhone', os: 'iOS 26', arch: 'arm64', version: '0.1.0' },
    now: () => now.t,
  }
  const session = new CloudSession(env)
  /** Answers the sign-in page as the cloud would: back to the app with a code and the state. */
  const approve = () => {
    answer = (url) => {
      const state = new URL(url).searchParams.get('state')!
      return `${MOBILE_REDIRECT}?code=the-code&state=${encodeURIComponent(state)}`
    }
  }
  return {
    session,
    api,
    env,
    opened,
    writes,
    vault: () => vault,
    setVault: (text: string | null) => (vault = text),
    answer: (next: (url: string) => string | null) => (answer = next),
    approve,
    now,
  }
}

describe("the phone's Huli Cloud sign-in", () => {
  it('signs in with PKCE as the phone, and keeps the refresh token alone', async () => {
    const t = setup()
    t.approve()
    expect(await t.session.signIn()).toBe('signed-in')
    const url = new URL(t.opened[0]!)
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/signin/app/`)
    expect(url.searchParams.get('client_id')).toBe(MOBILE_CLIENT)
    expect(url.searchParams.get('redirect_uri')).toBe(MOBILE_REDIRECT)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(JSON.parse(url.searchParams.get('client_info')!)).toMatchObject({
      kind: 'mobile',
      name: 'iPhone',
    })
    const { verifier } = t.api.exchangeCode.mock.calls[0]![0]
    const challenge = encodeRelayBytes(
      new Uint8Array(createHash('sha256').update(verifier).digest()),
    )
    expect(url.searchParams.get('code_challenge')).toBe(challenge)
    expect(t.session.status()).toEqual({
      state: 'signed-in',
      account: { id: 'acct', email: 'me@example.com', name: 'Me' },
    })
    // The access token stays in memory; the vault has the refresh token and the account.
    expect(JSON.parse(t.vault()!)).toEqual({
      v: 1,
      refreshToken: 'refresh-1',
      account: { id: 'acct', email: 'me@example.com', name: 'Me' },
    })
    expect(t.vault()).not.toContain('access-1')
    expect(await t.session.accessToken()).toBe('access-1')
  })

  it('takes no code back with another state, or at another address', async () => {
    const t = setup()
    t.answer(() => `${MOBILE_REDIRECT}?code=the-code&state=someone-elses`)
    expect(await t.session.signIn()).toBe('failed')
    t.answer((url) => {
      const state = new URL(url).searchParams.get('state')!
      return `huli://elsewhere?code=the-code&state=${state}`
    })
    expect(await t.session.signIn()).toBe('failed')
    expect(t.api.exchangeCode).not.toHaveBeenCalled()
    expect(t.vault()).toBeNull()
    expect(t.session.status()).toEqual({ state: 'signed-out', reason: null })
  })

  it('keeps nothing when the sign-in is closed or refused', async () => {
    const t = setup()
    expect(await t.session.signIn()).toBe('cancelled')
    t.answer((url) => {
      const state = new URL(url).searchParams.get('state')!
      return `${MOBILE_REDIRECT}?error=access_denied&state=${state}`
    })
    expect(await t.session.signIn()).toBe('denied')
    expect(t.vault()).toBeNull()
  })

  it('ends a sign-in it could not finish rather than leave it at the cloud', async () => {
    const t = setup()
    t.approve()
    t.api.me.mockRejectedValueOnce(new AccountNetworkError('offline'))
    expect(await t.session.signIn()).toBe('network')
    expect(t.api.revoke).toHaveBeenCalledWith(MOBILE_CLIENT, 'refresh-1')
    expect(t.vault()).toBeNull()
  })

  it('refreshes once for callers at the same time, and keeps the new token first', async () => {
    const t = setup()
    t.approve()
    await t.session.signIn()
    t.now.t += 120_000
    const [a, b, c] = await Promise.all([
      t.session.accessToken(),
      t.session.accessToken(),
      t.session.relayToken(),
    ])
    expect(t.api.refresh).toHaveBeenCalledTimes(1)
    expect(t.api.refresh).toHaveBeenCalledWith(MOBILE_CLIENT, 'refresh-1')
    expect([a, b]).toEqual(['access-2', 'access-2'])
    expect(c).toBe('relay-for-access-2')
    expect(JSON.parse(t.vault()!).refreshToken).toBe('refresh-2')
    // A relay token is kept until shortly before it lapses.
    expect(await t.session.relayToken()).toBe('relay-for-access-2')
    expect(t.api.relayToken).toHaveBeenCalledTimes(1)
  })

  it('signs out here when the cloud ended the sign-in, and not when it is only away', async () => {
    const t = setup()
    t.approve()
    await t.session.signIn()
    t.now.t += 120_000
    t.api.refresh.mockRejectedValueOnce(new AccountNetworkError('offline'))
    expect(await t.session.accessToken()).toBeNull()
    expect(t.session.status().state).toBe('signed-in')
    t.api.refresh.mockRejectedValueOnce(new AccountServiceError('invalid_grant', 'no', 400))
    expect(await t.session.accessToken()).toBeNull()
    expect(t.session.status()).toEqual({ state: 'signed-out', reason: 'revoked' })
    expect(t.vault()).toBeNull()
  })

  it('refreshes once more when the cloud refuses an access token', async () => {
    const t = setup()
    t.approve()
    await t.session.signIn()
    const call = vi.fn(async (token: string) => {
      if (token === 'access-1') throw new AccountServiceError('unauthorized', 'no', 401)
      return token
    })
    expect(await t.session.withAccess(call)).toBe('access-2')
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('forgets the sign-in on sign out even when the cloud cannot be reached', async () => {
    const t = setup()
    t.approve()
    await t.session.signIn()
    t.api.revoke.mockRejectedValueOnce(new AccountNetworkError('offline'))
    await t.session.signOut()
    expect(t.api.revoke).toHaveBeenCalledWith(MOBILE_CLIENT, 'refresh-1')
    expect(t.vault()).toBeNull()
    expect(t.session.status()).toEqual({ state: 'signed-out', reason: null })
    expect(await t.session.accessToken()).toBeNull()
    expect(await t.session.relayToken()).toBeNull()
  })

  it('reads a kept sign-in, and clears one it cannot read', async () => {
    const t = setup()
    t.setVault(
      JSON.stringify({
        v: 1,
        refreshToken: 'kept',
        account: { id: 'acct', email: 'me@example.com', name: null },
      }),
    )
    expect((await t.session.load()).state).toBe('signed-in')
    expect(await t.session.accessToken()).toBe('access-1')
    expect(t.api.refresh).toHaveBeenCalledWith(MOBILE_CLIENT, 'kept')
    const u = setup()
    u.setVault('{"v":1,"refreshToken":7}')
    expect((await u.session.load()).state).toBe('signed-out')
    expect(u.vault()).toBeNull()
  })

  it("reads the redirect's query without a URL parser for its scheme", () => {
    expect(redirectQuery('huli://signin?code=a%2Bb&state=x+y', MOBILE_REDIRECT)).toEqual(
      new Map([
        ['code', 'a+b'],
        ['state', 'x y'],
      ]),
    )
    expect(redirectQuery('huli://signinx?code=a', MOBILE_REDIRECT)).toBeNull()
    expect(redirectQuery('huli://signin?code=%E0%A4%A', MOBILE_REDIRECT)).toBeNull()
  })
})
