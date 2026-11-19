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
  const queued = !connected && host.state.kind !== 'stopped' ? '发出的消息会在连上后送达' : null
  return (
    <View
      style={styles.row}
      accessible={!canRetry}
      accessibilityLiveRegion="polite"
      accessibilityLabel={[state, since, queued].filter(Boolean).join('，')}
    >
      <View style={styles.mark}>
        {away ? (
          <View style={[styles.dot, { backgroundColor: c.textTertiary }]} />
        ) : (
          <ActivityIndicator size="small" color={c.textTertiary} />
        )}
      </View>
      {/* Each part on a line of its own, cut short rather than broken: Chinese wraps between any
          two characters, which left the last one of a sentence alone on a line. */}
      <View style={styles.text}>
        <Text style={[typeScale.footnote, { color: c.textTertiary }]} numberOfLines={1}>
          {state}
          {since ? ` · ${since}` : ''}
        </Text>
        {queued ? (
          <Text style={[typeScale.footnote, { color: c.textTertiary }]} numberOfLines={1}>
            {queued}
          </Text>
        ) : null}
      </View>
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
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingTop: space.xs },
  // As tall as the first line, so the spinner or dot stays beside it when a second line shows.
  mark: { height: typeScale.footnote.lineHeight, justifyContent: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4, marginHorizontal: 6 },
  text: { flex: 1 },
})
