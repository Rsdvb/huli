// Huli: the account's devices and computers for Settings › Account, read from Huli Cloud with the
// desktop's own sign-in, and signing devices out there. Main holds the token; the renderer only
// names which device, and that name is checked here before it goes anywhere.

import { AccountNetworkError, AccountServiceError } from '@shared/account-api'
import type { AccountDevicesResult, HuliCloudApi, RevokeTarget } from '@shared/huli-cloud'
import { NotSignedIn, type Account } from './account'

const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Which device to sign out, from the renderer: one by its id, or every other. Throws otherwise. */
export function parseRevokeTarget(value: unknown): RevokeTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('A device to sign out must be { device } or { others: true }')
  }
  const keys = Object.keys(value)
  const { device, others } = value as Record<string, unknown>
  if (keys.length === 1 && typeof device === 'string' && DEVICE_ID.test(device)) {
    return { device }
  }
  if (keys.length === 1 && others === true) return { others: true }
  throw new Error('A device to sign out must be { device } or { others: true }')
}

const refused = (error: unknown): boolean =>
  error instanceof AccountServiceError && error.status === 401

export class HuliAccountDevices {
  constructor(
    private readonly account: Pick<Account, 'withAccessToken'>,
    private readonly api: Pick<HuliCloudApi, 'devices' | 'revoke'>,
  ) {}

  async list(): Promise<AccountDevicesResult> {
    try {
      const devices = await this.account.withAccessToken(
        (token) => this.api.devices(token),
        refused,
      )
      return { state: 'ok', devices }
    } catch (error) {
      if (error instanceof NotSignedIn || refused(error)) return { state: 'signed_out' }
      if (!(error instanceof AccountNetworkError)) throw error
      return { state: 'unavailable' }
    }
  }

  /** Signs out what `target` names; how many were. */
  async revoke(target: unknown): Promise<number> {
    const which = parseRevokeTarget(target)
    return this.account.withAccessToken((token) => this.api.revoke(token, which), refused)
  }
}
