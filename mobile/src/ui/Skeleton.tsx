// Placeholder shapes that stand where something loads, in place of a spinner. They hold still: a
// breathing loop redrew the screen on every frame for as long as a slow read took.

import { StyleSheet, View, type DimensionValue } from 'react-native'
import { radius, size, space, useTokens } from './tokens'

export function Skeleton(props: { width?: DimensionValue; height: number; radius?: number }) {
  const { c } = useTokens()
  return (
    <View
      style={{
        width: props.width ?? '100%',
        height: props.height,
        borderRadius: props.radius ?? radius.xs,
        backgroundColor: c.skeleton,
        opacity: 0.8,
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
