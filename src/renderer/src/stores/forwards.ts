// Huli: the ports of other hosts forwarded to this computer, as main keeps them, and the hosts
// whose sessions' terminals forward the dev servers they print by themselves. That watch follows
// the terminals' store only while some host has it on, so it costs nothing otherwise.

import { create } from 'zustand'
import { loopbackPort, type PortForward } from '@shared/port-forwards'
import { entryShown } from '@renderer/lib/features'
import { useSettingsStore } from '@renderer/stores/settings'
import { hostOfPath } from '@renderer/lib/host-paths'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useTerminalsStore } from '@renderer/stores/terminals'

const AUTO_KEY = 'ports.autoForward'

interface ForwardsStore {
  forwards: PortForward[]
  /** The hosts whose sessions' terminals forward the addresses they print. */
  auto: Record<string, true>
}

function keptAuto(): Record<string, true> {
  const kept = readJson<unknown>(AUTO_KEY, [])
  const ids = Array.isArray(kept) ? kept.filter((id): id is string => typeof id === 'string') : []
  return Object.fromEntries(ids.map((id) => [id, true as const]))
}

export const useForwardsStore = create<ForwardsStore>()(() => ({ forwards: [], auto: keptAuto() }))

/** What a new address in a terminal is forwarded as; set by the ports feature, which toasts. */
type AutoForward = (hostId: string, port: number, sessionId: string, url: string) => void

let autoForward: AutoForward | null = null
let unwatch: (() => void) | null = null
/** Each terminal's address last forwarded, so a reprint does not forward it again. */
const forwarded = new Map<string, string>()

function watchTerminals(): void {
  const on =
    Object.keys(useForwardsStore.getState().auto).length > 0 && entryShown('terminal.openOnHost')
  if (!on) {
    unwatch?.()
    unwatch = null
    forwarded.clear()
    return
  }
  if (unwatch) return
  unwatch = useTerminalsStore.subscribe((state, previous) => {
    if (state.byId === previous.byId) return
    const { auto } = useForwardsStore.getState()
    for (const [id, terminal] of Object.entries(state.byId)) {
      const url = terminal.localUrl
      if (!url || url === previous.byId[id]?.localUrl || forwarded.get(id) === url) continue
      const hostId = hostOfPath(terminal.projectPath)
      const port = loopbackPort(url)
      if (!hostId || !auto[hostId] || !terminal.sessionId || port === null) continue
      forwarded.set(id, url)
      autoForward?.(hostId, port, terminal.sessionId, url)
    }
  })
}

/** Follows main's forwards, and the terminals of the hosts that forward on their own. */
export function initForwards(forward: AutoForward): void {
  autoForward = forward
  window.kettu.hosts.onForwards((forwards) => {
    loaded = true
    useForwardsStore.setState({ forwards })
  })
  watchTerminals()
  // Huli: port forwarding turned off or on in Settings > Features stops or starts the watch.
  useSettingsStore.subscribe((state, previous) => {
    if (state.settings.features !== previous.settings.features) watchTerminals()
  })
}

let loaded = false

/** Reads main's forwards once, when a view that shows them first opens; events keep them after. */
export function loadForwards(): void {
  if (loaded) return
  loaded = true
  void window.kettu.hosts
    .forwards()
    .then((forwards) => useForwardsStore.setState({ forwards }))
    .catch(() => {
      loaded = false
    })
}

export function setAutoForward(hostId: string, on: boolean): void {
  const auto = { ...useForwardsStore.getState().auto }
  if (on) auto[hostId] = true
  else delete auto[hostId]
  useForwardsStore.setState({ auto })
  writeJson(AUTO_KEY, Object.keys(auto))
  watchTerminals()
}
