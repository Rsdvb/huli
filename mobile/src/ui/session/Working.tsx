// While a turn runs and nothing is being written: a softly pulsing line with how long it has run.
// And the button that brings a scrolled-up conversation back to its newest message.

import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native'
import { tickText } from './format'
import { AgentMark, G, Icon } from './icons'
import { useSessionTokens } from './palette'
import { PressScale } from './Press'
import type { HarnessId } from '@shared/agents'

function usePulse(): Animated.Value {
  const value = useRef(new Animated.Value(0.45)).current
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
      loop = Animated.loop(Animated.sequence([step(1), step(0.45)]))
      loop.start()
    })
    return () => {
      live = false
      loop?.stop()
    }
  }, [value])
  return value
}

export function WorkingRow(props: {
  since: number | null
  label: string
  harness: HarnessId | undefined
}) {
  const { c } = useSessionTokens()
  const pulse = usePulse()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <View style={styles.row} accessibilityLiveRegion="polite">
      <Animated.View style={{ opacity: pulse }}>
        <AgentMark harness={props.harness} size={16} />
      </Animated.View>
      <Animated.Text style={[styles.label, { color: c.textSecondary, opacity: pulse }]}>
        {props.label}
      </Animated.Text>
      {props.since !== null && (
        <Text style={[styles.time, { color: c.textTertiary }]}>{tickText(now - props.since)}</Text>
      )}
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
      <PressScale
        onPress={props.onPress}
        accessibilityRole="button"
        accessibilityLabel="回到最新"
        style={[
          styles.toBottomButton,
          { backgroundColor: c.glass, borderColor: c.borderStrong, shadowColor: c.shadow },
        ]}
      >
        <Icon icon={G.toBottom} size={16} color={c.text} weight="semibold" />
        {props.fresh && (
          <View style={[styles.fresh, { backgroundColor: c.accent, borderColor: c.bg }]} />
        )}
      </PressScale>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 32 },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  time: { fontSize: 13, fontVariant: ['tabular-nums'] },
  toBottom: { position: 'absolute', alignSelf: 'center', bottom: 12 },
  toBottomButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 0.5,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
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
