// What Huli Cloud keeps on disk: the accounts, the signed-in clients (a family of tokens each),
// their live access tokens, the accounts' computers, the invite codes the owner made and the
// account each push target belongs to, in one JSON file written atomically with mode 0600. Tokens,
// invite codes and push targets are kept only as SHA-256 hashes. Short-lived things (sign-in
// codes, device codes, web sessions, sign-ups under way) live in memory: a restart only means
// signing in to the web pages again.
//
// Every family belongs to the account it was signed in to, and every computer to the family that
// registered it. Nothing of an account is taken while it is disabled, while it waits for a reset to
// be redeemed, or after it was removed: its tokens, its computers and its web sessions all go
// through `family` and `activeAccount`, and a family of one account never stands for another.
//
// The file the single-account service wrote (v1) is read once, kept as it was beside as
// state.v1.json, and written as v2: its account becomes the owner's, named `owner`, and every
// sign-in, computer and token of it stays as it was.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_LISTED_HOSTS } from '@shared/remote/relay'
import type { HuliClientInfo } from '@shared/huli-cloud'
import { newInviteCode, normalizeInvite, randomToken, sha256Hex } from './secrets'

export const ACCESS_TTL_S = 60 * 60
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Old refresh tokens a family remembers, to tell a stolen one being replayed. */
const KEEP_PREVIOUS = 8
/** The most computers an account keeps; the one seen longest ago goes first. */
export const MAX_COMPUTERS = MAX_LISTED_HOSTS
/** A computer's last-seen time is written down at most this often while it stays online. */
const SEEN_WRITE_MS = 10 * 60_000
/** The most accounts the service holds, the owner's among them. */
export const MAX_ACCOUNTS = 32
/** Invite codes not used yet that may be open at once. */
export const MAX_OPEN_INVITES = 20
/** How long an invite lasts by default, and at most. */
export const INVITE_DAYS = 7
export const MAX_INVITE_DAYS = 30
/** How long a used, revoked or lapsed invite stays listed. */
const INVITE_HISTORY_MS = 30 * 24 * 60 * 60 * 1000
/** Push targets an account keeps; the one used longest ago goes first. */
export const MAX_PUSH_TARGETS = 512
/** A push target not pushed to for this long is forgotten. */
const PUSH_TARGET_MS = 90 * 24 * 60 * 60 * 1000
/** A push target's last use is written down at most this often. */
const PUSH_WRITE_MS = 24 * 60 * 60 * 1000
/** The owner's name as the single-account file becomes v2. */
export const OWNER_USERNAME = 'owner'

/** A username: 2 to 32 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit. */
export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/

/** A username as typed, lowercase; null for one that cannot be one. */
export function normalizeUsername(text: string): string | null {
  const name = text.trim().toLowerCase()
  return USERNAME.test(name) ? name : null
}

