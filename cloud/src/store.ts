// What Huli Cloud keeps on disk: the one account, the signed-in clients (a family of tokens each),
// their live access tokens and the account's computers, in one JSON file written atomically with
// mode 0600. Tokens are kept only as SHA-256 hashes. Short-lived things (sign-in codes, device
// codes, web sessions) live in memory: a restart only means signing in to the web pages again.
//
// Every family belongs to the account it was signed in to, and every computer to the family that
// registered it: a token or a computer of another account (one `init --force` replaced) is never
// taken, and a computer whose sign-in ended leaves the list with it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_LISTED_HOSTS } from '@shared/remote/relay'
import type { HuliClientInfo } from '@shared/huli-cloud'
import { randomToken, sha256Hex } from './secrets'

export const ACCESS_TTL_S = 60 * 60
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Old refresh tokens a family remembers, to tell a stolen one being replayed. */
const KEEP_PREVIOUS = 8
/** The most computers an account keeps; the one seen longest ago goes first. */
export const MAX_COMPUTERS = MAX_LISTED_HOSTS
/** A computer's last-seen time is written down at most this often while it stays online. */
const SEEN_WRITE_MS = 10 * 60_000

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
  /** The account it was signed in to; a family of another account is never taken. */
  account: string
  clientId: string
  info: HuliClientInfo | null
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

/**
 * A computer of the account: a host that signed in to the relay with the Ed25519 key its id is
 * derived from and a computer's token of the account. Its profile (name, platform and the X25519
 * key of its channel) is what it said over that signed-in socket; devices take the key only as the
 * one to encrypt a pairing to, and the pairing proves it (see cloud/README.md).
 */
export interface Computer {
  /** Its relay host id. */
  id: string
  account: string
  /** The sign-in it registered with; it leaves the list when that sign-in ends. */
  family: string
  /** Its Ed25519 public key, in base64url, as its relay sign-in proved. */
  signKey: string
  /** Its X25519 public key, in base64url, from its profile; null before it sent one. */
  key: string | null
  name: string | null
  platform: string | null
  /** Whether it takes pairing requests from the account's devices now. */
  pairable: boolean
  firstSeen: number
  lastSeen: number
}

export interface ComputerProfile {
  key: string
  name: string
  platform: string
  pairable: boolean
}

