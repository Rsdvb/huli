// Accounts for the tests, made through the store's own ways in: the owner as `init` makes it, any
// other through an invite, as signing up does; and signing in as a person does on the pages.

import { passwordOnly, type Account, type Credentials, type Store } from '../src/store'

/** Credentials no sign-in in these tests checks: the owner's, with a TOTP secret as `init` sets. */
export const CREDENTIALS: Credentials = {
  password: 'scrypt$unused',
  totp: 'unused',
  totpLastStep: -1,
  recovery: [],
}

export function makeOwner(store: Store, credentials: Credentials = CREDENTIALS): Account {
  return store.setOwner({ username: 'owner', email: 'me@example.com', name: 'Me', credentials })
}

/** Another account, with a password alone unless `credentials` say otherwise, as signing up. */
export function makeMember(
  store: Store,
  username: string,
  credentials: Credentials = passwordOnly(CREDENTIALS.password),
): Account {
  const made = store.createInvite(7)
  if (!made) throw new Error('no invite')
  const result = store.redeemInvite(made.invite.id, username, credentials)
  if (!result.ok) throw new Error(result.reason)
  return result.account
}

/** The id of the code step a page carries; null on any other page. */
export function stepOf(html: string): string | null {
  return /name="step" value="([^"]+)"/.exec(html)?.[1] ?? null
}

/**
 * A sign-in form posted as a person fills it in: the password, and then, if the page that comes
 * back asks for one, `code`. The last answer.
 */
export async function signInSteps(
  post: (fields: Record<string, string>) => Promise<Response>,
  fields: Record<string, string>,
  code: string,
): Promise<Response> {
  const first = await post(fields)
  const step = first.status === 200 ? stepOf(await first.clone().text()) : null
  if (!step) return first
  const { ticket, next } = fields
  return post({
    ...(ticket === undefined ? {} : { ticket }),
    ...(next === undefined ? {} : { next }),
    step,
    action: 'code',
    code,
  })
}
