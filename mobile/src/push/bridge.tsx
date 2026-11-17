// Keeps notifications going while the app runs: syncs them each time the link connects, the
// system changes the push target or the app comes back to the front, where they may have been
// turned on or off in Settings; and takes an opened notification to its session.

import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { router } from 'expo-router'
import { useHost } from '../host'
import { platform } from './platform'
import { syncPush } from './sync'
import type { OpenedNotification } from './types'

export function PushBridge() {
  const { link, state, phase } = useHost()
  const waiting = useRef<OpenedNotification | null>(null)

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
    // A notification that launched the app waits until the paired computer is loaded.
    const go = (): void => {
      const opened = waiting.current
      if (!opened || phase !== 'ready') return
      waiting.current = null
      if (opened.sessionId) {
        router.push({ pathname: '/session/[id]', params: { id: opened.sessionId } })
      }
    }
    const off = platform.onOpen((opened) => {
      waiting.current = opened
      go()
    })
    go()
    return off
  }, [phase])

  return null
}
