// A capsule: the host pill in the top bar, a filter chip, a status tag.

import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { Glass, useGlassMode } from './Glass'
import { Press } from './Press'
import { FONT_SCALE, radius, size as sizes, space, type as typeScale, useTokens } from './tokens'

export type PillTone = 'glass' | 'fill' | 'tint' | 'accent' | 'outline'

export function Pill(props: {
  children?: ReactNode
  label?: string
  leading?: ReactNode
  trailing?: ReactNode
  tone?: PillTone
  /** `bar` is the top bar's: 34pt tall, hugging a 16pt label. */
  size?: 'sm' | 'md' | 'lg' | 'bar'
  /** The label's color, for status tags; text tokens otherwise. */
  color?: string
  onPress?: () => void
  onLongPress?: () => void
  /** Greyed and not pressable, as a button that cannot act now. */
  disabled?: boolean
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}) {
  const { c } = useTokens()
  const mode = useGlassMode()
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
  const pressable = (!!props.onPress || !!props.onLongPress) && !props.disabled
  const glass = tone === 'glass'
  const liquid = glass && mode === 'liquid'
  const shape = [
    styles.pill,
    size === 'sm' ? styles.sm : size === 'lg' ? styles.lg : size === 'bar' ? styles.bar : styles.md,
  ]
  // A glass pill is drawn by Glass: Liquid Glass, or its fallbacks with their own edge.
  const Body = glass ? GlassPillBody : PlainPillBody
  const body = (
    <Body
      interactive={liquid && pressable}
      style={[
        shape,
        glass
          ? liquid && styles.glass
          : {
              backgroundColor: background,
              borderColor: tone === 'outline' ? c.borderStrong : 'transparent',
            },
        props.style,
        props.disabled && styles.disabled,
      ]}
    >
      {props.leading}
      {props.label !== undefined ? (
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={FONT_SCALE.dense}
          style={[
            size === 'sm'
              ? typeScale.caption
              : size === 'lg'
                ? typeScale.headline
                : size === 'bar'
                  ? typeScale.bar
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
    </Body>
  )
  if (props.disabled) {
    return (
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel ?? props.label}
        accessibilityState={{ disabled: true }}
        style={styles.shrink}
      >
        {body}
      </View>
    )
  }
  if (!pressable) return body
  // The touch reaches 44pt even where the capsule is shorter.
  const slop = Math.max(0, (sizes.hit - MIN_HEIGHT[size]) / 2)
  const hitSlop = { top: slop, bottom: slop, left: space.xs, right: space.xs }
  // Liquid Glass answers the touch itself; a fade on top of it would dim the glass.
  if (liquid) {
    return (
      <Pressable
        onPress={props.onPress}
        onLongPress={props.onLongPress}
        hitSlop={hitSlop}
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel ?? props.label}
        style={styles.shrink}
      >
        {body}
      </Pressable>
    )
  }
  return (
    <Press
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      containerStyle={styles.shrink}
    >
      {body}
    </Press>
  )
}

interface BodyProps {
  interactive: boolean
  style: StyleProp<ViewStyle>
  children?: ReactNode
}

function PlainPillBody(props: BodyProps) {
  return <View style={props.style}>{props.children}</View>
}

function GlassPillBody(props: BodyProps) {
  return (
    <Glass shape="capsule" interactive={props.interactive} style={props.style}>
      {props.children}
    </Glass>
  )
}

const MIN_HEIGHT = { sm: 24, md: 32, lg: 48, bar: sizes.barPill } as const

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
  },
  sm: { gap: space.xs, paddingHorizontal: space.sm, minHeight: MIN_HEIGHT.sm },
  md: { gap: space.sm - 2, paddingHorizontal: space.md, minHeight: MIN_HEIGHT.md },
  lg: { gap: space.sm + 2, paddingHorizontal: space.lg + 2, minHeight: MIN_HEIGHT.lg },
  bar: { gap: space.sm, paddingHorizontal: 14, minHeight: sizes.barPill, alignSelf: 'center' },
  glass: { borderWidth: 0 },
  disabled: { opacity: 0.4 },
  shrink: { flexShrink: 1 },
})
