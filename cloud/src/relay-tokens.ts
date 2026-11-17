// The tokens the relay takes: a signed-in client's access token, or a relay token made from one on
// POST /api/v1/relay/token. A relay token can do nothing but reach the relay, lapses within the
// hour, and is signed with a key of the service's own (HMAC-SHA256), so it outlives a restart and
// needs nothing stored; it is taken only while the client it was made for is still signed in.

import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { sameText } from './secrets'
import type { Store } from './store'

export const RELAY_TOKEN_TTL_MS = 60 * 60 * 1000
const PREFIX = 'hr1.'
const KEY_FILE = 'relay-token.key'
const KEY_BYTES = 32
const FAMILY = /^[A-Za-z0-9_-]{1,64}$/

/** Who a token the relay took belongs to: the account, the signed-in client, and its end. */
export interface RelayGrant {
  account: string
  family: string
  expiresAt: number
}

/** The service's own key for relay tokens, made on first start and kept with its data. */
export function loadRelayTokenKey(dataDir: string): Buffer {
  const file = path.join(dataDir, KEY_FILE)
  try {
    const key = readFileSync(file)
    if (key.length === KEY_BYTES) return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const key = randomBytes(KEY_BYTES)
  writeFileSync(file, key, { mode: 0o600 })
  return key
}

export class RelayTokens {
  constructor(
    private readonly store: Store,
    private readonly key: Buffer,
    private readonly now: () => number = Date.now,
  ) {}

  /** A relay token for a signed-in client. */
  issue(family: string): { token: string; expiresAt: number } {
    const expiresAt = this.now() + RELAY_TOKEN_TTL_MS
    const body = Buffer.from(`${family}.${expiresAt}`, 'utf8').toString('base64url')
    return { token: `${PREFIX}${body}.${this.mac(body)}`, expiresAt }
  }

  /** What a relay token or an access token grants, or null for one the relay must refuse. */
  check(token: string): RelayGrant | null {
    const account = this.store.account?.id
    if (!account || token.length > 4096) return null
    if (!token.startsWith(PREFIX)) {
      const entry = this.store.accessEntry(token)
      return entry ? { account, family: entry.family.id, expiresAt: entry.expiresAt } : null
    }
    const [body, mac, extra] = token.slice(PREFIX.length).split('.')
    if (!body || !mac || extra !== undefined || !sameText(mac, this.mac(body))) return null
    const [family, expires] = Buffer.from(body, 'base64url').toString('utf8').split('.')
    const expiresAt = Number(expires)
    if (!family || !FAMILY.test(family) || !Number.isSafeInteger(expiresAt)) return null
    if (expiresAt <= this.now() || !this.store.hasFamily(family)) return null
    return { account, family, expiresAt }
  }

  /** Whether a grant taken before still holds: its client signed in, its token not long lapsed. */
  holds(grant: RelayGrant, graceMs: number): boolean {
    return (
      this.store.account?.id === grant.account &&
      this.store.hasFamily(grant.family) &&
      grant.expiresAt + graceMs > this.now()
    )
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(`${PREFIX}${body}`).digest('base64url')
  }
}