export interface Account {
  /** Stable: every family, computer and push target names its account by this. */
  id: string
  /** What it signs in with; unique, lowercase. */
  username: string
  /** What its clients show: the owner's address from before, another account's username. */
  email: string
  name: string | null
  /** The account from before there were others; it manages them and cannot be disabled. */
  owner: boolean
  /** Null, as the TOTP secret, while a reset waits for its invite: it cannot sign in then. */
  password: string | null
  totp: string | null
  /** The last TOTP step used, so a code works once. */
  totpLastStep: number
  /** SHA-256 hashes of the unused recovery codes. */
  recovery: string[]
  createdAt: number
  /** When the owner disabled it; nothing of it is taken while set. */
  disabledAt: number | null
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
 * A computer of an account: a host that signed in to the relay with the Ed25519 key its id is
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

/**
 * An invite code the owner made: a new account signs up with it once, or, when it names an
 * account, that account sets a new password and two-step verification with it once.
 */
export interface Invite {
  /** Short and public, for listing and revoking; the code itself is kept only as its hash. */
  id: string
  hash: string
  /** The account it resets; null for a new account. */
  account: string | null
  createdAt: number
  expiresAt: number
  usedAt: number | null
  /** The account it made or reset. */
  usedBy: string | null
  revokedAt: number | null
}

export type InviteStatus = 'open' | 'used' | 'revoked' | 'expired'

/**
 * Which account an APNs target (a device or Live Activity token, with its environment) belongs
 * to: the first whose computer pushed to it and Apple took it. Another account's pushes to it are
 * refused, so knowing a phone's token is no way to reach it from another account.
 */
interface PushTarget {
  hash: string
  account: string
  boundAt: number
  usedAt: number
}

interface State {
  v: 2
  accounts: Account[]
  families: Family[]
  access: AccessToken[]
  computers: Computer[]
  invites: Invite[]
  push: PushTarget[]
}

/** The single-account file before v2, as far as it is read. */
interface StateV1 {
  v: 1
  account: Omit<Account, 'username' | 'owner' | 'createdAt' | 'disabledAt'> | null
  families: (Omit<Family, 'account'> & { account?: string })[]
  access: AccessToken[]
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

/** What a new or reset account sets as it redeems its invite. */
export interface Credentials {
  password: string
  totp: string
  totpLastStep: number
  /** Hashes. */
  recovery: string[]
}

export type RedeemResult =
  | { ok: true; account: Account; reset: boolean }
  | { ok: false; reason: 'invite' | 'username' | 'full' }

export class Store {
  private state: State
  private readonly file: string

  constructor(
    private readonly dataDir: string,
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
        return {
          v: 2,
          accounts: [],
          families: [],
          access: [],
          computers: [],
          invites: [],
          push: [],
        }
      }
      throw error
    }
    const parsed = JSON.parse(text) as State | StateV1
    if (parsed.v === 2) return parsed
    if (parsed.v !== 1) throw new Error(`${this.file} has an unknown version`)
    // The file as it was is kept before anything is written over it.
    this.keepCopy('state.v1.json', text)
    this.state = migrate(parsed, this.now())
    this.write()
    return this.state
  }

