import { describe, expect, it } from 'vitest'
import type { HostInfo } from './remote/host-admin'
import { binSupported } from './recycle-bin'

const info = (extra: Partial<HostInfo>) =>
  ({
    sharing: true,
    updates: true,
    remoteSwitch: true,
    remoteReset: true,
    thumbnails: true,
    ...extra,
  }) as HostInfo

describe('Huli: whether a host has the recycle bin', () => {
  it("is known only from the host's own info, which says it", () => {
    expect(binSupported(info({ recycleBin: true }))).toBe(true)
  })

  it('counts a host older than the bin, which says nothing of it, as deleting for good', () => {
    expect(binSupported(info({}))).toBe(false)
    expect(binSupported(info({ recycleBin: false }))).toBe(false)
    // Anything but true from a host that misbehaves promises no restore either.
    expect(binSupported({ recycleBin: 'yes' })).toBe(false)
    expect(binSupported({ recycleBin: 1 })).toBe(false)
  })

  it('is unknown until the host has said anything', () => {
    expect(binSupported(null)).toBeNull()
    expect(binSupported(undefined)).toBeNull()
  })
})
