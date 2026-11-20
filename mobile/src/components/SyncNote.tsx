// A quiet line while what a list shows is not live: connecting, or the cache's copy, and when it
// was last in step with the computer, with a way to try again once the computer seems away or
// did not answer. Nothing while the computer is connected and has answered. A spinner shows only
// while something is under way, never for a sync that already failed. ListSyncNote says the same of
// a tab's own list.

import { useState } from 'react'
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
  syncFailed: d.syncFailed,
})

export function SyncNote() {
  const host = useHostSelector(pick, sameFields)
  const { retry, refresh } = useHostActions()
  const live = host.state.kind === 'connected'
  // A link down only a moment, as on coming back to the front, says nothing yet.
  const connected = live || !host.down
  if (connected && !host.fromCache) return null
  const away = !connected && host.unreachable
  // Connected, yet the lists are still the cache's: the computer did not answer them in time.
  const failed = live && host.syncFailed
  const state = live
    ? failed
      ? '没能同步'
      : '正在同步…'
    : away
      ? '未连接'
      : (linkProblem(host.state) ?? '')
  const since = host.syncedAt ? `上次同步 ${when(host.syncedAt)}` : null
  const canRetry = failed || (away && host.state.kind !== 'stopped')
  const queued = !connected && host.state.kind !== 'stopped' ? '发出的消息会在连上后送达' : null
  return (
    <NoteRow
      busy={!(away || failed)}
      first={`${state}${since ? ` · ${since}` : ''}`}
      second={queued}
      label={[state, since, queued].filter(Boolean).join('，')}
      retry={
        canRetry
          ? {
              label: failed ? '重试同步' : '重试连接',
              onPress: () => {
                if (failed) void refresh().catch(() => {})
                else retry()
              },
            }
          : null
      }
    />
  )
}

/**
 * Why a page's buttons and switches are greyed while the computer is not connected: 未连接, what
 * waits for the connection, and a retry once the computer seems away. Nothing while connected, or
 * while the link is down only a moment.
 */
export function OfflineNote(props: {
  /** What waits for the connection, after 连上后才能: 「修改这一页」. */
  what: string
}) {
  const host = useHostSelector(pick, sameFields)
  const { retry } = useHostActions()
  if (host.state.kind === 'connected' || !host.down) return null
  const away = host.unreachable
  const state = away ? '未连接' : (linkProblem(host.state) ?? '未连接')
  const second = `连上后才能${props.what}`
  return (
    <NoteRow
      busy={!away && host.state.kind !== 'stopped'}
      first={state}
      second={second}
      label={`${state}，${second}`}
      retry={away && host.state.kind !== 'stopped' ? { label: '重试连接', onPress: retry } : null}
    />
  )
}

/**
 * The same line for a tab's own list, as Artifacts' and 任务's: nothing while the list is current,
 * and once a read of it failed with an older copy still shown, when that copy is from and a retry,
 * which spins while it runs.
 */
export function ListSyncNote(props: {
  error: string | null
  syncedAt: number | null
  onRetry(): Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  if (!props.error) return null
  const state = busy ? '正在同步…' : '没能同步'
  const since = props.syncedAt ? `上次同步 ${when(props.syncedAt)}` : null
  return (
    <NoteRow
      busy={busy}
      first={`${state}${since ? ` · ${since}` : ''}`}
      second={null}
      label={[state, since, busy ? null : props.error].filter(Boolean).join('，')}
      retry={
        busy
          ? null
          : {
              label: '重试同步',
              onPress: () => {
                setBusy(true)
                void props
                  .onRetry()
                  .catch(() => {})
                  .finally(() => setBusy(false))
              },
            }
      }
    />
  )
}

function NoteRow(props: {
  /** Something is under way: a spinner, else a still dot. */
  busy: boolean
  first: string
  second: string | null
  label: string
  retry: { label: string; onPress(): void } | null
}) {
  const { c } = useTokens()
  return (
    <View
      style={styles.row}
      accessible={!props.retry}
      accessibilityLiveRegion="polite"
      accessibilityLabel={props.label}
    >
      <View style={styles.mark}>
        {props.busy ? (
          <ActivityIndicator size="small" color={c.textTertiary} />
        ) : (
          <View style={[styles.dot, { backgroundColor: c.textTertiary }]} />
        )}
      </View>
      {/* Each part on a line of its own, cut short rather than broken: Chinese wraps between any
          two characters, which left the last one of a sentence alone on a line. */}
      <View style={styles.text}>
        <Text style={[typeScale.footnote, { color: c.textTertiary }]} numberOfLines={1}>
          {props.first}
        </Text>
        {props.second ? (
          <Text style={[typeScale.footnote, { color: c.textTertiary }]} numberOfLines={1}>
            {props.second}
          </Text>
        ) : null}
      </View>
      {props.retry ? (
        <Press
          onPress={() => {
            haptic.tap()
            props.retry?.onPress()
          }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={props.retry.label}
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
