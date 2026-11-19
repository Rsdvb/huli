// While a turn runs and nothing is being written: a softly pulsing line with how long it has run,
// what it has added to the context and what it does now.
// And the button that brings a scrolled-up conversation back to its newest message.

import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native'
import { useIsFocused } from 'expo-router'
import {
  CELLS,
  KEYFRAMES,
  PATTERNS,
  turnDotPattern,
  type DotKeyframes,
  type TurnDot,
  type TurnDotPatternName,
} from '@shared/turn-dots'
import { G, Icon } from './icons'
import { compactCount, durationText } from './work'
import { GlassButton, useGlassMode } from '../Glass'
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

// The ease-in-out CSS timing function, cubic-bezier(0.42, 0, 0.58, 1), at x.
function easeInOut(x: number): number {
  const at = (t: number, a: number, b: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3
  let lo = 0
  let hi = 1
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (at(mid, 0.42, 0.58) < x) lo = mid
    else hi = mid
  }
  return at((lo + hi) / 2, 0, 1)
}

// An eased segment is drawn as this many straight ones, which the native driver interpolates.
const EASED_STEPS = 6
const STILL_OPACITY = 0.22

/** A dot's opacity `q` of the way through its keyframes' loop. */
function opacityAt(name: DotKeyframes, q: number, eased: boolean): number {
  const stops = KEYFRAMES[name]
  for (let i = 1; i < stops.length; i++) {
    const [o1, a1] = stops[i]!
    if (q > o1 && i < stops.length - 1) continue
    const [o0, a0] = stops[i - 1]!
    const f = o1 > o0 ? Math.min(1, Math.max(0, (q - o0) / (o1 - o0))) : 1
    return a0 + (a1 - a0) * (eased ? easeInOut(f) : f)
  }
  return stops[0]![1]
}

/**
 * One dot's opacity along the loop's single value, from 0 to 1, as the native driver interpolates
 * it: its keyframes started `at` into the loop, as the desktop's negative CSS delay starts them.
 */
function dotRanges(dot: TurnDot, eased: boolean): { inputRange: number[]; outputRange: number[] } {
  const name = dot.keyframes
  if (!name) return { inputRange: [0, 1], outputRange: [STILL_OPACITY, STILL_OPACITY] }
  const qs = new Set<number>()
  const stops = KEYFRAMES[name]
  for (let i = 0; i < stops.length; i++) {
    qs.add(stops[i]![0])
    if (eased && i > 0) {
      const from = stops[i - 1]![0]
      const to = stops[i]![0]
      for (let k = 1; k < EASED_STEPS; k++) qs.add(from + ((to - from) * k) / EASED_STEPS)
    }
  }
  // The loop's value v plays the dot's keyframes at q = v - at, wrapped; at v = at the dot's loop
  // ends and starts again, so the end comes first there.
  // Rounded, so a stop that wraps lands exactly where the next loop starts.
  const round = (v: number) => Math.round(v * 1e6) / 1e6
  const points = [...qs].map((q) => {
    const wrapped = round(q + dot.at) > 1
    const v = round(wrapped ? q + dot.at - 1 : q + dot.at)
    return { v, wrapped, value: opacityAt(name, q, eased) }
  })
  if (dot.at > 0) {
    const edge = opacityAt(name, 1 - dot.at, eased)
    points.push({ v: 0, wrapped: true, value: edge }, { v: 1, wrapped: false, value: edge })
  }
  points.sort((a, b) => a.v - b.v || Number(b.wrapped) - Number(a.wrapped))
  const inputRange: number[] = []
  const outputRange: number[] = []
  for (const point of points) {
    const last = inputRange[inputRange.length - 1]
    inputRange.push(last !== undefined && point.v <= last ? Math.min(1, last + 1e-4) : point.v)
    outputRange.push(point.value)
  }
  return { inputRange, outputRange }
}

