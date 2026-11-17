// Placeholder shapes that breathe while something loads, in place of a spinner.

import { useEffect, useRef } from 'react'
import { Animated, StyleSheet, View, type DimensionValue } from 'react-native'
import { useReduceMotion } from './Press'
import { radius, size, space, useTokens } from './tokens'

function usePulse() {
  const reduce = useReduceMotion()
  const value = useRef(new Animated.Value(0.55)).current
  useEffect(() => {
    if (reduce) {
      value.setValue(0.8)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(value, { toValue: 0.55, duration: 700, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [reduce, value])
  return value
}

export function Skeleton(props: { width?: DimensionValue; height: number; radius?: number }) {
  const { c } = useTokens()
  const opacity = usePulse()
  return (
    <Animated.View
      style={{
        width: props.width ?? '100%',
        height: props.height,
        borderRadius: props.radius ?? radius.xs,
        backgroundColor: c.skeleton,
        opacity,
      }}
    />
  )
}

/** Rows shaped like a list's: a round avatar, a title and a shorter line under it. */
export function SkeletonRows(props: { count?: number; avatar?: boolean }) {
  const widths = ['72%', '58%', '80%', '46%', '66%', '54%'] as const
  return (
    <View accessibilityLabel="正在加载" style={styles.rows}>
      {Array.from({ length: props.count ?? 6 }, (_, i) => (
        <View key={i} style={styles.row}>
          {props.avatar !== false && (
            <Skeleton width={size.avatar} height={size.avatar} radius={size.avatar / 2} />
          )}
          <View style={styles.lines}>
            <Skeleton width={widths[i % widths.length]} height={16} />
            <Skeleton width="32%" height={12} />
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  rows: { gap: space.xl, paddingTop: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md + 2 },
  lines: { flex: 1, gap: space.sm },
})
