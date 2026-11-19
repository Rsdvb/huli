// While a turn runs and nothing is being written: a softly pulsing line with how long it has run,
// what it has added to the context and what it does now.
// And the button that brings a scrolled-up conversation back to its newest message.

import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native'
import { useIsFocused } from 'expo-router'
import { G, Icon } from './icons'
import { compactCount, durationText } from './work'
import { GlassButton } from '../Glass'
import { useSessionTokens } from './palette'

function usePulse(): Animated.Value {
  const value = useRef(new Animated.Value(0.7)).current
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null
    let live = true
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (!live) return
      if (reduce) {
        value.setValue(0.8)
        return
      }
      const step = (toValue: number) =>
        Animated.timing(value, {
          toValue,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        })
      loop = Animated.loop(Animated.sequence([step(1), step(0.7)]))
      loop.start()
    })
    return () => {
      live = false
      loop?.stop()
    }
  }, [value])
  return value
}

// The grid at 15 points: dots of 4 with gaps of 1.5, scaled for another size.
const gapOf = (size: number) => (size * 1.5) / 15
const dotOf = (size: number) => {
  const side = (size * 4) / 15
  return { width: side, height: side, borderRadius: side / 2 }
}

/**
 * A three by three grid of dots a wave of light runs across while the agent works, on the native
 * driver; it rests while its screen is covered by another, and holds still under Reduce Motion.
 */