const DOT_RANGES = new Map<TurnDotPatternName, { inputRange: number[]; outputRange: number[] }[]>()

function patternRanges(name: TurnDotPatternName) {
  let ranges = DOT_RANGES.get(name)
  if (!ranges) {
    const pattern = PATTERNS[name]
    ranges = CELLS.map(([x, y]) => dotRanges(pattern.dot(x, y), pattern.easing === 'ease-in-out'))
    DOT_RANGES.set(name, ranges)
  }
  return ranges
}

/**
 * The running turn's mark: three by three dots acting out what the turn does now, the desktop's
 * patterns (@shared/turn-dots) played here from the phase this phone knows, never in step with the
 * desktop. A new phase starts its pattern afresh. The loop runs on the native driver, rests while
 * its screen is covered by another, and holds its first frame under Reduce Motion.
 */
export function WorkingDots(props: { color: string; size?: number; phase?: string | null }) {
  const pattern = turnDotPattern(props.phase)
  return <TurnDots key={pattern} pattern={pattern} color={props.color} size={props.size} />
}

function TurnDots(props: {
  pattern: TurnDotPatternName
  color: string
  size?: number | undefined
}) {
  const loop = useRef(new Animated.Value(0)).current
  const [still, setStill] = useState(false)
  const focused = useIsFocused()
  const { ms } = PATTERNS[props.pattern]
  useEffect(() => {
    if (!focused) return
    let running: Animated.CompositeAnimation | null = null
    let live = true
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (!live) return
      if (reduce) return setStill(true)
      // From the start of the loop, as a loop stopped midway would repeat only its rest.
      loop.setValue(0)
      running = Animated.loop(
        Animated.timing(loop, {
          toValue: 1,
          duration: ms,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      )
      running.start()
    })
    return () => {
      live = false
      running?.stop()
    }
  }, [loop, focused, ms])
  const ranges = patternRanges(props.pattern)
  return (
    <View
      style={[
        styles.dots,
        props.size ? { width: props.size, height: props.size, gap: gapOf(props.size) } : null,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {ranges.map((range, i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            props.size ? dotOf(props.size) : null,
            {
              backgroundColor: props.color,
              opacity: still ? range.outputRange[0]! : loop.interpolate(range),
            },
          ]}
        />
      ))}
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
  /** What the turn does now (TurnPhaseName), which the dots act out. */
  phase?: string | null
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
        <WorkingDots color={c.accent} phase={props.phase} />
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
  /** While it runs, what the turn does now, which its dots act out. */
  phase?: string | null
  onPress(): void
}) {
  const { c, s } = useSessionTokens()
  // Liquid Glass under a fading opacity draws nothing, so it popped in whole once the fade ended:
  // there the glass melts in and out on its own, and only the icon on it fades.
  const liquid = useGlassMode() === 'liquid'
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
          opacity: liquid ? 1 : shown,
          transform: [
            { translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          ],
        },
      ]}
    >
      <View>
        {/* Never the system's own button for the chevron: one glass for every state, which can
            melt away. */}
        {/* Liquid Glass bends the reply under it into a second, ghostly glyph beside the icon; a
            veil of the page's color keeps what lies under it a soft blur. */}
        <GlassButton
          silent
          size={44}
          {...(liquid ? { tint: s.veil } : {})}
          dematerialized={!props.visible}
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
          <Animated.View style={liquid ? { opacity: shown } : null}>
            {props.state === 'running' ? (
              <WorkingDots color={c.accent} size={16} phase={props.phase} />
            ) : props.state === 'waiting' ? (
              <AttentionMark />
            ) : (
              <Icon icon={G.toBottom} size={16} color={c.text} weight="semibold" />
            )}
          </Animated.View>
        </GlassButton>
        {props.fresh && props.state === 'idle' && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.fresh,
              { backgroundColor: c.tint, borderColor: c.bg },
              liquid ? { opacity: shown } : null,
            ]}
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
