// Huli: whether a host has the recycle bin, as its info says (`HostInfo.recycleBin`). This
// computer's desktop app always has it; another host, or the web client's own, only once its info
// says so. Until then, and for a host older than the bin, deletes are described and done as for
// good: nothing promises a restore that host cannot give.

import { binSupported } from '@shared/recycle-bin'
import { isWeb } from '@renderer/lib/platform'
import { hostScope } from '@renderer/stores/host-scope'
import { useWebHostStore } from '@renderer/stores/web-host'

/** Whether deleting on the host `hostId` (null for this computer) moves things to the bin, now. */
export function hostHasBin(hostId: string | null): boolean {
  if (hostId === null) return isWeb ? binSupported(useWebHostStore.getState().info) === true : true
  return binSupported(hostScope(hostId).useInfoStore.getState().info) === true
}

/** `hostHasBin`, following the host's info as it arrives. */
export function useHostHasBin(hostId: string | null): boolean {
  const store = hostId === null ? useWebHostStore : hostScope(hostId).useInfoStore
  const known = store((s) => binSupported(s.info))
  return hostId === null && !isWeb ? true : known === true
}
