// A section's heading: its name, a quiet count beside it, and an optional action at the end.

import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { FONT_SCALE, space, type as typeScale, useTokens } from './tokens'

export function SectionHeader(props: {
  title: string
  count?: number
  right?: ReactNode
  /** Tint the title, as for what needs the user. */
  color?: string
}) {
  const { c } = useTokens()
  return (
    <View style={styles.row} accessibilityRole="header">
      <Text
        maxFontSizeMultiplier={FONT_SCALE.dense}
        style={[typeScale.section, { color: props.color ?? c.textSecondary }]}
      >
        {props.title}
      </Text>
      {props.count !== undefined && (
        <Text
          maxFontSizeMultiplier={FONT_SCALE.dense}
          style={[typeScale.section, styles.count, { color: c.textTertiary }]}
        >
          {props.count}
        </Text>
      )}
      <View style={styles.spacer} />
      {props.right}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    paddingTop: space.xxl,
    paddingBottom: space.md,
  },
  count: { fontVariant: ['tabular-nums'] },
  spacer: { flex: 1 },
})
