// DeepSeek Harness's sign-in as the host reads it from the home's files, without starting dsh, and
// where the stored token or key may go when the balance is read.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import summary from '../vendor-usage/fixtures/deepseek-user-summary.json'
import profile from '../vendor-usage/fixtures/deepseek-users-current.json'
import keyBalance from '../vendor-usage/fixtures/deepseek-user-balance.json'
import {
  DshAccounts,
  knownProfile,
  reportedRoute,
  routeAccount,
  type DshReadInput,
} from './account'

const TOKEN = 'account-token-secret-0123456789abcdef'
const KEY = 'sk-key-secret-0123456789abcdef'

let base: string
let home: string
let now: number
let logged: string[]
let accounts: DshAccounts

const file = () => path.join(home, '.credentials.yaml')

function grantFile(token: string, issuer = 'https://platform.deepseek.com'): string {
  return [
    'version: 1',
    'records:',
    '  deepseek-account-platform/default:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      token: ${token}`,
    `      issuer: ${issuer}`,
    '',
  ].join('\n')
}

const keyFile = (key: string) => `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${key}\n`

function answering() {
  return vi.fn(async (url: string) => {
    const body = url.endsWith('/get_user_summary')
      ? summary
      : url.endsWith('/users/current')
        ? profile
        : url === 'https://api.deepseek.com/user/balance'
          ? keyBalance
          : { unexpected: true }
    return new Response(JSON.stringify(body), { status: 200 })
  })
}

let fetch = answering()

function input(over: Partial<DshReadInput> = {}): DshReadInput {
  return {
    env: { DSH_HOME: home },
    home,
    version: '0.2.2-rc.5',
    reason: 'due',
    account: null,
    balance: null,
    ...over,
  }
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'kite-dsh-account-'))
  home = path.join(base, '.dsh')
  await mkdir(home, { recursive: true })
  now = Date.parse('2026-11-21T04:30:00Z')
  logged = []
  fetch = answering()
  accounts = new DshAccounts({
    log: (_level, message) => logged.push(message),
    dueMs: 60_000,
    platform: process.platform === 'win32' ? 'win32' : 'linux',
    now: () => now,
    fetch: fetch as unknown as typeof globalThis.fetch,
    watchDelayMs: 50,
  })
})

afterEach(async () => {
  accounts.close()
  await rm(base, { recursive: true, force: true })
})

function urls(): string[] {
  return (fetch.mock.calls as unknown as [string][]).map(([url]) => url)
}

describe('the sign-in a running DeepSeek Harness reports', () => {
  const deepseek = [{ provider: 'deepseek-official' }, { provider: 'deepseek-account' }]
  const none = { groups: [] }

  it('goes by the DeepSeek sign-in first', () => {
    for (const signedIn of ['deepseek-account', 'deepseek-official'] as const) {
      expect(reportedRoute({ signedIn, listed: [], routes: none, settled: false })).toBe(signedIn)
    }
  })

  it('takes DeepSeek’s own routes, which dsh lists signed out too, for no sign-in', () => {
    expect(reportedRoute({ signedIn: null, listed: deepseek, routes: none, settled: true })).toBe(
      'none',
    )
    expect(
      reportedRoute({ signedIn: null, listed: deepseek, routes: none, settled: false }),
    ).toBeNull()
  })

  it('counts another provider’s route, listed or configured, as one the user signed in to', () => {
    const listed = [...deepseek, { provider: 'my-gateway' }]
    expect(reportedRoute({ signedIn: null, listed, routes: none, settled: true })).toBe('gateway')
    const routes = { groups: [{ provider: 'my-gateway', name: 'Mine', effort: null, models: [] }] }
    expect(reportedRoute({ signedIn: null, listed: [], routes, settled: false })).toBe('gateway')
  })
})

