// A round button holding one icon: glass for the top bar and sheets, plain for inline actions,
// accent for the one main action on a screen.

import { StyleSheet, View } from 'react-native'
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
  const fill = tone === 'accent' ? c.accent : tone === 'glass' ? c.glass : 'transparent'
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
            backgroundColor: fill,
            borderColor: tone === 'glass' ? c.borderStrong : 'transparent',
          },
        ]}
      >
        <Icon
          name={props.icon}
          size={props.iconSize ?? Math.round(side * 0.46)}
          color={props.color ?? (tone === 'accent' ? c.onAccent : c.text)}
        />
      </View>
    </Press>
  )
}

const styles = StyleSheet.create({
  body: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
})
