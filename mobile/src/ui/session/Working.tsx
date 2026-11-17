// While a turn runs and nothing is being written: a softly pulsing line with how long it has run.
// And the button that brings a scrolled-up conversation back to its newest message.

import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native'
import { spanText } from './format'
import { G, Icon } from './icons'
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

/** 「13 秒 · 正在运行 1 个命令 · 3017 token」, ticking each second. */
export function WorkingRow(props: { since: number | null; label: string; tokens: number | null }) {
  const { c } = useSessionTokens()
  const pulse = usePulse()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const parts = [
    props.since !== null ? spanText(now - props.since) : null,
    props.label,
    props.tokens !== null && props.tokens > 0 ? `${props.tokens} token` : null,
  ].filter(Boolean)
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={props.label}
    >
      <WorkingDots color={c.accent} />
      <Animated.Text
        style={[styles.label, { color: c.textSecondary, opacity: pulse }]}
        numberOfLines={1}
      >
        {parts.join('  ·  ')}
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
