// Keeps notifications going while the app runs: syncs them each time the link connects, the
// system changes the push target or the app comes back to the front, where they may have been
// turned on or off in Settings; publishes the link for answers sent from a notification; and lets
// an opened notification go to its session once the paired computer is loaded.

import { useEffect } from 'react'
import { AppState } from 'react-native'
import { useHost } from '../host'
import { publishLink } from './live-link'
import { setOpenReady } from './open'
import { platform } from './platform'
import './responses'
import { syncPush } from './sync'

export function PushBridge() {
  const { link, state, phase } = useHost()

  useEffect(() => {
    publishLink(link)
    return () => publishLink(null)
  }, [link])

  useEffect(() => {
    if (!link || state.kind !== 'connected') return
    const run = (): void => void syncPush(link).catch(() => {})
    run()
    const offTarget = platform.onTargetChange(run)
    const offApp = AppState.addEventListener('change', (next) => {
      if (next === 'active') run()
    })
    return () => {
      offTarget()
      offApp.remove()
    }
  }, [link, state])

  useEffect(() => {
    setOpenReady(phase === 'ready')
    return () => setOpenReady(false)
  }, [phase])

  return null
}
