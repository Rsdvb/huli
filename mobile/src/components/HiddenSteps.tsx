// Huli: the 简洁视图's line for a turn's hidden steps (只看结论): how many there are; a tap shows
// the whole turn.

import { memo } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { haptic } from '../ui/haptics'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'

export const HiddenSteps = memo(function HiddenSteps(props: { count: number; onOpen(): void }) {
  const { c } = useSessionTokens()
  return (
    <Pressable
      onPress={() => {
        haptic.select()
        props.onOpen()
      }}
      accessibilityRole="button"
      accessibilityLabel={`${props.count} 个步骤已隐藏，点按展开`}
      hitSlop={6}
      style={({ pressed }) => [styles.line, pressed && { opacity: 0.6 }]}
    >
      <Icon icon={G.eyeOff} size={14} color={c.textTertiary} />
      <Text style={[styles.text, { color: c.textTertiary }]}>{props.count} 个步骤已隐藏</Text>
    </Pressable>
  )
})

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  text: { fontSize: 14 },
})
