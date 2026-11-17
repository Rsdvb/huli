// While a turn runs and nothing is being written: a softly pulsing line with how long it has run,
// what it has added to the context and what it does now.
// And the button that brings a scrolled-up conversation back to its newest message.

import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native'
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

/** A three by three grid of dots a wave of light runs across while the agent works. */
function WorkingDots(props: { color: string }) {
  const wave = useRef(new Animated.Value(0)).current
  const [still, setStill] = useState(false)
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null
    let live = true
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (!live) return
      if (reduce) return setStill(true)
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
  }, [wave])
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no">
      {Array.from({ length: 9 }, (_, i) => {
        const at = 0.05 + (((i % 3) + Math.floor(i / 3)) / 4) * 0.5
        return (
          <Animated.View
            key={i}
            style={[
              styles.dot,
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
 * The running turn's status, as the desktop's: 「13 秒 · 4.1万 token · 正在运行 1 条命令」, the
 * clock ticking each second, with the attention dot in place of the running dots while it waits
 * for the user.
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
  const parts = [
    elapsed !== null ? durationText(elapsed - (elapsed % 1000)) : null,
    props.tokens !== null && props.tokens > 0 ? `${compactCount(props.tokens)} token` : null,
    props.label,
  ].filter(Boolean)
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
      <Animated.Text
        style={[styles.label, { color: c.textSecondary, opacity: props.waiting ? 1 : pulse }]}
        numberOfLines={1}
      >
        {parts.join(' · ')}
      </Animated.Text>
    </View>
  )
}

export function ToBottomButton(props: { visible: boolean; fresh: boolean; onPress(): void }) {
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
        <GlassButton size={40} onPress={props.onPress} accessibilityLabel="回到最新">
          <Icon icon={G.toBottom} size={16} color={c.text} weight="semibold" />
        </GlassButton>
        {props.fresh && (
          <View
            pointerEvents="none"
            style={[styles.fresh, { backgroundColor: c.accent, borderColor: c.bg }]}
          />
        )}
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 32 },
  label: { flex: 1, fontSize: 15, lineHeight: 20, fontVariant: ['tabular-nums'] },
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