interface State {
  v: 1
  account: Account | null
  families: Family[]
  access: AccessToken[]
  /** Missing in a file written before the registry. */
  computers?: Computer[]
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
    // Families from before they named their account were all signed in to the one account there
    // was; with none, they belong to no account and are never taken.
    for (const family of parsed.families) family.account ??= parsed.account?.id ?? ''
    parsed.computers ??= []
    return parsed
  }

  private write(): void {
    const now = this.now()
    this.state.access = this.state.access.filter((token) => token.expiresAt > now)
    this.state.families = this.state.families.filter((family) => family.refreshExpiresAt > now)
    const live = new Set(this.state.families.map((family) => family.id))
    this.state.computers = this.computerList().filter((computer) => live.has(computer.family))
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    renameSync(temp, this.file)
  }

  private computerList(): Computer[] {
    return (this.state.computers ??= [])
  }

  get account(): Account | null {
    return this.state.account
  }

  /** The current account's id; null without one. */
  private get accountId(): string | null {
    return this.state.account?.id ?? null
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

  /** The current account's signed-in clients, the one used last first. */
  families(): Family[] {
    const account = this.accountId
    return this.state.families
      .filter((family) => family.account === account)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  /** A signed-in client of the current account, while it is signed in. */
  family(id: string): Family | null {
    const family = this.state.families.find((f) => f.id === id)
    return family && family.account === this.accountId && family.refreshExpiresAt > this.now()
      ? family
      : null
  }

  /** Signs a client in to the current account: a new family with its first pair of tokens. */
  issue(clientId: string, info: HuliClientInfo | null): IssuedTokens {
    const account = this.accountId
    if (!account) throw new Error('No account')
    const now = this.now()
    const refresh = randomToken()
    const family: Family = {
      id: randomToken(12),
      account,
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
    if (family.account !== this.accountId) return { ok: false, reason: 'unknown' }
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
    return this.accessEntry(accessToken)?.family ?? null
  }

  /** The family of a live access token and when the token lapses. */
  accessEntry(accessToken: string): { family: Family; expiresAt: number } | null {
    const hash = sha256Hex(accessToken)
    const now = this.now()
    const token = this.state.access.find((t) => t.hash === hash && t.expiresAt > now)
    if (!token) return null
    const family = this.family(token.family)
    return family ? { family, expiresAt: token.expiresAt } : null
  }

  /** Whether a client of the current account is still signed in. */
  hasFamily(id: string): boolean {
    return this.family(id) !== null
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

  /** Signs out every client, of whichever account, as a new account starts. */
  revokeAll(): number {
    const count = this.state.families.length
    this.state.families = []
    this.state.access = []
    this.write()
    return count
  }

  revokeFamily(id: string): void {
    this.state.families = this.state.families.filter((f) => f.id !== id)
    this.state.access = this.state.access.filter((t) => t.family !== id)
    this.write()
  }

  // ---- The account's computers ------------------------------------------------------------------

  /** The current account's computers whose sign-in is live, the one seen last first. */
  computers(): Computer[] {
    const account = this.accountId
    return this.computerList()
      .filter((c) => c.account === account && this.hasFamily(c.family))
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /** One of the current account's computers, while its sign-in is live. */
  computer(id: string): Computer | null {
    const computer = this.computerList().find((c) => c.id === id)
    return computer && computer.account === this.accountId && this.hasFamily(computer.family)
      ? computer
      : null
  }

  /**
   * A host signed in to the relay with the sign-in `family` and the Ed25519 key `signKey`, which
   * its id is derived from: it is the account's computer from now on, under that sign-in. One held
   * for another account or under another key starts over.
   */
  registerComputer(id: string, family: string, signKey: string): Computer | null {
    const owner = this.family(family)
    if (!owner) return null
    const now = this.now()
    const list = this.computerList()
    const at = list.findIndex((c) => c.id === id)
    const before = at >= 0 ? list[at]! : null
    const kept = before && before.account === owner.account && before.signKey === signKey
    const computer: Computer = kept
      ? { ...before, family, lastSeen: now }
      : {
          id,
          account: owner.account,
          family,
          signKey,
          key: null,
          name: null,
          platform: null,
          pairable: false,
          firstSeen: now,
          lastSeen: now,
        }
    if (at >= 0) list[at] = computer
    else list.push(computer)
    // An account keeps MAX_COMPUTERS; the one seen longest ago makes room.
    const mine = list.filter((c) => c.account === owner.account)
    if (mine.length > MAX_COMPUTERS) {
      const oldest = mine.reduce((a, b) => (b.lastSeen < a.lastSeen ? b : a))
      this.state.computers = list.filter((c) => c !== oldest)
    }
    this.write()
    return computer
  }

  /** What a signed-in computer says of itself; null takes its profile back. */
  setComputerProfile(id: string, profile: ComputerProfile | null): void {
    const computer = this.computer(id)
    if (!computer) return
    const next: Computer = profile
      ? { ...computer, ...profile, lastSeen: this.now() }
      : { ...computer, key: null, name: null, platform: null, pairable: false }
    const changed = (['key', 'name', 'platform', 'pairable'] as const).some(
      (field) => next[field] !== computer[field],
    )
    if (!changed) return this.computerSeen(id)
    Object.assign(computer, next)
    this.write()
  }

  /**
   * The computer was online until now; written down at once when `left`, else at most every
   * SEEN_WRITE_MS, since the list says a computer that is online was seen now.
   */
  computerSeen(id: string, left = false): void {
    const computer = this.computer(id)
    if (!computer) return
    const now = this.now()
    const due = left || now - computer.lastSeen >= SEEN_WRITE_MS
    computer.lastSeen = now
    if (due) this.write()
  }

  /** Takes a computer off the account's list; it comes back when it signs in to the relay again. */
  forgetComputer(id: string): boolean {
    const computer = this.computer(id)
    if (!computer) return false
    this.state.computers = this.computerList().filter((c) => c !== computer)
    this.write()
    return true
  }
}
