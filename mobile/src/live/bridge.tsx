// Keeps the Live Activities and the home-screen widget in step with the paired computer while the
// app runs: the widget's snapshot whenever the session list changes, the app's own activity for the
// session at work (local.ts), and the computer's activities (activities.ts): the tokens it needs,
// handed over with the push target, and the activities nothing will update any more. iOS only;
// elsewhere the module is missing and this does nothing.

import { useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { HuliLive } from '../../modules/huli-live'
import {
  useActiveHost,
  useAgents,
  useConnected,
  useHostActions,
  useHostSelector,
  useListsLoaded,
  useMaybeLink,
  useSessions,
  type HostData,
} from '../host'
import { usePref } from '../prefs'
import { syncPush } from '../push/sync'
import { needsYou } from '../sessions'
import {
  LIVE_SUPPORTED,
  liveSnapshot,
  onLiveChange,
  refreshLive,
  tidyComputerActivities,
  tokensGiven,
} from './activities'
import { syncLocal } from './local'
import { writeWidget } from './widget'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const pickPhase = (d: HostData) => d.phase

/** Whether no session waits for the user, which alone of the sessions the tidying reads. */
const pickNothingWaits = (d: HostData) => {
  for (const s of d.sessions.values()) if (needsYou(s)) return false
  return true
}

export function LiveBridge() {
  const link = useMaybeLink()
  const phase = useHostSelector(pickPhase)
  const sessions = useSessions()
  const nothingWaits = useHostSelector(pickNothingWaits)
  const agents = useAgents()
  const host = useActiveHost()
  const loaded = useListsLoaded()
  const { refresh } = useHostActions()
  const hidePreviews = usePref('hidePreviews')
  const liveActivities = usePref('liveActivities')
  const [foreground, setForeground] = useState(AppState.currentState === 'active')
  const [changes, setChanges] = useState(0)
  /** When the session list was last read in this stay in front; null while it may be old. */
  const freshAt = useRef<number | null>(null)
  const connected = useConnected()
  const enabled = LIVE_SUPPORTED && liveActivities && liveSnapshot().enabled
  const hostName = host?.name ?? null

  useEffect(() => {
    if (!HuliLive) return
    const subscription = HuliLive.addListener('onChange', () => void refreshLive())
    const off = onLiveChange(() => setChanges((n) => n + 1))
    void refreshLive()
    const app = AppState.addEventListener('change', (next) => {
      setForeground(next === 'active')
      // Live Activities may have been allowed or turned off in Settings meanwhile.
      if (next === 'active') void refreshLive()
    })
    return () => {
      subscription.remove()
      off()
      app.remove()
    }
  }, [])

  // In front again, the list is read anew before anything is ended for nothing waiting in it.
  useEffect(() => {
    freshAt.current = null
    if (!LIVE_SUPPORTED || !foreground || !connected) return
    let live = true
    void refresh()
      .then(() => {
        if (live) freshAt.current = Date.now()
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [foreground, connected, refresh])

  useEffect(() => {
    if (!HuliLive) return
    if (phase === 'pair') {
      writeWidget({
        paired: false,
        hostName: null,
        sessions: new Map(),
        agents: new Map(),
        hidden: true,
      })
      return
    }
    if (phase !== 'ready' || !loaded) return
    const timer = setTimeout(
      () =>
        writeWidget({
          paired: true,
          hostName,
          hostId: host?.id,
          sessions,
          agents,
          hidden: hidePreviews,
        }),
      1000,
    )
    return () => clearTimeout(timer)
  }, [phase, loaded, hostName, host?.id, sessions, agents, hidePreviews])

  useEffect(() => {
    if (!LIVE_SUPPORTED) return
    const base = { sessions, agents, hostName, link, foreground, hidden: hidePreviews }
    if (phase === 'pair' || !enabled) {
      syncLocal({ ...base, enabled: false })
      return
    }
    if (phase !== 'ready' || !loaded || !connected) return
    const input = { ...base, enabled: true }
    // A streaming turn changes the sessions many times a second: the activity follows a beat
    // behind, once for each burst, rather than once for each change.
    const soon = setTimeout(() => syncLocal(input), 250)
    const timer = foreground ? setInterval(() => syncLocal(input), 60_000) : null
    return () => {
      clearTimeout(soon)
      if (timer) clearInterval(timer)
    }
  }, [
    phase,
    loaded,
    connected,
    enabled,
    foreground,
    sessions,
    agents,
    hostName,
    link,
    hidePreviews,
    changes,
  ])

  useEffect(() => {
    if (!LIVE_SUPPORTED || !link || !connected || !loaded) return
    let live = true
    const timer = setTimeout(() => {
      void (async () => {
        await tidyComputerActivities({
          enabled,
          nothingWaits: nothingWaits && foreground && freshAt.current !== null,
        })
        for (let attempt = 0; attempt < 3 && live; attempt++) {
          if (await tokensGiven()) break
          await syncPush(link).catch(() => {})
          await wait(1500)
        }
      })()
    }, 1500)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // Not on every change of the sessions: only whether one waits matters here, and each run may
    // ask the computer for the push tokens again.
  }, [link, connected, loaded, enabled, nothingWaits, foreground, changes])

  return null
}
