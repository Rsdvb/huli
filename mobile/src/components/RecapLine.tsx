// What happened in a session while the user was away from it, as one quiet line over the top of
// the conversation, as the desktop's thread shows it (@shared/recap): worked out once when the
// screen opens on the computer's copy of the thread, and again when the app comes back to the
// front after a while, from where this phone last saw the session. Nothing runs in between.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Platform, Pressable, Settings, StyleSheet, Text, View } from 'react-native'
import { RECAP_AWAY_MS, recapSince, type Recap } from '@shared/recap'
import type { ThreadState } from '@shared/thread'
import { devMode } from '../dev/devMode'
import { loadSeen, markSeen } from '../seen'
import type { ThreadView } from '../thread'
import { haptic } from '../ui/session/feedback'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'

/** The recap as the line reads it: what changed, ran and asked, then the latest reply. */
export function recapText(recap: Recap): string {
  const parts: string[] = []
  if (recap.files > 0) {
    const lines = recap.added + recap.removed > 0 ? `（+${recap.added} −${recap.removed}）` : ''
    parts.push(`改了 ${recap.files} 个文件${lines}`)
  }
  if (recap.commands > 0) parts.push(`跑了 ${recap.commands} 条命令`)
  if (recap.approvals > 0) {
    parts.push(
      recap.waiting > 0
        ? `${recap.approvals} 次需要你批准，${recap.waiting} 个还在等你`
        : `${recap.approvals} 次需要你批准`,
    )
  }
  if (recap.errors > 0) parts.push(`出了 ${recap.errors} 次错`)
  if (recap.reply) parts.push(`最后回复：${recap.reply}`)
  return `${recap.partial ? '你离开期间至少：' : '你离开期间：'}${parts.join('，')}`
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

/** The latest message the user sent, whose change, a new one, ends the recap. */
function lastSent(thread: ThreadState): string | null {
  for (let i = thread.order.length - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind === 'user' && !entry.approval) return entry.id
  }
  return null
}

const lastEntry = (thread: ThreadState): string | null => thread.order.at(-1) ?? null

/**
 * The session's recap, if the user comes back to it after a while, and a way to put it away.
 * `focused`: the screen is in front, not covered by another.
 */
export function useRecap(
  computer: string | null,
  sessionId: string,
  view: ThreadView,
  thread: ThreadState | null,
  focused: boolean,
): { recap: Recap | null; dismiss: () => void } {
  const [shown, setShown] = useState<{ recap: Recap; sent: string | null } | null>(null)
  const latest = useRef({ thread, older: view.hasOlder })
  useEffect(() => {
    latest.current = { thread, older: view.hasOlder }
  })
  const opened = useRef(false)
  // Back in front after leaving: the thread the recap waits for, which the computer's next copy
  // replaces; nothing coming means nothing happened.
  const waitingFor = useRef<ThreadState | null | undefined>(undefined)

  const work = useCallback(
    (now: ThreadState) => {
      if (!computer) return
      void loadSeen(computer).then((marks) => {
        const found = recapSince(now, marks[sessionId] ?? null, {
          now: Date.now(),
          older: latest.current.older,
          awayMs: awayMs(),
        })
        if (found) setShown({ recap: found, sent: lastSent(now) })
        markSeen(computer, sessionId, lastEntry(now))
      })
    },
    [computer, sessionId],
  )

  // Opened: once the computer's copy of the thread is in, not the cache's from an earlier visit.
  const ready = thread !== null && !view.cached
  useEffect(() => {
    const now = latest.current.thread
    if (!ready || !now || opened.current) return
    opened.current = true
    work(now)
  }, [ready, work])

  useEffect(() => {
    const now = waitingFor.current
    if (now === undefined || !thread || thread === now) return
    waitingFor.current = undefined
    work(thread)
  }, [thread, work])

  // Left: the screen goes or is covered, or the app leaves the front.
  useEffect(() => {
    if (!computer) return
    const leave = (): void => {
      const now = latest.current.thread
      if (now && opened.current) markSeen(computer, sessionId, lastEntry(now))
    }
    const back = (): void => {
      if (opened.current) waitingFor.current = latest.current.thread
    }
    if (!focused) {
      leave()
      return back
    }
    const listener = AppState.addEventListener('change', (state) =>
      state === 'active' ? back() : leave(),
    )
    return () => {
      listener.remove()
      leave()
    }
  }, [computer, sessionId, focused])

  const sentNow = shown && thread ? lastSent(thread) : null
  const recap = shown && sentNow === shown.sent ? shown.recap : null
  const dismiss = useCallback(() => setShown(null), [])
  return { recap, dismiss }
}

export function RecapLine(props: { recap: Recap; top: number; onJump(): void; onDismiss(): void }) {
  const { c } = useSessionTokens()
  const text = recapText(props.recap)
  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { top: props.top }]}
      accessibilityLiveRegion="polite"
    >
      <View
        style={[
          styles.line,
          { backgroundColor: c.surfaceRaised, borderColor: c.border, shadowColor: c.shadow },
        ]}
      >
        <Pressable
          onPress={() => {
            haptic.tap()
            props.onJump()
          }}
          accessibilityRole="button"
          accessibilityLabel={`${text}。跳到离开处`}
          style={({ pressed }) => [styles.body, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Text style={[styles.text, { color: c.textSecondary }]} numberOfLines={2}>
            {text}
          </Text>
          <View style={styles.jump}>
            <Icon icon={G.send} size={11} color={c.tint} weight="semibold" />
            <Text style={[styles.jumpText, { color: c.tint }]}>跳到离开处</Text>
          </View>
        </Pressable>
        <Pressable
          onPress={props.onDismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="关闭离开期间的摘要"
          style={({ pressed }) => [styles.close, { opacity: pressed ? 0.5 : 1 }]}
        >
          <Icon icon={G.close} size={11} color={c.textTertiary} weight="semibold" />
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 14, right: 14, alignItems: 'center' },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: 560,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 12,
    paddingRight: 4,
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  body: { flexShrink: 1, paddingVertical: 8, gap: 4 },
  text: { fontSize: 13, lineHeight: 18 },
  jump: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  jumpText: { fontSize: 13, fontWeight: '600' },
  close: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
})
