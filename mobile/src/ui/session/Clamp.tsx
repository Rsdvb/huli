// Content cut to a height until shown whole, as the desktop's Clamp: a long message, a thought or a
// tool's result shows its first part, with 展开 under it, and 收起 once open.

import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import { useSessionTokens } from './palette'
import { gentle } from './Press'

// Past the height by less than this, the content shows whole: a button would hide too little.
const SLACK = 24

export function Clamp(props: {
  maxHeight: number
  children: ReactNode
  /** The button's words while cut; 展开 by default. */
  more?: string
  /** Where the button sits: at the start, or at the end as under a bubble. */
  align?: 'start' | 'end'
  /** The button's color; the tint by default. */
  color?: string
}) {
  const { c } = useSessionTokens()
  const [height, setHeight] = useState(0)
  const [open, setOpen] = useState(false)
  const cut = height > props.maxHeight + SLACK
  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.height)
    setHeight((was) => (Math.abs(was - next) < 1 ? was : next))
  }
  return (
    <View>
      <View style={cut && !open ? { maxHeight: props.maxHeight, overflow: 'hidden' } : null}>
        <View onLayout={onLayout}>{props.children}</View>
      </View>
      {cut && (
        <Pressable
          onPress={() => {
            gentle()
            setOpen((v) => !v)
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          style={[styles.button, { alignSelf: props.align === 'end' ? 'flex-end' : 'flex-start' }]}
        >
          <Text style={[styles.text, { color: props.color ?? c.tint }]}>
            {open ? '收起' : (props.more ?? '展开')}
          </Text>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  button: { paddingTop: 6, paddingBottom: 2 },
  text: { fontSize: 13, fontWeight: '600' },
})
