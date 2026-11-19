// Accounts for the tests, made through the store's own ways in: the owner as `init` makes it, any
// other through an invite, as signing up does.

import type { Account, Credentials, Store } from '../src/store'

/** Credentials no sign-in in these tests checks. */
export const CREDENTIALS: Credentials = {
  password: 'scrypt$unused',
  totp: 'unused',
  totpLastStep: -1,
  recovery: [],
}

export function makeOwner(store: Store, credentials: Credentials = CREDENTIALS): Account {
  return store.setOwner({ username: 'owner', email: 'me@example.com', name: 'Me', credentials })
}

export function makeMember(
  store: Store,
  username: string,
  credentials: Credentials = CREDENTIALS,
): Account {
  const made = store.createInvite(7)
  if (!made) throw new Error('no invite')
  const result = store.redeemInvite(made.invite.id, username, credentials)
  if (!result.ok) throw new Error(result.reason)
  return result.account
}
