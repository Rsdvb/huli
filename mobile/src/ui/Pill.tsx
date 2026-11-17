// A capsule: the host pill in the top bar, a filter chip, a status tag.

import type { ReactNode } from 'react'
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { Press } from './Press'
import { radius, space, type as typeScale, useTokens } from './tokens'

export type PillTone = 'glass' | 'fill' | 'tint' | 'accent' | 'outline'

export function Pill(props: {
  children?: ReactNode
  label?: string
  leading?: ReactNode
  trailing?: ReactNode
  tone?: PillTone
  size?: 'sm' | 'md' | 'lg'
  /** The label's color, for status tags; text tokens otherwise. */
  color?: string
  onPress?: () => void
  onLongPress?: () => void
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}) {
  const { c } = useTokens()
  const tone = props.tone ?? 'fill'
  const size = props.size ?? 'md'
  const background = {
    glass: c.glass,
    fill: c.fill,
    tint: c.tintSoft,
    accent: c.accent,
    outline: 'transparent',
  }[tone]
  const ink = props.color ?? (tone === 'accent' ? c.onAccent : tone === 'tint' ? c.tint : c.text)
  const body = (
    <View
      style={[
        styles.pill,
        size === 'sm' ? styles.sm : size === 'lg' ? styles.lg : styles.md,
        {
          backgroundColor: background,
          borderColor: tone === 'glass' || tone === 'outline' ? c.borderStrong : 'transparent',
        },
        props.style,
      ]}
    >
      {props.leading}
      {props.label !== undefined ? (
        <Text
          numberOfLines={1}
          style={[
            size === 'sm'
              ? typeScale.caption
              : size === 'lg'
                ? typeScale.headline
                : typeScale.subhead,
            { color: ink, flexShrink: 1 },
            size === 'lg' && { fontWeight: '500' },
          ]}
        >
          {props.label}
        </Text>
      ) : null}
      {props.children}
      {props.trailing}
    </View>
  )
  if (!props.onPress && !props.onLongPress) return body
  return (
    <Press
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      containerStyle={{ flexShrink: 1 }}
    >
      {body}
    </Press>
  )
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
  },
  sm: { gap: space.xs, paddingHorizontal: space.sm, height: 24 },
  md: { gap: space.sm - 2, paddingHorizontal: space.md, height: 32 },
  lg: { gap: space.sm + 2, paddingHorizontal: space.lg + 2, height: 48 },
})
