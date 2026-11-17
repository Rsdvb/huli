// Keeps notifications going while the app runs: syncs them each time the link connects, the
// system changes the push target or the app comes back to the front, where they may have been
// turned on or off in Settings; and publishes the active computer's link for answers sent from a
// notification. Presses on notifications are taken by responses.ts, which it loads: a tap opens
// through src/links.ts, on the computer that sent it.

import { useEffect } from 'react'
import { AppState } from 'react-native'
import { useHost } from '../host'
import { publishLink } from './live-link'
import { platform } from './platform'
import './responses'
import { resetPushStatus, syncPush } from './sync'

export function PushBridge() {
  const { link, state, notePushId, host, computers } = useHost()

  useEffect(() => {
    resetPushStatus()
  }, [link])

  useEffect(() => {
    publishLink(link ? { link, active: host, computers } : null)
  }, [link, host, computers])

  useEffect(() => () => publishLink(null), [])

  useEffect(() => {
    if (!link || state.kind !== 'connected') return
    const run = (): void =>
      void syncPush(link)
        .then((id) => {
          if (id) notePushId(id)
        })
        .catch(() => {})
    run()
    const offTarget = platform.onTargetChange(run)
    const offApp = AppState.addEventListener('change', (next) => {
      if (next === 'active') run()
    })
    return () => {
      offTarget()
      offApp.remove()
    }
    // notePushId reads the active computer when it runs; a new one each render is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, state])

  return null
}
