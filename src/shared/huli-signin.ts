// The phone's Huli Cloud sign-in, apart from the phone's own APIs so it can be tested: the system's
// web authentication session to the cloud's /signin/app/ as the public client `huli-mobile`, with
// PKCE (RFC 7636) and the app's URL scheme as redirect (RFC 8252 7.1); the refresh token, which
// rotates on every use, kept in the vault the phone gives (its Keychain, this device only); the
// access token and relay token only in memory; and signing out, which revokes at the cloud and
// forgets here even when the cloud cannot be reached.

import {
  AccountNetworkError,
  AccountServiceError,
  clientInfo,
  type AccountApi,
  type TokenSet,
} from './account-api'
import { MOBILE_CLIENT, MOBILE_REDIRECT, type HuliClientInfo } from './huli-cloud'
import { encodeRelayBytes } from './remote/relay'

/** Where the refresh token and the account are kept: one text, written whole. */
export interface SignInVault {
  read(): Promise<string | null>
  write(text: string): Promise<void>
  clear(): Promise<void>
}

export interface CloudSessionEnv {
  api: Pick<AccountApi, 'base' | 'exchangeCode' | 'refresh' | 'revoke' | 'me' | 'relayToken'>
  vault: SignInVault
  /**
   * Opens the sign-in page in the system's authentication session; the URL it was sent back to
   * at `redirect`, or null when the user closed it.
   */
  authenticate(url: string, redirect: string): Promise<string | null>
  random(bytes: number): Uint8Array
  sha256(bytes: Uint8Array): Promise<Uint8Array>
  /** How the account's device list names this phone. */
  info: Omit<HuliClientInfo, 'kind'>
  now?: () => number
}

export interface CloudAccount {
  id: string
  email: string
  name: string | null
}

export type CloudStatus =
  | { state: 'signed-out'; reason: 'revoked' | null }
  | { state: 'signing-in' }
  | { state: 'signed-in'; account: CloudAccount }

export type SignInResult = 'signed-in' | 'cancelled' | 'denied' | 'failed' | 'network'

interface Stored {
  v: 1
  refreshToken: string
  account: CloudAccount
}

/** A relay token is replaced this long before it lapses. */
const RELAY_MARGIN_MS = 5 * 60_000

function parseStored(text: string | null): Stored | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<Stored> | null
    const account = value?.account
    if (
      value?.v !== 1 ||
      typeof value.refreshToken !== 'string' ||
      !value.refreshToken ||
      typeof account?.id !== 'string' ||
      typeof account.email !== 'string' ||
      (account.name !== null && typeof account.name !== 'string')
    ) {
      return null
    }
    return {
      v: 1,
      refreshToken: value.refreshToken,
      account: { id: account.id, email: account.email, name: account.name },
    }
  } catch {
    return null
  }
}

/** The query of a URL as the redirect gives it, without relying on a URL parser for its scheme. */
export function redirectQuery(url: string, redirect: string): Map<string, string> | null {
  if (!url.startsWith(`${redirect}?`) && url !== redirect) return null
  const query = new Map<string, string>()
  const text = url.slice(redirect.length + 1).split('#')[0] ?? ''
  for (const part of text.split('&')) {
    if (!part) continue
    const at = part.indexOf('=')
    const key = at < 0 ? part : part.slice(0, at)
    const value = at < 0 ? '' : part.slice(at + 1)
    try {
      query.set(
        decodeURIComponent(key.replace(/\+/g, ' ')),
        decodeURIComponent(value.replace(/\+/g, ' ')),
      )
    } catch {
      return null
    }
  }
  return query
}

export class CloudSession {
  private stored: Stored | null = null
  private access: { token: string; expiresAt: number } | null = null
  private relay: { token: string; expiresAt: number } | null = null
  private refreshing: Promise<string | null> | null = null
  private signingIn = false
  private reason: 'revoked' | null = null
  /** Changes whenever the sign-in is replaced or forgotten, so late answers are dropped. */
  private generation = 0
  private readonly listeners = new Set<(status: CloudStatus) => void>()
  private readonly now: () => number

  constructor(private readonly env: CloudSessionEnv) {
    this.now = env.now ?? Date.now
  }

  /** Reads what the vault keeps; a record it cannot read is cleared. */
  async load(): Promise<CloudStatus> {
    const text = await this.env.vault.read().catch(() => null)
    this.stored = parseStored(text)
    if (text && !this.stored) await this.env.vault.clear().catch(() => {})
    this.emit()
    return this.status()
  }

  status(): CloudStatus {
    if (this.signingIn) return { state: 'signing-in' }
    if (!this.stored) return { state: 'signed-out', reason: this.reason }
    return { state: 'signed-in', account: this.stored.account }
  }