export function WorkingDots(props: { color: string; size?: number }) {
  const wave = useRef(new Animated.Value(0)).current
  const [still, setStill] = useState(false)
  const focused = useIsFocused()
  useEffect(() => {
    if (!focused) return
    let loop: Animated.CompositeAnimation | null = null
    let live = true
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (!live) return
      if (reduce) return setStill(true)
      // From the start of the wave, as a loop stopped midway would repeat only its rest.
      wave.setValue(0)
      loop = Animated.loop(
        Animated.timing(wave, {
          toValue: 1,
          duration: 1400,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      )
      loop.start()
    })
    return () => {
      live = false
      loop?.stop()
    }
  }, [wave, focused])
  return (
    <View
      style={[
        styles.dots,
        props.size ? { width: props.size, height: props.size, gap: gapOf(props.size) } : null,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {Array.from({ length: 9 }, (_, i) => {
        const at = 0.05 + (((i % 3) + Math.floor(i / 3)) / 4) * 0.5
        return (
          <Animated.View
            key={i}
            style={[
              styles.dot,
              props.size ? dotOf(props.size) : null,
              {
                backgroundColor: props.color,
                opacity: still
                  ? 0.7
                  : wave.interpolate({
                      inputRange: [0, at, at + 0.2, at + 0.4, 1],
                      outputRange: [0.25, 0.25, 1, 0.25, 0.25],
                    }),
              },
            ]}
          />
        )
      })}
    </View>
  )
}

/**
 * The running turn's status, as the desktop's: 「13 秒 · 正在读取 index.tsx · 4.1万 token」, the
 * clock ticking each second and only what it does giving way on a narrow screen, with the
 * attention dot in place of the running dots while it waits for the user.
 */
export function WorkingRow(props: {
  since: number | null
  label: string
  tokens: number | null
  waiting: boolean
}) {
  const { c } = useSessionTokens()
  const pulse = usePulse()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (props.since === null) return
    const since = props.since
    let timer: ReturnType<typeof setTimeout>
    // Just past each whole second, so a timer that fires late never skips one.
    const schedule = () => {
      const delay = 1000 - (Math.max(0, Date.now() - since) % 1000) + 5
      timer = setTimeout(() => {
        setNow(Date.now())
        schedule()
      }, delay)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [props.since])
  const elapsed = props.since !== null ? Math.max(0, now - props.since) : null
  const tone = { color: c.textSecondary }
  const dot = <Text style={[styles.fixed, { color: c.textTertiary }]}>{'  ·  '}</Text>
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={props.label}
    >
      {props.waiting ? (
        <View style={styles.attention}>
          <View
            style={[styles.attentionDot, { backgroundColor: c.warning, shadowColor: c.warning }]}
          />
        </View>
      ) : (
        <WorkingDots color={c.accent} />
      )}
      {/* Time · what it does · tokens, as the desktop orders them: only the middle one gives way. */}
      <Animated.View style={[styles.line, { opacity: props.waiting ? 1 : pulse }]}>
        {elapsed !== null && (
          <>
            <Text style={[styles.fixed, tone]}>{durationText(elapsed - (elapsed % 1000))}</Text>
            {dot}
          </>
        )}
        <Text style={[styles.label, tone]} numberOfLines={1}>
          {props.label}
        </Text>
        {props.tokens !== null && props.tokens > 0 && (
          <>
            {dot}
            <Text style={[styles.fixed, tone]}>{compactCount(props.tokens)} token</Text>
          </>
        )}
      </Animated.View>
    </View>
  )
}

/** The orange dot with its halo for a turn that waits for the user, softly pulsing. */
function AttentionMark() {
  const { c, s } = useSessionTokens()
  const pulse = usePulse()
  return (
    <Animated.View
      style={[
        styles.halo,
        {
          backgroundColor: s.accentSoft,
          opacity: pulse,
          transform: [
            { scale: pulse.interpolate({ inputRange: [0.7, 1], outputRange: [0.85, 1.1] }) },
          ],
        },
      ]}
    >
      <View style={[styles.haloDot, { backgroundColor: c.accent, shadowColor: c.accent }]} />
    </Animated.View>
  )
}

/**
 * The way back to the newest message, which says what the turn does: the working dots while it
 * runs, the attention dot while it waits for the user, else a chevron, marked when new messages
 * came in while scrolled away.
 */
export function ToBottomButton(props: {
  visible: boolean
  fresh: boolean
  state: 'running' | 'waiting' | 'idle'
  onPress(): void
}) {
  const { c } = useSessionTokens()
  const shown = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.timing(shown, {
      toValue: props.visible ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start()
  }, [props.visible, shown])
  return (
    <Animated.View
      pointerEvents={props.visible ? 'box-none' : 'none'}
      style={[
        styles.toBottom,
        {
          opacity: shown,
          transform: [
            { translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          ],
        },
      ]}
    >
      <View>
        <GlassButton
          silent
          size={44}
          {...(props.state === 'idle' ? { systemImage: G.toBottom.sf } : {})}
          onPress={props.onPress}
          accessibilityLabel={
            props.state === 'waiting'
              ? '等你回答，回到最新'
              : props.state === 'running'
                ? '正在工作，回到最新'
                : props.fresh
                  ? '有新消息，回到最新'
                  : '回到最新'
          }
        >
          {props.state === 'running' ? (
            <WorkingDots color={c.accent} size={16} />
          ) : props.state === 'waiting' ? (
            <AttentionMark />
          ) : (
            <Icon icon={G.toBottom} size={16} color={c.text} weight="semibold" />
          )}
        </GlassButton>
        {props.fresh && props.state === 'idle' && (
          <View
            pointerEvents="none"
            style={[styles.fresh, { backgroundColor: c.tint, borderColor: c.bg }]}
          />
        )}
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 32 },
  line: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  label: { flexShrink: 1, fontSize: 15, lineHeight: 20 },
  fixed: { flexShrink: 0, fontSize: 15, lineHeight: 20, fontVariant: ['tabular-nums'] },
  dots: { width: 15, height: 15, flexDirection: 'row', flexWrap: 'wrap', gap: 1.5 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  attention: { width: 15, height: 15, alignItems: 'center', justifyContent: 'center' },
  attentionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    shadowOpacity: 0.5,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 0 },
  },
  toBottom: { position: 'absolute', alignSelf: 'center', bottom: 12 },
  halo: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  haloDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    shadowOpacity: 0.6,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  fresh: {
    position: 'absolute',
    top: 1,
    right: 1,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
  },
})
