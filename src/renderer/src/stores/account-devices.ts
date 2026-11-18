// Huli: the Huli Cloud account's devices and computers for Settings › Account, and signing devices
// out there. Main (or the hosted web client) holds the token; this only reads and asks.

import { create } from 'zustand'
import type { AccountDevicesResult, RevokeTarget } from '@shared/huli-cloud'

interface AccountDevicesState {
  /** Null until read, and where this client has no Huli Cloud account API. */
  result: AccountDevicesResult | null
  loading: boolean
}

export const useAccountDevicesStore = create<AccountDevicesState>(() => ({
  result: null,
  loading: false,
}))

/** Whether this client can list the account's devices at all. */
export function accountDevicesSupported(): boolean {
  return typeof window.kettu.account.devices === 'function'
}

let reading: Promise<void> | null = null

/** Reads the account's devices and computers again, once at a time. */
export function loadAccountDevices(): Promise<void> {
  const devices = window.kettu.account.devices
  if (!devices) return Promise.resolve()
  reading ??= (async () => {
    useAccountDevicesStore.setState({ loading: true })
    try {
      useAccountDevicesStore.setState({ result: await devices() })
    } catch {
      useAccountDevicesStore.setState({ result: { state: 'unavailable' } })
    } finally {
      useAccountDevicesStore.setState({ loading: false })
      reading = null
    }
  })()
  return reading
}

/** Signs out one of the account's devices, or every other, then reads the list again. */
export async function revokeAccountDevice(target: RevokeTarget): Promise<void> {
  const revoke = window.kettu.account.revokeDevice
  if (!revoke) return
  try {
    await revoke(target)
  } finally {
    await loadAccountDevices()
  }
}
