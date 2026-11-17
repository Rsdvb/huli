// A segmented control: a capsule track with a raised thumb that springs to the chosen segment.

import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native'
import { haptic } from './haptics'
import { useReduceMotion } from './Press'
import { motion, radius, type as typeScale, useTokens } from './tokens'

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
  const x = useRef(new Animated.Value(0)).current
  const placed = useRef(false)

  useEffect(() => {
    if (segment === 0) return
    const target = index * segment
    if (!placed.current || reduce) {
      x.setValue(target)
      placed.current = true
      return
    }
    Animated.spring(x, { toValue: target, useNativeDriver: true, speed: 20, bounciness: 5 }).start()
  }, [index, segment, reduce, x])

  return (
    <View
      accessibilityRole="tablist"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.track, { backgroundColor: c.fill }]}
    >
      {segment > 0 && (
        <Animated.View
          style={[
            styles.thumb,
            {
              width: segment,
              backgroundColor: scheme === 'dark' ? c.fillStrong : c.surface,
              shadowColor: c.shadow,
              transform: [{ translateX: x }],
            },
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
    height: 40,
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
