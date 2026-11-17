// A quiet line while what a list shows is not live: connecting, or the cache's copy, and when it
// was last in step with the computer, with a way to try again once the computer seems away.
// Nothing while the computer is connected and has answered.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { sameFields, useHostActions, useHostSelector, type HostData } from '../host'
import { linkProblem } from '../linkInfo'
import { clockOf, listTime } from '../sessions'
import { haptic } from '../ui/haptics'
import { Press } from '../ui/Press'
import { space, type as typeScale, useTokens } from '../ui/tokens'

/** When, as the line says it: today's clock, else the day and the clock. */
function when(ms: number): string {
  const day = listTime(ms)
  const clock = clockOf(ms)
  return day === clock ? clock : `${day} ${clock}`
}

const pick = (d: HostData) => ({
  state: d.state,
  fromCache: d.fromCache,
  unreachable: d.unreachable,
  syncedAt: d.syncedAt,
  down: d.down,
})

export function SyncNote() {
  const { c } = useTokens()
  const host = useHostSelector(pick, sameFields)
  const { retry } = useHostActions()
  // A link down only a moment, as on coming back to the front, says nothing yet.
  const connected = host.state.kind === 'connected' || !host.down
  if (connected && !host.fromCache) return null
  const away = !connected && host.unreachable
  const state = connected ? '正在同步…' : away ? '未连接' : (linkProblem(host.state) ?? '')
  const since = host.syncedAt ? `上次同步 ${when(host.syncedAt)}` : null
  const canRetry = away && host.state.kind !== 'stopped'
  return (
    <View
      style={styles.row}
      accessible={!canRetry}
      accessibilityLiveRegion="polite"
      accessibilityLabel={[state, since].filter(Boolean).join('，')}
    >
      {away ? (
        <View style={[styles.dot, { backgroundColor: c.textTertiary }]} />
      ) : (
        <ActivityIndicator size="small" color={c.textTertiary} />
      )}
      <Text style={[typeScale.footnote, styles.text, { color: c.textTertiary }]}>
        {state}
        {since ? ` · ${since}` : ''}
        {!connected ? ' · 连上前只能看' : ''}
      </Text>
      {canRetry ? (
        <Press
          onPress={() => {
            haptic.tap()
            retry()
          }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="重试连接"
        >
          <Text style={[typeScale.footnote, { color: c.tint, fontWeight: '600' }]}>重试</Text>
        </Press>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.xs },
  dot: { width: 7, height: 7, borderRadius: 4, marginHorizontal: 6 },
  text: { flex: 1 },
})