  onChanged(listener: (status: CloudStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Signs in through the system's authentication session. */
  async signIn(): Promise<SignInResult> {
    if (this.signingIn) return 'cancelled'
    const { env } = this
    const verifier = encodeRelayBytes(env.random(32))
    const state = encodeRelayBytes(env.random(24))
    const challenge = encodeRelayBytes(await env.sha256(new TextEncoder().encode(verifier)))
    // Spelled out rather than through URLSearchParams, which React Native only partly has.
    const query = Object.entries({
      client_id: MOBILE_CLIENT,
      redirect_uri: MOBILE_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      client_info: JSON.stringify({ ...clientInfo({ ...env.info, kind: 'web' }), kind: 'mobile' }),
    })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')
    this.signingIn = true
    this.emit()
    try {
      const back = await env.authenticate(`${env.api.base}/signin/app/?${query}`, MOBILE_REDIRECT)
      if (back === null) return 'cancelled'
      const answer = redirectQuery(back, MOBILE_REDIRECT)
      // A redirect of another sign-in, or of none, is not this one's.
      if (!answer || answer.get('state') !== state) return 'failed'
      const code = answer.get('code')
      if (!code) return answer.get('error') === 'access_denied' ? 'denied' : 'failed'
      let tokens: TokenSet
      try {
        tokens = await env.api.exchangeCode({
          code,
          redirectUri: MOBILE_REDIRECT,
          verifier,
          clientId: MOBILE_CLIENT,
        })
      } catch (error) {
        return error instanceof AccountNetworkError ? 'network' : 'failed'
      }
      try {
        const me = await env.api.me(tokens.accessToken)
        const stored: Stored = {
          v: 1,
          refreshToken: tokens.refreshToken,
          account: { id: me.account.id, email: me.account.email, name: me.account.name },
        }
        await env.vault.write(JSON.stringify(stored))
        this.generation++
        this.stored = stored
        this.reason = null
        this.access = { token: tokens.accessToken, expiresAt: tokens.accessExpiresAt }
        this.relay = null
        return 'signed-in'
      } catch (error) {
        // Kept nowhere: the new sign-in ends at once rather than linger at the cloud.
        await env.api.revoke(MOBILE_CLIENT, tokens.refreshToken).catch(() => {})
        return error instanceof AccountNetworkError ? 'network' : 'failed'
      }
    } finally {
      this.signingIn = false
      this.emit()
    }
  }

  /**
   * An access token, refreshed when needed; null while signed out, or when none can be had now,
   * as without the network. A sign-in the cloud ended signs out here.
   */
  async accessToken(refused: string | null = null): Promise<string | null> {
    if (!this.stored) return null
    const access = this.access
    if (access && access.token !== refused && access.expiresAt > this.now()) return access.token
    // One refresh at a time: each use of the refresh token replaces it, and a second use of the
    // old one makes the cloud sign this phone out.
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /** Runs `call` with an access token, refreshed once more when the cloud refused it. */
  async withAccess<T>(call: (token: string) => Promise<T>): Promise<T | null> {
    const token = await this.accessToken()
    if (!token) return null
    try {
      return await call(token)
    } catch (error) {
      if (!(error instanceof AccountServiceError) || error.status !== 401) throw error
    }
    const fresh = await this.accessToken(token)
    return fresh ? call(fresh) : null
  }

  /** A relay token, which only the relay takes, for about an hour; null when none can be had. */
  async relayToken(): Promise<string | null> {
    const kept = this.relay
    if (kept && kept.expiresAt - RELAY_MARGIN_MS > this.now()) return kept.token
    const generation = this.generation
    try {
      const issued = await this.withAccess((token) => this.env.api.relayToken(token))
      if (!issued || generation !== this.generation) return null
      this.relay = issued
      return issued.token
    } catch {
      return null
    }
  }

  /** Signs out at the cloud, then forgets the sign-in here, even when the cloud is away. */
  async signOut(): Promise<void> {
    const stored = this.stored
    await this.forget(null)
    if (stored) await this.env.api.revoke(MOBILE_CLIENT, stored.refreshToken).catch(() => {})
  }

  private async refresh(): Promise<string | null> {
    const stored = this.stored
    if (!stored) return null
    const generation = this.generation
    let tokens: TokenSet
    try {
      tokens = await this.env.api.refresh(MOBILE_CLIENT, stored.refreshToken)
    } catch (error) {
      if (generation !== this.generation) return null
      if (error instanceof AccountServiceError && error.code === 'invalid_grant') {
        await this.forget('revoked')
      }
      return null
    }
    if (generation !== this.generation) {
      // Signed out meanwhile: the token just made is ended too.
      await this.env.api.revoke(MOBILE_CLIENT, tokens.refreshToken).catch(() => {})
      return null
    }
    // Kept before it is used: the old refresh token no longer works.
    const next: Stored = { ...stored, refreshToken: tokens.refreshToken }
    this.stored = next
    this.access = { token: tokens.accessToken, expiresAt: tokens.accessExpiresAt }
    await this.env.vault.write(JSON.stringify(next))
    return tokens.accessToken
  }

  private async forget(reason: 'revoked' | null): Promise<void> {
    this.generation++
    this.stored = null
    this.access = null
    this.relay = null
    this.reason = reason
    await this.env.vault.clear().catch(() => {})
    this.emit()
  }

  private emit(): void {
    const status = this.status()
    for (const listener of this.listeners) listener(status)
  }
}
