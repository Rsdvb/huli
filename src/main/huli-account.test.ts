import { describe, expect, it, vi } from 'vitest'
import { AccountNetworkError, AccountServiceError } from '@shared/account-api'
import type { AccountDevices } from '@shared/huli-cloud'
import { NotSignedIn } from './account'
import { HuliAccountDevices, parseRevokeTarget } from './huli-account'

const EMPTY: AccountDevices = { devices: [], computers: [] }

function setup(signedIn = true) {
  const api = {
    devices: vi.fn<(token: string) => Promise<AccountDevices>>(async () => EMPTY),
    revoke: vi.fn<(token: string, which: unknown) => Promise<number>>(async () => 1),
  }
  const account = {
    withAccessToken: async <T>(call: (token: string) => Promise<T>) => {
      if (!signedIn) throw new NotSignedIn()
      return call('token')
    },
  }
  return { api, devices: new HuliAccountDevices(account, api) }
}

describe("the account's devices from the renderer", () => {
  it('takes one device by its id, or every other, and nothing else', () => {
    expect(parseRevokeTarget({ device: 'abc_DEF-123' })).toEqual({ device: 'abc_DEF-123' })
    expect(parseRevokeTarget({ others: true })).toEqual({ others: true })
    for (const bad of [
      null,
      'abc',
      [],
      {},
      { device: '' },
      { device: 'a/b' },
      { device: 'x'.repeat(65) },
      { device: 7 },
      { others: 'yes' },
      { others: true, device: 'abc' },
      { device: 'abc', extra: 1 },
    ]) {
      expect(() => parseRevokeTarget(bad)).toThrow()
    }
  })

  it('never asks the cloud with a target it refused', async () => {
    const t = setup()
    await expect(t.devices.revoke({ device: '../revoke' })).rejects.toThrow()
    expect(t.api.revoke).not.toHaveBeenCalled()
    expect(await t.devices.revoke({ others: true })).toBe(1)
    expect(t.api.revoke).toHaveBeenCalledWith('token', { others: true })
  })

  it('says signed out or unavailable rather than failing the page', async () => {
    expect(await setup(false).devices.list()).toEqual({ state: 'signed_out' })
    const away = setup()
    away.api.devices.mockRejectedValueOnce(new AccountNetworkError('offline'))
    expect(await away.devices.list()).toEqual({ state: 'unavailable' })
    const refused = setup()
    refused.api.devices.mockRejectedValueOnce(new AccountServiceError('unauthorized', 'no', 401))
    expect(await refused.devices.list()).toEqual({ state: 'signed_out' })
    expect(await setup().devices.list()).toEqual({ state: 'ok', devices: EMPTY })
  })
})
