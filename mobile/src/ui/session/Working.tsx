// While a turn runs and nothing is being written: a softly pulsing line with how long it has run,
// what it has added to the context and what it does now, its dots and pulse stepped on the step
// clock (steps.ts) rather than redrawn on every frame.
// And the button that brings a scrolled-up conversation back to its newest message.

import { createContext, useContext, useEffect, useRef } from 'react'
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native'
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated'
import {
  CELLS,
  KEYFRAMES,
  PATTERNS,
  turnDotPattern,
  type DotKeyframes,
  type TurnDotPatternName,
} from '@shared/turn-dots'
import { G, Icon } from './icons'
import { useSecond } from './now'
import { compactCount, durationText } from './work'
import { GlassButton, useGlassMode } from '../Glass'
import { StepOpacity } from '../StepMarks'
import { stepsIn, useSteps } from '../steps'
import { useSessionTokens } from './palette'

/**
 * Whether the marks inside show on screen: false holds them still, as the working line's while the
 * conversation is scrolled away from its end.
 */
export const MarksShown = createContext(true)

// The text's breath while the turn runs, 1.8 s from dim to bright and back, in steps.
const PULSE = (() => {
  const n = stepsIn(1800)
  return Array.from({ length: n }, (_, k) => 0.85 - 0.15 * Math.cos((2 * Math.PI * k) / n))
})()

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

const DOT_FRAMES = new Map<TurnDotPatternName, number[][]>()

/**
 * Each dot's opacity at each step of the pattern's loop: its keyframes started `at` into the loop,
 * as the desktop's negative CSS delay starts them.
 */
function patternFrames(name: TurnDotPatternName): number[][] {
  let frames = DOT_FRAMES.get(name)
  if (!frames) {
    const pattern = PATTERNS[name]
    const eased = pattern.easing === 'ease-in-out'
    const n = stepsIn(pattern.ms, 6)
    frames = CELLS.map(([x, y]) => {
      const dot = pattern.dot(x, y)
      return Array.from({ length: n }, (_, k) => {
        if (!dot.keyframes) return STILL_OPACITY
        const q = k / n - dot.at
        return Math.round(opacityAt(dot.keyframes, q - Math.floor(q), eased) * 100) / 100
      })
    })
    DOT_FRAMES.set(name, frames)
  }
  return frames
}

/**
 * The running turn's mark: three by three dots acting out what the turn does now, the desktop's
 * patterns (@shared/turn-dots) played here from the phase this phone knows, never in step with the
 * desktop, a few steps a second. It holds still while `on` is false or its marks don't show, while
 * its screen is covered by another, and under Reduce Motion.
 */
export function WorkingDots(props: {
  color: string
  size?: number
  phase?: string | null
  on?: boolean
}) {
  const shown = useContext(MarksShown)
  const steps = useSteps((props.on ?? true) && shown)
  const frames = patternFrames(turnDotPattern(props.phase))
  return (
    <View
      style={[
        styles.dots,
        props.size ? { width: props.size, height: props.size, gap: gapOf(props.size) } : null,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {frames.map((dot, i) => (
        <StepOpacity
          key={i}
          steps={steps}
          frames={dot}
          style={[
            styles.dot,
            props.size ? dotOf(props.size) : null,
            { backgroundColor: props.color },
          ]}
        />
      ))}
    </View>
  )
}

/** How long the turn has run, to the second. */
function Elapsed(props: { since: number; style: StyleProp<TextStyle> }) {
  const now = useSecond(useContext(MarksShown))
  const elapsed = Math.max(0, now - props.since)
  return <Text style={props.style}>{durationText(elapsed - (elapsed % 1000))}</Text>
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
  const steps = useSteps(useContext(MarksShown) && !props.waiting)
  const tone = { color: c.textSecondary }
  const dot = <Text style={[styles.fixed, { color: c.textTertiary }]}>{'  ·  '}</Text>
  // Time · what it does · tokens, as the desktop orders them: only the middle one gives way.
  const line = (
    <>
      {props.since !== null && (
        <>
          <Elapsed since={props.since} style={[styles.fixed, tone]} />
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
    </>
  )
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
      {props.waiting ? (
        <View style={styles.line}>{line}</View>
      ) : (
        <StepOpacity steps={steps} frames={PULSE} style={styles.line}>
          {line}
        </StepOpacity>
      )}
    </View>
  )
}

// The halo's scale with the pulse, from 0.85 at its dimmest to 1.1 at its brightest.
const HALO_SCALE = PULSE.map((v) => 0.85 + ((v - 0.7) / 0.3) * 0.25)

/** The orange dot with its halo for a turn that waits for the user, softly pulsing. */
function AttentionMark(props: { on: boolean }) {
  const { c, s } = useSessionTokens()
  const steps = useSteps(props.on)
  const breath = useAnimatedStyle(() => {
    const k = steps ? steps.value % PULSE.length : 0
    return { opacity: PULSE[k], transform: [{ scale: HALO_SCALE[k]! }] }
  }, [steps])
  return (
    <Reanimated.View style={[styles.halo, { backgroundColor: s.accentSoft }, breath]}>
      <View style={[styles.haloDot, { backgroundColor: c.accent, shadowColor: c.accent }]} />
    </Reanimated.View>
  )
}

/**
 * The way back to the newest message, which says what the turn does: the working dots while it
 * runs, the attention dot while it waits for the user, else a chevron, marked when new messages
 * came in while scrolled away. Its marks hold still while it is hidden.
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
              <WorkingDots color={c.accent} size={16} phase={props.phase} on={props.visible} />
            ) : props.state === 'waiting' ? (
              <AttentionMark on={props.visible} />
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
