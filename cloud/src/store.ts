// What Huli Cloud keeps on disk: the one account, the signed-in clients (a family of tokens each)
// and their live access tokens, in one JSON file written atomically with mode 0600. Tokens are
// kept only as SHA-256 hashes. Short-lived things (sign-in codes, device codes, web sessions) live
// in memory: a restart only means signing in to the web pages again.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ClientInfo } from '@shared/account-api'
import { randomToken, sha256Hex } from './secrets'

export const ACCESS_TTL_S = 60 * 60
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Old refresh tokens a family remembers, to tell a stolen one being replayed. */
const KEEP_PREVIOUS = 8

export interface Account {
  id: string
  email: string
  name: string | null
  password: string
  totp: string
  /** The last TOTP step used, so a code works once. */
  totpLastStep: number
  /** SHA-256 hashes of the unused recovery codes. */
  recovery: string[]
}

export interface Family {
  id: string
  clientId: string
  info: ClientInfo | null
  createdAt: number
  lastUsedAt: number
  refresh: string
  refreshExpiresAt: number
  previous: string[]
}

interface AccessToken {
  hash: string
  family: string
  expiresAt: number
}

interface State {
  v: 1
  account: Account | null
  families: Family[]
  access: AccessToken[]
}

export interface IssuedTokens {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
}

export type RefreshResult =
  | { ok: true; tokens: IssuedTokens }
  | { ok: false; reason: 'unknown' | 'reused' | 'expired' | 'client' }

export class Store {
  private state: State
  private readonly file: string

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.file = path.join(dataDir, 'state.json')
    this.state = this.read()
  }

  private read(): State {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { v: 1, account: null, families: [], access: [] }
      }
      throw error
    }
    const parsed = JSON.parse(text) as State
    if (parsed.v !== 1) throw new Error(`${this.file} has an unknown version`)
    return parsed
  }

  private write(): void {
    const now = this.now()
    this.state.access = this.state.access.filter((token) => token.expiresAt > now)
    this.state.families = this.state.families.filter((family) => family.refreshExpiresAt > now)
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    renameSync(temp, this.file)
  }

  get account(): Account | null {
    return this.state.account
  }

  setAccount(account: Account): void {
    this.state.account = account
    this.write()
  }

  updateAccount(change: Partial<Account>): void {
    if (!this.state.account) throw new Error('No account')
    this.state.account = { ...this.state.account, ...change }
    this.write()
  }

  families(): Family[] {
    return [...this.state.families].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  /** Signs a client in: a new family with its first pair of tokens. */
  issue(clientId: string, info: ClientInfo | null): IssuedTokens {
    const now = this.now()
    const refresh = randomToken()
    const family: Family = {
      id: randomToken(12),
      clientId,
      info,
      createdAt: now,
      lastUsedAt: now,
      refresh: sha256Hex(refresh),
      refreshExpiresAt: now + REFRESH_TTL_MS,
      previous: [],
    }
    this.state.families.push(family)
    return this.tokens(family, refresh)
  }

  private tokens(family: Family, refresh: string): IssuedTokens {
    const access = randomToken()
    this.state.access.push({
      hash: sha256Hex(access),
      family: family.id,
      expiresAt: this.now() + ACCESS_TTL_S * 1000,
    })
    this.write()
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
    }
  }

  /** Rotates a refresh token. Replaying an old one revokes its whole family (RFC 9700 4.14.2). */
  refresh(clientId: string, refreshToken: string): RefreshResult {
    const hash = sha256Hex(refreshToken)
    const family = this.state.families.find((f) => f.refresh === hash)
    if (!family) {
      const stolen = this.state.families.find((f) => f.previous.includes(hash))
      if (stolen) {
        this.revokeFamily(stolen.id)
        return { ok: false, reason: 'reused' }
      }
      return { ok: false, reason: 'unknown' }
    }
    if (family.clientId !== clientId) return { ok: false, reason: 'client' }
    const now = this.now()
    if (family.refreshExpiresAt <= now) {
      this.revokeFamily(family.id)
      return { ok: false, reason: 'expired' }
    }
    const next = randomToken()
    family.previous = [family.refresh, ...family.previous].slice(0, KEEP_PREVIOUS)
    family.refresh = sha256Hex(next)
    family.refreshExpiresAt = now + REFRESH_TTL_MS
    family.lastUsedAt = now
    // The family's older access tokens end with the rotation.
    this.state.access = this.state.access.filter((token) => token.family !== family.id)
    return { ok: true, tokens: this.tokens(family, next) }
  }

  /** The family an access token belongs to, while it is live. */
  checkAccess(accessToken: string): Family | null {
    const hash = sha256Hex(accessToken)
    const now = this.now()
    const token = this.state.access.find((t) => t.hash === hash && t.expiresAt > now)
    if (!token) return null
    return this.state.families.find((f) => f.id === token.family) ?? null
  }

  /** Revokes the family a refresh or access token belongs to; nothing for an unknown token. */
  revokeToken(token: string): void {
    const hash = sha256Hex(token)
    const family =
      this.state.families.find((f) => f.refresh === hash || f.previous.includes(hash)) ??
      this.state.families.find(
        (f) => f.id === this.state.access.find((t) => t.hash === hash)?.family,
      )
    if (family) this.revokeFamily(family.id)
  }

  revokeFamily(id: string): void {
    this.state.families = this.state.families.filter((f) => f.id !== id)
    this.state.access = this.state.access.filter((t) => t.family !== id)
    this.write()
  }
}