describe('DeepSeek Harness sign-in from its files', () => {
  it('names the account sign-in by the contact DeepSeek masks, with its balance', async () => {
    await writeFile(file(), grantFile(TOKEN))
    const read = await accounts.read('deepseek', input())
    expect(read.account).toEqual({
      kind: 'external',
      label: 'DeepSeek account',
      email: '138****0000',
    })
    expect(read.balance).toMatchObject({
      state: 'ready',
      balances: [{ label: 'Balance', amount: 18.34, currency: 'CNY', granted: 6 }],
    })
    expect(urls()).toEqual([
      'https://platform.deepseek.com/api/v0/users/get_user_summary',
      'https://platform.deepseek.com/auth-api/v0/users/current',
    ])
    expect(knownProfile(home)).toEqual({ name: 'Kite Tester', contact: '138****0000' })
    // The profile is asked once per sign-in; the balance again once it is due.
    now += 61_000
    await accounts.read('deepseek', input())
    expect(urls()).toHaveLength(3)
    expect(JSON.stringify(read)).not.toContain(TOKEN)
  })

  it('names an API key, whose balance comes from DeepSeek’s API alone', async () => {
    await writeFile(file(), keyFile(KEY))
    const read = await accounts.read('deepseek', input())
    expect(read.account).toEqual(routeAccount('deepseek-official', null))
    expect(read.account?.kind).toBe('api_key')
    expect(read.balance?.balances.map((b) => [b.currency, b.amount])).toEqual([
      ['CNY', 110],
      ['USD', 5],
    ])
    expect(urls()).toEqual(['https://api.deepseek.com/user/balance'])
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
  })

  it('reads the files alone at a start and after a change, and DeepSeek for a new sign-in', async () => {
    const read = await accounts.read('deepseek', input({ reason: 'files' }))
    expect(read).toEqual({ account: routeAccount('none', null), balance: null })
    await writeFile(file(), grantFile(TOKEN))
    // A sign-in made in dsh's page: the files say so, and its balance is read at once.
    const signedIn = await accounts.read('deepseek', input({ reason: 'files' }))
    expect(signedIn.account?.kind).toBe('external')
    expect(signedIn.balance?.state).toBe('ready')
    expect(urls()).toHaveLength(2)
    // The same sign-in again, as when dsh rewrote another record: no request.
    expect(await accounts.read('deepseek', input({ reason: 'files' }))).toEqual({
      account: routeAccount('deepseek-account', knownProfile(home)),
    })
    expect(await accounts.read('deepseek', input({ reason: 'due' }))).not.toHaveProperty('balance')
    expect(urls()).toHaveLength(2)
  })

  it('reads nothing from DeepSeek at a start that finds a sign-in already there', async () => {
    await writeFile(file(), grantFile(TOKEN))
    const read = await accounts.read('deepseek', input({ reason: 'files' }))
    expect(read.account?.kind).toBe('external')
    expect(read).not.toHaveProperty('balance')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks again when forced only after a short while', async () => {
    await writeFile(file(), grantFile(TOKEN))
    await accounts.read('deepseek', input())
    await accounts.read('deepseek', input({ reason: 'forced' }))
    expect(urls()).toHaveLength(2)
    now += 11_000
    await accounts.read('deepseek', input({ reason: 'forced' }))
    expect(urls()).toHaveLength(3)
  })

  it('signs the agent out when its credential went, unless another route remains', async () => {
    const before = routeAccount('deepseek-account', null)
    const none = { kind: 'none', label: '', email: null }
    expect((await accounts.read('deepseek', input({ account: before }))).account).toEqual(none)
    expect((await accounts.read('deepseek', input({ account: null }))).account).toEqual(none)
    // A route only dsh's own list showed is the agent's to tell.
    const gateway = routeAccount('gateway', null)
    expect((await accounts.read('deepseek', input({ account: gateway }))).account).toBeNull()
    const sdk = path.join(home, 'profiles', 'sdk')
    await mkdir(sdk, { recursive: true })
    await writeFile(
      path.join(sdk, 'cordis.patch.yml'),
      [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      other:',
        '        models:',
        '          - id: m1',
        '',
      ].join('\n'),
    )
    expect((await accounts.read('deepseek', input({ account: before }))).account?.kind).toBe(
      'gateway',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the balance last read when a read fails, and logs nothing of the token', async () => {
    await writeFile(file(), grantFile(TOKEN))
    const first = await accounts.read('deepseek', input())
    fetch.mockImplementation(async () => new Response(`{"code":40003,"msg":"${TOKEN}"}`))
    now += 61_000
    const failed = await accounts.read('deepseek', input({ balance: first.balance ?? null }))
    expect(failed.balance).toMatchObject({
      state: 'error',
      balances: first.balance?.balances,
      observedAt: first.balance?.observedAt,
      error: 'DeepSeek no longer accepts this sign-in. Sign in again.',
    })
    fetch.mockImplementation(async () => {
      throw new TypeError(`connect failed with ${TOKEN}`)
    })
    now += 61_000
    await accounts.read('deepseek', input({ balance: failed.balance ?? null }))
    expect(logged.length).toBeGreaterThan(0)
    for (const line of logged) expect(line).not.toContain(TOKEN)
    expect(JSON.stringify(failed)).not.toContain(TOKEN)
  })

  it('sends a grant some other Platform issued nowhere', async () => {
    await writeFile(file(), grantFile(TOKEN, 'https://example.invalid'))
    const read = await accounts.read('deepseek', input())
    expect(read.account?.kind).toBe('external')
    expect(read.balance?.state).toBe('error')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads again when the credential file changes', async () => {
    const changed = vi.fn()
    accounts.watch('deepseek', home, changed)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await writeFile(file(), grantFile(TOKEN))
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 })
  })

  it('watches for a home dsh has not made yet', async () => {
    await rm(home, { recursive: true, force: true })
    const changed = vi.fn()
    accounts.watch('deepseek', home, changed)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await mkdir(home)
    await writeFile(file(), grantFile(TOKEN))
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 })
  })
})
