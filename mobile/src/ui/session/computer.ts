// The paired computer as the status line names it: its name and its system, which the host says
// only while connected and which is kept here for the moments between connections.

import { useHost } from '../../host'

let lastPlatform: string | null = null

export function useComputer(): { name: string; platform: string | null } {
  const { host, state } = useHost()
  if (state.kind === 'connected') lastPlatform = state.welcome.host.platform
  const name = state.kind === 'connected' ? state.welcome.host.name : (host?.name ?? '电脑')
  return { name, platform: lastPlatform }
}