  /** Writes `text` to `name` in the data folder, or beside under a new name when that is taken. */
  private keepCopy(name: string, text: string): void {
    const first = path.join(this.dataDir, name)
    try {
      writeFileSync(first, text, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const other = path.join(this.dataDir, name.replace(/\.json$/, `-${this.now()}.json`))
      writeFileSync(other, text, { mode: 0o600, flag: 'wx' })
    }
  }

  private write(): void {
    const now = this.now()
    const accounts = new Set(this.state.accounts.map((account) => account.id))
    this.state.families = this.state.families.filter(
      (family) => family.refreshExpiresAt > now && accounts.has(family.account),
    )
    const live = new Map(this.state.families.map((family) => [family.id, family.account]))
    this.state.access = this.state.access.filter(
      (token) => token.expiresAt > now && live.has(token.family),
    )
    this.state.computers = this.state.computers.filter(
      (computer) => live.get(computer.family) === computer.account,
    )
    this.state.invites = this.state.invites.filter(
      (invite) =>
        (invite.account === null || accounts.has(invite.account)) &&
        (this.inviteStatus(invite) === 'open' ||
          Math.max(invite.usedAt ?? 0, invite.revokedAt ?? 0, invite.expiresAt) >
            now - INVITE_HISTORY_MS),
    )
    this.state.push = this.state.push.filter(
      (target) => accounts.has(target.account) && target.usedAt > now - PUSH_TARGET_MS,
    )
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    renameSync(temp, this.file)
  }

  // ---- Accounts ---------------------------------------------------------------------------------

  /** Every account, the oldest first. */
  accounts(): Account[] {
    return [...this.state.accounts].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** An account, whatever its state. */
  account(id: string): Account | null {
    return this.state.accounts.find((account) => account.id === id) ?? null
  }

  /** An account that may sign in and be used: not disabled, its password and TOTP set. */
  activeAccount(id: string): Account | null {
    const account = this.account(id)
    return account && account.disabledAt === null && account.password && account.totp
      ? account
      : null
  }

  owner(): Account | null {
    return this.state.accounts.find((account) => account.owner) ?? null
  }

  /** The account a sign-in names: by username, by its address, or the owner's when left empty. */
  findAccount(login: string): Account | null {
    const key = login.trim().toLowerCase()
    if (!key) return this.owner()
    return (
      this.state.accounts.find((account) => account.username === key) ??
      (key.includes('@')
        ? this.state.accounts.find((account) => account.email.toLowerCase() === key)
        : undefined) ??
      null
    )
  }

  private usernameTaken(username: string): boolean {
    return this.state.accounts.some(
      (account) => account.username === username || account.email.toLowerCase() === username,
    )
  }

  /**
   * Makes the owner's account. One there was is removed first, with everything of it, as `init
   * --force` asks; the other accounts stay.
   */
  setOwner(input: {
    username: string
    email: string
    name: string | null
    credentials: Credentials
  }): Account {
    const before = this.owner()
    if (before) this.removeAccount(before.id, true)
    if (this.usernameTaken(input.username)) throw new Error('username taken')
    const account: Account = {
      id: randomUUID(),
      username: input.username,
      email: input.email,
      name: input.name,
      owner: true,
      ...input.credentials,
      createdAt: this.now(),
      disabledAt: null,
    }
    this.state.accounts.push(account)
    this.write()
    return account
  }

  /** Changes what an account signs in with. */
  updateAccount(
    id: string,
    change: Partial<Pick<Account, 'password' | 'totp' | 'totpLastStep' | 'recovery'>>,
  ): void {
    const account = this.account(id)
    if (!account) throw new Error('No such account')
    Object.assign(account, change)
    this.write()
  }

  /** Disables or enables an account other than the owner's; false for none such. */
  setDisabled(id: string, disabled: boolean): boolean {
    const account = this.account(id)
    if (!account || account.owner) return false
    account.disabledAt = disabled ? (account.disabledAt ?? this.now()) : null
    this.write()
    return true
  }

  /**
   * Removes an account and everything of it: its sign-ins and tokens, computers, invites and push
   * targets. The owner's only as `setOwner` replaces it.
   */
  removeAccount(id: string, owner = false): boolean {
    const account = this.account(id)
    if (!account || (account.owner && !owner)) return false
    this.state.accounts = this.state.accounts.filter((a) => a !== account)
    this.write()
    return true
  }

  /**
   * Signs an account out everywhere and clears its password and two-step verification; an invite
   * for it, which replaces any before, sets them anew. Null for no such account, or the owner's.
   */
  resetAccount(
    id: string,
    days: number,
  ): { code: string; invite: Invite; signedOut: number } | null {
    const account = this.account(id)
    if (!account || account.owner) return null
    const signedOut = this.families(id).length
    this.state.families = this.state.families.filter((family) => family.account !== id)
    Object.assign(account, { password: null, totp: null, recovery: [] })
    for (const invite of this.state.invites) {
      if (invite.account === id && this.inviteStatus(invite) === 'open') {
        invite.revokedAt = this.now()
      }
    }
    const made = this.makeInvite(id, days)
    this.write()
    return { ...made, signedOut }
  }

  // ---- Invites ----------------------------------------------------------------------------------

  inviteStatus(invite: Invite): InviteStatus {
    if (invite.usedAt !== null) return 'used'
    if (invite.revokedAt !== null) return 'revoked'
    return invite.expiresAt > this.now() ? 'open' : 'expired'
  }

  /** Every invite still listed, the newest first. */
  invites(): Invite[] {
    return [...this.state.invites].sort((a, b) => b.createdAt - a.createdAt)
  }

  private makeInvite(account: string | null, days: number): { code: string; invite: Invite } {
    const code = newInviteCode()
    const now = this.now()
    const invite: Invite = {
      id: randomToken(6),
      hash: sha256Hex(normalizeInvite(code)!),
      account,
      createdAt: now,
      expiresAt: now + days * 24 * 60 * 60 * 1000,
      usedAt: null,
      usedBy: null,
      revokedAt: null,
    }
    this.state.invites.push(invite)
    return { code, invite }
  }

  /** A new invite for a new account, lasting `days`; null while too many are open. */
  createInvite(days: number): { code: string; invite: Invite } | null {
    const open = this.state.invites.filter((invite) => this.inviteStatus(invite) === 'open')
    if (open.length >= MAX_OPEN_INVITES) return null
    const made = this.makeInvite(null, days)
    this.write()
    return made
  }

  /** The invite a code typed in is, while it can be used; null for any other. */
  openInvite(code: string): Invite | null {
    const clean = normalizeInvite(code)
    if (!clean) return null
    const hash = sha256Hex(clean)
    const invite = this.state.invites.find((i) => i.hash === hash)
    if (!invite || this.inviteStatus(invite) !== 'open') return null
    if (invite.account !== null && !this.account(invite.account)) return null
    return invite
  }

  /** Revokes an invite not used yet; false for none such. */
  revokeInvite(id: string): boolean {
    const invite = this.state.invites.find((i) => i.id === id)
    if (!invite || this.inviteStatus(invite) !== 'open') return false
    invite.revokedAt = this.now()
    this.write()
    return true
  }

  /**
   * Uses an invite, once: makes the account it is for under `username`, or sets anew the
   * credentials of the account it resets, whose username `username` must be. Everything is
   * checked again here, as the invite may have been used or revoked since it was typed in.
   */
  redeemInvite(inviteId: string, username: string, credentials: Credentials): RedeemResult {
    const invite = this.state.invites.find((i) => i.id === inviteId)
    if (!invite || this.inviteStatus(invite) !== 'open') return { ok: false, reason: 'invite' }
    let account: Account
    const now = this.now()
    if (invite.account !== null) {
      const target = this.account(invite.account)
      if (!target) return { ok: false, reason: 'invite' }
      if (target.username !== username) return { ok: false, reason: 'username' }
      // Whatever signed in before the reset stays out.
      this.state.families = this.state.families.filter((family) => family.account !== target.id)
      Object.assign(target, credentials)
      account = target
    } else {
      if (this.usernameTaken(username)) return { ok: false, reason: 'username' }
      if (this.state.accounts.length >= MAX_ACCOUNTS) return { ok: false, reason: 'full' }
      account = {
        id: randomUUID(),
        username,
        email: username,
        name: null,
        owner: false,
        ...credentials,
        createdAt: now,
        disabledAt: null,
      }
      this.state.accounts.push(account)
    }
    invite.usedAt = now
    invite.usedBy = account.id
    this.write()
    return { ok: true, account, reset: invite.account !== null }
  }

  /** Whether `username` could sign up: well formed and nobody's. */
  usernameFree(username: string): boolean {
    return !this.usernameTaken(username)
  }

  // ---- Sign-ins ---------------------------------------------------------------------------------

  /** An account's signed-in clients, the one used last first, whatever the account's state. */
  families(account: string): Family[] {
    const now = this.now()
    return this.state.families
      .filter((family) => family.account === account && family.refreshExpiresAt > now)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  /** A signed-in client, while it is signed in and its account active. */
  family(id: string): Family | null {
    const family = this.state.families.find((f) => f.id === id)
    return family && family.refreshExpiresAt > this.now() && this.activeAccount(family.account)
      ? family
      : null
  }

  /** Signs a client in to an active account: a new family with its first pair of tokens. */
  issue(account: string, clientId: string, info: HuliClientInfo | null): IssuedTokens | null {
    if (!this.activeAccount(account)) return null
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
    if (!this.activeAccount(family.account)) return { ok: false, reason: 'unknown' }
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

  /** Whether a client is still signed in to an active account. */
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

  revokeFamily(id: string): void {
    this.state.families = this.state.families.filter((f) => f.id !== id)
    this.write()
  }

  /** Signs every client of an account out; how many there were. */
  signOutAccount(account: string): number {
    const count = this.families(account).length
    this.state.families = this.state.families.filter((family) => family.account !== account)
    this.write()
    return count
  }

  // ---- The accounts' computers ------------------------------------------------------------------

  /** An account's computers whose sign-in is live, the one seen last first. */
  computers(account: string): Computer[] {
    return this.state.computers
      .filter((c) => c.account === account && this.family(c.family)?.account === account)
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /** A computer, while the sign-in it registered with is live and its account active. */
  computer(id: string): Computer | null {
    const computer = this.state.computers.find((c) => c.id === id)
    return computer && this.family(computer.family)?.account === computer.account ? computer : null
  }

  /**
   * A host signed in to the relay with the sign-in `family` and the Ed25519 key `signKey`, which
   * its id is derived from: it is that account's computer from now on, under that sign-in. One held
   * for another account or under another key starts over.
   */
  registerComputer(id: string, family: string, signKey: string): Computer | null {
    const owner = this.family(family)
    if (!owner) return null
    const now = this.now()
    const list = this.state.computers
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

  /** Takes a computer off its account's list; it comes back when it signs in to the relay again. */
  forgetComputer(id: string): boolean {
    const computer = this.computer(id)
    if (!computer) return false
    this.state.computers = this.state.computers.filter((c) => c !== computer)
    this.write()
    return true
  }

  // ---- Push targets -----------------------------------------------------------------------------

  /** The account an APNs target belongs to; null for one no account pushed to yet. */
  pushAccount(target: string): string | null {
    const hash = sha256Hex(target)
    return this.state.push.find((t) => t.hash === hash)?.account ?? null
  }

  /** Apple took a push to `target` from `account`: it is that account's, unless it is another's. */
  bindPush(target: string, account: string): void {
    const hash = sha256Hex(target)
    const now = this.now()
    const kept = this.state.push.find((t) => t.hash === hash)
    if (kept) {
      if (kept.account !== account) return
      const due = now - kept.usedAt >= PUSH_WRITE_MS
      kept.usedAt = now
      if (due) this.write()
      return
    }
    this.state.push.push({ hash, account, boundAt: now, usedAt: now })
    const mine = this.state.push.filter((t) => t.account === account)
    if (mine.length > MAX_PUSH_TARGETS) {
      const oldest = mine.reduce((a, b) => (b.usedAt < a.usedAt ? b : a))
      this.state.push = this.state.push.filter((t) => t !== oldest)
    }
    this.write()
  }

  /** Apple no longer takes `target`: it is no account's any more. */
  dropPush(target: string, account: string): void {
    const hash = sha256Hex(target)
    const before = this.state.push.length
    this.state.push = this.state.push.filter((t) => t.hash !== hash || t.account !== account)
    if (this.state.push.length !== before) this.write()
  }

  /** What an account holds, whatever its state, for the account list. */
  holdings(account: string): { devices: number; computers: number; pushTargets: number } {
    const devices = this.families(account)
    const ids = new Set(devices.map((family) => family.id))
    return {
      devices: devices.length,
      computers: this.state.computers.filter((c) => c.account === account && ids.has(c.family))
        .length,
      pushTargets: this.state.push.filter((t) => t.account === account).length,
    }
  }
}

/**
 * The single-account file as v2: its account the owner's, named `owner`, and every sign-in that
 * named no account, or the one account, that account's. A sign-in of an account `init --force`
 * replaced belongs to no account and is dropped, with what hangs on it.
 */
function migrate(old: StateV1, now: number): State {
  const accounts: Account[] = []
  const v1 = old.account
  if (v1) {
    const firstSignIn = Math.min(now, ...old.families.map((family) => family.createdAt))
    accounts.push({
      id: v1.id,
      username: OWNER_USERNAME,
      email: v1.email,
      name: v1.name,
      owner: true,
      password: v1.password,
      totp: v1.totp,
      totpLastStep: v1.totpLastStep,
      recovery: v1.recovery,
      createdAt: firstSignIn,
      disabledAt: null,
    })
  }
  return {
    v: 2,
    accounts,
    families: old.families.map((family) => ({
      ...family,
      account: family.account ?? v1?.id ?? '',
    })),
    access: old.access,
    computers: old.computers ?? [],
    invites: [],
    push: [],
  }
}
