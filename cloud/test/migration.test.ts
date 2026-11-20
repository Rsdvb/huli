// The single-account file (v1) as the deployed service wrote it becomes v2 once, losslessly: its
// account the owner's, every sign-in, token and computer of it kept, so nothing signs in again; a
// copy of the file as it was is kept beside, once. A v2 file whose accounts have no two-step
// verification, the fields of it null or missing altogether, is read as it is, with no new
// version: those accounts sign in with a password alone, and the owner still with its code.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AccountApi, DESKTOP_CLIENT } from '@shared/account-api'
import { HuliCloudApi, MOBILE_CLIENT } from '@shared/huli-cloud'
import { listAccounts } from '../src/admin'
import {
  base32Decode,
  hashPassword,
  hotp,
  newTotpSecret,
  pkceChallenge,
  randomToken,
  sha256Hex,
  TOTP_PERIOD_S,
} from '../src/secrets'
import { makeServer } from '../src/server'
import { Store } from '../src/store'
import { signInSteps } from './accounts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const PASSWORD = 'correct horse battery staple'
const SIGN_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc'

/** A state.json as the single-account service wrote it, and the tokens its clients hold. */
async function v1State(totp: string) {
  const tokens = {
    desktopAccess: randomToken(),
    desktopRefresh: randomToken(),
    phoneAccess: randomToken(),
    phoneRefresh: randomToken(),
    oldRefresh: randomToken(),
    replacedAccess: randomToken(),
  }
  const family = (id: string, clientId: string, refresh: string, account?: string) => ({
    id,
    ...(account === undefined ? {} : { account }),
    clientId,
    info: { kind: 'desktop', name: 'Studio', os: 'win32', arch: 'x64', version: '1' },
    createdAt: NOW - 20 * DAY,
    lastUsedAt: NOW - DAY,
    refresh: sha256Hex(refresh),
    refreshExpiresAt: NOW + 20 * DAY,
    previous: [sha256Hex(tokens.oldRefresh)],
  })
  const state = {
    v: 1,
    account: {
      id: 'b6f4c5d2-0d1e-4c4b-9a77-2f1f0b0c9e11',
      email: 'me@example.com',
      name: 'Me',
      password: await hashPassword(PASSWORD),
      totp,
      totpLastStep: Math.floor(NOW / 1000 / TOTP_PERIOD_S) - 100,
      recovery: [sha256Hex('aaaaa-bbbbb')],
    },
    families: [
      // From before families named their account.
      family('famDesktop', DESKTOP_CLIENT, tokens.desktopRefresh),
      family(
        'famPhone',
        MOBILE_CLIENT,
        tokens.phoneRefresh,
        'b6f4c5d2-0d1e-4c4b-9a77-2f1f0b0c9e11',
      ),
      // Of an account `init --force` replaced: never taken, and dropped now.
      family('famReplaced', DESKTOP_CLIENT, randomToken(), 'a-replaced-account'),
    ],
    access: [
      { hash: sha256Hex(tokens.desktopAccess), family: 'famDesktop', expiresAt: NOW + 30 * 60_000 },
      { hash: sha256Hex(tokens.phoneAccess), family: 'famPhone', expiresAt: NOW + 30 * 60_000 },
      {
        hash: sha256Hex(tokens.replacedAccess),
        family: 'famReplaced',
        expiresAt: NOW + 30 * 60_000,
      },
    ],
    computers: [
      {
        id: 'abcdefghijklmnopqrstuvwxyz',
        account: 'b6f4c5d2-0d1e-4c4b-9a77-2f1f0b0c9e11',
        family: 'famDesktop',
        signKey: SIGN_KEY,
        key: null,
        name: 'Studio',
        platform: 'win32',
        pairable: true,
        firstSeen: NOW - 20 * DAY,
        lastSeen: NOW - DAY,
      },
      {
        id: 'zyxwvutsrqponmlkjihgfedcba',
        account: 'a-replaced-account',
        family: 'famReplaced',
        signKey: SIGN_KEY,
        key: null,
        name: 'Old',
        platform: 'linux',
        pairable: false,
        firstSeen: NOW - 20 * DAY,
        lastSeen: NOW - DAY,
      },
    ],
  }
  return { state, tokens }
}

async function migrated() {
  const dir = mkdtempSync(path.join(tmpdir(), 'huli-migration-'))
  dirs.push(dir)
  const totp = newTotpSecret()
  const { state, tokens } = await v1State(totp)
  const text = JSON.stringify(state, null, 2)
  writeFileSync(path.join(dir, 'state.json'), text, { mode: 0o600 })
  return { dir, text, state, tokens, totp }
}

