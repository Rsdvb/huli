// A raised surface with a soft edge; pressable when it leads somewhere.

import type { ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { Press } from './Press'
import { radius, space, useTokens } from './tokens'

export function Card(props: {
  children?: ReactNode
  onPress?: () => void
  onLongPress?: () => void
  accessibilityLabel?: string
  /** Inner padding; 0 for a card of rows that pad themselves. */
  padding?: number
  style?: StyleProp<ViewStyle>
  containerStyle?: StyleProp<ViewStyle>
}) {
  const { c } = useTokens()
  const body = [
    styles.card,
    { backgroundColor: c.surface, borderColor: c.border, padding: props.padding ?? space.lg },
    props.style,
  ]
  if (!props.onPress && !props.onLongPress) {
    return <View style={[body, props.containerStyle]}>{props.children}</View>
  }
  return (
    <Press
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      style={body}
      containerStyle={props.containerStyle}
    >
      {props.children}
    </Press>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
})
