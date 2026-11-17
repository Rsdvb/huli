// A round button holding one icon: glass for the top bar and sheets, plain for inline actions,
// accent for the one main action on a screen. Glass is Liquid Glass where the system has it.

import { StyleSheet, View } from 'react-native'
import { GlassButton } from './Glass'
import { Icon, type IconName } from './Icon'
import { Press } from './Press'
import { size as sizes, useTokens } from './tokens'

export function IconButton(props: {
  icon: IconName
  onPress(): void
  /** What a screen reader says; every icon button needs one. */
  label: string
  size?: number
  iconSize?: number
  tone?: 'glass' | 'plain' | 'accent'
  color?: string
  disabled?: boolean
}) {
  const { c } = useTokens()
  const side = props.size ?? sizes.iconButton
  const tone = props.tone ?? 'glass'
  const icon = (
    <Icon
      name={props.icon}
      size={props.iconSize ?? Math.round(side * 0.46)}
      color={props.color ?? (tone === 'accent' ? c.onAccent : c.text)}
    />
  )
  if (tone === 'glass') {
    // Silent: the actions behind these buttons give their own haptics where they want one.
    return (
      <GlassButton
        silent
        elevated={false}
        size={side}
        onPress={props.onPress}
        disabled={props.disabled}
        accessibilityLabel={props.label}
      >
        {icon}
      </GlassButton>
    )
  }
  return (
    <Press
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={Math.max(0, (sizes.hit - side) / 2)}
    >
      <View
        style={[
          styles.body,
          {
            width: side,
            height: side,
            borderRadius: side / 2,
            backgroundColor: tone === 'accent' ? c.accent : 'transparent',
          },
        ]}
      >
        {icon}
      </View>
    </Press>
  )
}

const styles = StyleSheet.create({
  body: { alignItems: 'center', justifyContent: 'center' },
})