describe('the single-account file', () => {
  it('becomes v2 with its account the owner’s, and a copy of it as it was', async () => {
    const { dir, text, state, tokens } = await migrated()
    let clock = NOW
    const store = new Store(dir, () => clock)
    expect(readFileSync(path.join(dir, 'state.v1.json'), 'utf8')).toBe(text)
    if (process.platform !== 'win32') {
      expect(statSync(path.join(dir, 'state.v1.json')).mode & 0o777).toBe(0o600)
      expect(statSync(path.join(dir, 'state.json')).mode & 0o777).toBe(0o600)
    }
    const written = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'))
    expect(written.v).toBe(2)
    const owner = store.owner()!
    expect(owner).toEqual({
      ...state.account,
      username: 'owner',
      owner: true,
      createdAt: NOW - 20 * DAY,
      disabledAt: null,
    })
    expect(store.accounts()).toEqual([owner])
    // Every sign-in of the account is kept as it was; the replaced account's goes.
    expect(
      store
        .families(owner.id)
        .map((f) => f.id)
        .sort(),
    ).toEqual(['famDesktop', 'famPhone'])
    expect(store.checkAccess(tokens.desktopAccess)?.id).toBe('famDesktop')
    expect(store.checkAccess(tokens.phoneAccess)?.id).toBe('famPhone')
    expect(store.checkAccess(tokens.replacedAccess)).toBeNull()
    expect(store.computers(owner.id).map((c) => c.id)).toEqual(['abcdefghijklmnopqrstuvwxyz'])
    expect(store.computer('zyxwvutsrqponmlkjihgfedcba')).toBeNull()
    // Refresh rotates on, and the old token's replay still revokes its family.
    clock += 60_000
    const refreshed = store.refresh(DESKTOP_CLIENT, tokens.desktopRefresh)
    expect(refreshed.ok).toBe(true)
    expect(store.refresh(MOBILE_CLIENT, tokens.oldRefresh)).toEqual({ ok: false, reason: 'reused' })

    // Read again: v2 as written, no second copy.
    const again = new Store(dir, () => clock)
    expect(again.owner()?.id).toBe(owner.id)
    expect(readdirSync(dir).filter((name) => name.startsWith('state.v1'))).toEqual([
      'state.v1.json',
    ])
  })

  it('keeps the copy it made first, and makes another beside rather than over it', async () => {
    const { dir, text } = await migrated()
    writeFileSync(path.join(dir, 'state.v1.json'), 'an earlier copy')
    new Store(dir, () => NOW)
    expect(readFileSync(path.join(dir, 'state.v1.json'), 'utf8')).toBe('an earlier copy')
    expect(readFileSync(path.join(dir, `state.v1-${NOW}.json`), 'utf8')).toBe(text)
  })

  it('refuses a file of a version it does not know', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'huli-migration-'))
    dirs.push(dir)
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ v: 3 }))
    expect(() => new Store(dir)).toThrow(/unknown version/)
  })

  it('serves every client signed in before on, and the owner signs in as before', async () => {
    const { dir, tokens, totp } = await migrated()
    let clock = NOW
    const now = () => clock
    const parts = makeServer(
      { origin: 'http://127.0.0.1', dataDir: dir, trustProxy: false },
      null,
      {
        now,
        log: () => {},
      },
    )
    await new Promise<void>((resolve) => parts.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(parts.server.address() as AddressInfo).port}`
    try {
      const api = new AccountApi(base, fetch, now)
      expect((await api.me(tokens.phoneAccess)).account).toEqual({
        id: 'b6f4c5d2-0d1e-4c4b-9a77-2f1f0b0c9e11',
        email: 'me@example.com',
        name: 'Me',
        avatarUrl: null,
      })
      const devices = await new HuliCloudApi(base, fetch).devices(tokens.phoneAccess)
      expect(devices.computers.map((c) => c.id)).toEqual(['abcdefghijklmnopqrstuvwxyz'])
      expect((await api.relayToken(tokens.desktopAccess)).token).toMatch(/^hr1\./)
      const next = await api.refresh(MOBILE_CLIENT, tokens.phoneRefresh)
      await api.me(next.accessToken)

      // The owner's sign-in pages ask the same password and code, the username left empty.
      clock += TOTP_PERIOD_S * 1000
      const verifier = randomToken(48)
      const url = new URL('/signin/app/', base)
      url.search = new URLSearchParams({
        client_id: DESKTOP_CLIENT,
        redirect_uri: 'http://127.0.0.1:5555/callback',
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: 'S256',
        state: 's',
      }).toString()
      const html = await (await fetch(url)).text()
      const ticket = /name="ticket" value="([^"]+)"/.exec(html)![1]!
      const answer = await signInSteps(
        (fields) =>
          fetch(new URL('/signin/app/', base), {
            method: 'POST',
            body: new URLSearchParams(fields),
            redirect: 'manual',
          }),
        { ticket, action: 'allow', username: '', password: PASSWORD },
        hotp(base32Decode(totp), Math.floor(clock / 1000 / TOTP_PERIOD_S)),
      )
      expect(answer.status).toBe(302)
      expect(new URL(answer.headers.get('location')!).searchParams.get('code')).toBeTruthy()
    } finally {
      parts.relay.close()
      parts.server.close()
    }
  })
})

describe('a file whose accounts have no two-step verification', () => {
  /** A v2 state.json: the owner's account with its TOTP secret, and others without one. */
  async function v2State(ownerTotp: string) {
    const password = await hashPassword(PASSWORD)
    const account = (id: string, username: string, extra: object) => ({
      id,
      username,
      email: username,
      name: null,
      owner: false,
      password,
      createdAt: NOW - DAY,
      disabledAt: null,
      ...extra,
    })
    const state = {
      v: 2,
      accounts: [
        account('acct-owner', 'owner', {
          owner: true,
          email: 'me@example.com',
          createdAt: NOW - 2 * DAY,
          totp: ownerTotp,
          totpLastStep: -1,
          recovery: [sha256Hex('aaaaa-bbbbb')],
        }),
        account('acct-null', 'nulls', { totp: null, totpLastStep: -1, recovery: [] }),
        // Without the fields at all, as a file written by hand might be.
        account('acct-bare', 'bare', {}),
        // An empty secret is none: the codes it gives are anyone's to work out.
        account('acct-empty', 'empty', { totp: '', totpLastStep: 5, recovery: null }),
      ],
      families: [],
      access: [],
      computers: [],
      invites: [],
      push: [],
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'huli-migration-'))
    dirs.push(dir)
    const text = JSON.stringify(state, null, 2)
    writeFileSync(path.join(dir, 'state.json'), text, { mode: 0o600 })
    return { dir, text }
  }

  it('reads them as v2, with no copy made, and writes the fields back whole', async () => {
    const { dir, text } = await v2State(newTotpSecret())
    const store = new Store(dir, () => NOW)
    expect(store.account('acct-null')).toMatchObject({ totp: null, totpLastStep: -1, recovery: [] })
    expect(store.account('acct-bare')).toMatchObject({ totp: null, totpLastStep: -1, recovery: [] })
    expect(store.account('acct-empty')).toMatchObject({ totp: null, totpLastStep: 5, recovery: [] })
    for (const id of ['acct-owner', 'acct-null', 'acct-bare', 'acct-empty']) {
      expect(store.activeAccount(id)?.id).toBe(id)
    }
    expect(listAccounts(store).accounts.map((a) => [a.username, a.state, a.twoStep])).toEqual([
      ['owner', 'active', true],
      ['nulls', 'active', false],
      ['bare', 'active', false],
      ['empty', 'active', false],
    ])
    // Reading changes nothing on disk; the next write keeps v2 and fills the fields in.
    expect(readdirSync(dir)).toEqual(['state.json'])
    expect(readFileSync(path.join(dir, 'state.json'), 'utf8')).toBe(text)
    expect(store.issue('acct-bare', DESKTOP_CLIENT, null)).not.toBeNull()
    const written = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'))
    expect(written.v).toBe(2)
    for (const id of ['acct-bare', 'acct-empty']) {
      expect(written.accounts.find((a: { id: string }) => a.id === id)).toMatchObject({
        totp: null,
        recovery: [],
      })
    }
    expect(new Store(dir, () => NOW).account('acct-bare')).toEqual(store.account('acct-bare'))
    // The owner's account takes its secret as it always did: without one it is not active.
    store.updateAccount('acct-owner', { totp: null })
    expect(store.activeAccount('acct-owner')).toBeNull()
  })

  it('signs them in with the password alone, and the owner still with its code', async () => {
    const totp = newTotpSecret()
    const { dir } = await v2State(totp)
    let clock = NOW
    const parts = makeServer(
      { origin: 'http://127.0.0.1', dataDir: dir, trustProxy: false },
      null,
      {
        now: () => clock,
        log: () => {},
      },
    )
    await new Promise<void>((resolve) => parts.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(parts.server.address() as AddressInfo).port}`
    const login = (fields: Record<string, string>) =>
      fetch(new URL('/web/login', base), {
        method: 'POST',
        body: new URLSearchParams({ next: '/account/devices/', ...fields }),
        redirect: 'manual',
      })
    try {
      for (const username of ['nulls', 'bare', 'empty']) {
        const answer = await login({ username, password: PASSWORD })
        expect(answer.status, username).toBe(302)
        expect(answer.headers.get('location')).toBe('/account/devices/')
      }
      const asked = await login({ password: PASSWORD })
      expect(asked.status).toBe(200)
      expect(await asked.text()).toContain('两步验证')
      clock += TOTP_PERIOD_S * 1000
      const code = hotp(base32Decode(totp), Math.floor(clock / 1000 / TOTP_PERIOD_S))
      expect((await signInSteps(login, { password: PASSWORD }, '000000')).status).toBe(401)
      expect((await signInSteps(login, { password: PASSWORD }, code)).status).toBe(302)
      expect((await signInSteps(login, { password: PASSWORD }, 'aaaaa-bbbbb')).status).toBe(302)
      expect(parts.store.account('acct-owner')!.recovery).toEqual([])
    } finally {
      parts.relay.close()
      parts.server.close()
    }
  })
})
