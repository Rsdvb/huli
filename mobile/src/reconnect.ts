// What brings the link to the computer back at once rather than when its backoff says: the app
// coming to the front, the network changing under it, and a notification arriving, which says the
// computer is up and has news.

import { AppState } from 'react-native'
import * as Network from 'expo-network'
import * as Notifications from 'expo-notifications'

export type WakeReason = 'foreground' | 'network' | 'push' | 'retry'

/** Calls `wake` on each of them while the app is in front; returns what stops listening. */
export function watchWakeups(wake: (reason: WakeReason) => void): () => void {
  const inFront = () => AppState.currentState === 'active'
  const app = AppState.addEventListener('change', (status) => {
    if (status === 'active') wake('foreground')
  })
  // A listener may hear the state it started in; only a change of network counts.
  let network: string | null = null
  const seen = (state: Network.NetworkState) =>
    `${state.type}:${String(state.isConnected)}:${String(state.isInternetReachable)}`
  void Network.getNetworkStateAsync().then(
    (state) => {
      network ??= seen(state)
    },
    () => {},
  )
  const net = Network.addNetworkStateListener((state) => {
    const now = seen(state)
    if (now === network) return
    network = now
    if (state.isConnected !== false && inFront()) wake('network')
  })
  const push = Notifications.addNotificationReceivedListener(() => {
    if (inFront()) wake('push')
  })
  return () => {
    app.remove()
    net.remove()
    push.remove()
  }
}
