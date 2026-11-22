// What happened in a session while the user was away from it, as the desktop's thread shows it
// (@shared/recap): a solid bar under the session's header, worked out when the session comes back
// into view after a while away, from where this phone last saw it. Time the session spends on
// screen with the app in front counts as seen. Nothing runs in between.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Platform, Pressable, Settings, StyleSheet, Text, View } from 'react-native'
import {
  NOT_VISITED,
  RECAP_AWAY_MS,
  recapStep,
  type Recap,
  type RecapEvent,
  type RecapVisit,
} from '@shared/recap'
import type { ThreadState } from '@shared/thread'
import { devMode } from '../dev/devMode'
import { markSeen, seenMark } from '../seen'
import { useSelector, type Store } from '../select'
import type { ThreadView } from '../thread'
import { Glass } from '../ui/Glass'
import { haptic } from '../ui/session/feedback'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'

const LEAD = '你离开期间：'

/** A count, as "16+" where the recap could not see back to where the user left. */
const count = (n: number, partial: boolean): string => (partial ? `${n}+` : `${n}`)

/** What changed, ran and asked, then the latest reply, without the lead. */
function recapParts(recap: Recap): string {
  const { partial } = recap
  const parts: string[] = []
  if (recap.files > 0) {
    const lines =
      !partial && recap.added + recap.removed > 0 ? `（+${recap.added} −${recap.removed}）` : ''
    parts.push(`改了 ${count(recap.files, partial)} 个文件${lines}`)
  }
  if (recap.commands > 0) parts.push(`跑了 ${count(recap.commands, partial)} 条命令`)
  if (recap.approvals > 0) {
    const asked = `${count(recap.approvals, partial)} 次需要你批准`
    parts.push(recap.waiting > 0 ? `${asked}，${recap.waiting} 个还在等你` : asked)
  }
  if (recap.errors > 0) parts.push(`出了 ${count(recap.errors, partial)} 次错`)
  if (recap.reply) parts.push(`最后回复：${recap.reply}`)
  return parts.join('，')
}

export function recapText(recap: Recap): string {
  return `${LEAD}${recapParts(recap)}`
}

/**
 * How long counts as away: half an hour, or for the simulator scripts the milliseconds a developer
 * build's `-huliRecapAwayMs` launch argument gives, which a phone's user cannot pass.
 */
function awayMs(): number {
  if (!devMode() || Platform.OS !== 'ios') return RECAP_AWAY_MS
  const given = Number(Settings.get('huliRecapAwayMs'))
  return Number.isFinite(given) && given > 0 ? given : RECAP_AWAY_MS
}

/** The latest message the user sent, whose change, a new one, puts the recap away. */
function lastSent(thread: ThreadState): string | null {
  for (let i = thread.order.length - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind === 'user' && !entry.approval) return entry.id
  }
  return null
}

/**
 * The session's recap, when the user comes back to it after a while, and `done` for when they
 * are done with it. The session is in view while its screen is in front (`focused`) and the app
 * is not in the background; it leaves view otherwise, and each leave marks it seen.
 */
