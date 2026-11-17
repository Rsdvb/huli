// A segmented control: a capsule track with a raised thumb that springs to the chosen segment.
// Android's; iOS uses the system's own (SegmentedControl.ios.tsx).

import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { haptic } from './haptics'
import { SPRING } from './motion'
import { useReduceMotion } from './Press'
import { FONT_SCALE, motion, radius, type as typeScale, useTokens } from './tokens'

export interface Segment<K extends string> {
  key: K
  label: string
}

const INSET = 3

export function SegmentedControl<K extends string>(props: {
  segments: readonly Segment<K>[]
  value: K
  onChange(key: K): void
}) {
  const { c, scheme } = useTokens()
  const reduce = useReduceMotion()
  const [width, setWidth] = useState(0)
  const index = Math.max(
    0,
    props.segments.findIndex((s) => s.key === props.value),
  )
  const segment = width > 0 ? (width - INSET * 2) / props.segments.length : 0
  const x = useSharedValue(0)
  const placed = useRef(false)
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))

  useEffect(() => {
    if (segment === 0) return
    const target = index * segment
    if (!placed.current || reduce) {
      x.value = target
      placed.current = true
      return
    }
    x.value = withSpring(target, SPRING)
  }, [index, segment, reduce, x])

  return (
    <View
      accessibilityRole="tablist"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.track, { backgroundColor: c.fill }]}
    >
      {segment > 0 && (
        <Reanimated.View
          style={[
            styles.thumb,
            {
              width: segment,
              backgroundColor: scheme === 'dark' ? c.fillStrong : c.surface,
              shadowColor: c.shadow,
            },
            thumb,
          ]}
        />
      )}
      {props.segments.map((s) => {
        const on = s.key === props.value
        return (
          <Pressable
            key={s.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (on) return
              haptic.select()
              props.onChange(s.key)
            }}
            style={({ pressed }) => [
              styles.segment,
              pressed && !on && { opacity: motion.pressOpacity },
            ]}
          >
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={FONT_SCALE.dense}
              style={[
                typeScale.subhead,
                { color: on ? c.text : c.textSecondary, fontWeight: on ? '600' : '500' },
              ]}
            >
              {s.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    minHeight: 40,
    borderRadius: radius.pill,
    padding: INSET,
  },
  thumb: {
    position: 'absolute',
    top: INSET,
    bottom: INSET,
    left: INSET,
    borderRadius: radius.pill,
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})
