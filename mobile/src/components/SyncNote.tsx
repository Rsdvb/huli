// A quiet line while what a list shows is not live: connecting, or the cache's copy, and when it
// was last in step with the computer. Nothing while the computer is connected and has answered.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { useHost } from '../host'
import { linkProblem } from '../linkInfo'
import { clockOf, listTime } from '../sessions'
import { space, type as typeScale, useTokens } from '../ui/tokens'

/** When, as the line says it: today's clock, else the day and the clock. */
function when(ms: number): string {
  const day = listTime(ms)
  const clock = clockOf(ms)
  return day === clock ? clock : `${day} ${clock}`
}

export function SyncNote() {
  const { c } = useTokens()
  const host = useHost()
  const connected = host.state.kind === 'connected'
  if (connected && !host.fromCache) return null
  const state = connected ? '正在同步…' : (linkProblem(host.state) ?? '')
  const busy = connected || host.state.kind !== 'stopped'
  const since = host.syncedAt ? `上次同步 ${when(host.syncedAt)}` : null
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={[state, since].filter(Boolean).join('，')}
    >
      {busy ? <ActivityIndicator size="small" color={c.textTertiary} /> : null}
      <Text style={[typeScale.footnote, styles.text, { color: c.textTertiary }]}>
        {state}
        {since ? ` · ${since}` : ''}
        {!connected && host.loaded ? ' · 连上前只能看，不能操作' : ''}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.xs },
  text: { flex: 1 },
})