export function useRecap(
  computer: string | null,
  sessionId: string,
  view: ThreadView,
  thread: ThreadState | null,
  focused: boolean,
): { recap: Recap | null; done: () => void } {
  const [recap, setRecap] = useState<Recap | null>(null)
  // Null until this phone's mark for the session is read.
  const visit = useRef<RecapVisit | null>(null)
  const latest = useRef({ view, focused })
  useEffect(() => {
    latest.current = { view, focused }
  })
  const sentAtRecap = useRef<string | null>(null)
  // Back from the background: the read count then, as the next read holds what happened since.
  const awaiting = useRef<number | null>(null)

  const step = useCallback(
    (event: RecapEvent) => {
      const was = visit.current
      const now = latest.current.view.store.get()
      if (!computer || !was || !now) return
      const next = recapStep(was, event, now, {
        now: Date.now(),
        older: latest.current.view.hasOlder,
        awayMs: awayMs(),
      })
      if (next === was) return
      visit.current = next
      if (next.mark && next.mark !== was.mark) markSeen(computer, sessionId, next.mark)
      if (next.shown !== was.shown) {
        sentAtRecap.current = lastSent(now)
        setRecap(next.shown)
      }
    },
    [computer, sessionId],
  )

  // Opened: once the computer's copy of the thread is in, not the cache's from an earlier visit,
  // and this phone's mark is read.
  const ready = computer !== null && thread !== null && !view.cached
  useEffect(() => {
    if (!ready || !computer || visit.current) return
    let current = true
    void seenMark(computer, sessionId).then((mark) => {
      if (!current || visit.current) return
      visit.current = { ...NOT_VISITED, mark }
      if (latest.current.focused && AppState.currentState !== 'background') step('view')
    })
    return () => {
      current = false
    }
  }, [ready, computer, sessionId, step])

  // In view while the screen is in front and the app is not in the background. A screen over it,
  // or the app going to the background, leaves; an overlay of the system's that keeps the app
  // inactive, as Control Center, does not.
  useEffect(() => {
    if (!focused) return
    // Back from a screen over it, the thread having kept up meanwhile.
    step('view')
    let away = false
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        away = true
        awaiting.current = null
        step('leave')
      } else if (state === 'active' && away) {
        away = false
        // The session was let go in the background and is read afresh now.
        awaiting.current = latest.current.view.reads
      }
    })
    return () => {
      subscription.remove()
      awaiting.current = null
      step('leave')
    }
  }, [focused, step])

  useEffect(() => {
    if (awaiting.current === null || view.reads === awaiting.current) return
    awaiting.current = null
    step('view')
  }, [view.reads, step])

  // Another session or computer starts a visit of its own, after the leave above marked this one.
  useEffect(
    () => () => {
      visit.current = null
      setRecap(null)
    },
    [computer, sessionId],
  )

  // A message sent is done with the recap too.
  const sentNow = recap && thread ? lastSent(thread) : null
  useEffect(() => {
    if (recap && sentNow !== sentAtRecap.current) step('done')
  }, [recap, sentNow, step])

  const done = useCallback(() => step('done'), [step])
  return { recap, done }
}

/** The recap on show and what the user can do with it, for the bar the session screen draws. */
export interface RecapShown {
  recap: Recap
  jump(): void
  dismiss(): void
}

// Between the bar and the conversation's first row when the thread is scrolled to its top.
const GAP = 8

/**
 * The recap as a solid bar under the session's header and what floats under it. It is never over
 * the conversation's words: the screen makes room for it at the top of the conversation and the
 * header's scroll edge reaches under it. `onRoom`: the height it takes, with its gap.
 */
export function RecapBar(props: {
  slot: Store<RecapShown | null>
  top: number
  onRoom(room: number): void
}) {
  const shown = useSelector(props.slot, (value) => value)
  const { c } = useSessionTokens()
  const { onRoom } = props
  if (!shown) return null
  const parts = recapParts(shown.recap)
  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { top: props.top }]}
      onLayout={(event) => onRoom(Math.ceil(event.nativeEvent.layout.height) + GAP)}
      accessibilityLiveRegion="polite"
    >
      <Glass shape="rounded" radius={16} elevated style={styles.line}>
        <Pressable
          onPress={() => {
            haptic.tap()
            shown.jump()
          }}
          accessibilityRole="button"
          accessibilityLabel={`${LEAD}${parts}。跳到离开处`}
          style={({ pressed }) => [styles.body, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Text style={[styles.text, { color: c.textSecondary }]} numberOfLines={2}>
            <Text style={[styles.lead, { color: c.text }]}>{LEAD}</Text>
            {parts}
          </Text>
          <View style={styles.jump}>
            <Icon icon={G.send} size={11} color={c.tint} weight="semibold" />
            <Text style={[styles.jumpText, { color: c.tint }]}>跳到离开处</Text>
          </View>
        </Pressable>
        <Pressable
          onPress={shown.dismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="关闭离开期间的摘要"
          style={({ pressed }) => [styles.close, { opacity: pressed ? 0.5 : 1 }]}
        >
          <Icon icon={G.close} size={11} color={c.textTertiary} weight="semibold" />
        </Pressable>
      </Glass>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 14, right: 14, alignItems: 'center' },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: 560,
    paddingLeft: 12,
    paddingRight: 4,
  },
  body: { flexShrink: 1, paddingVertical: 8, gap: 4 },
  text: { fontSize: 13, lineHeight: 18 },
  lead: { fontWeight: '600' },
  jump: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  jumpText: { fontSize: 13, fontWeight: '600' },
  close: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
})
