// A view that takes a long press where one is wired, as Android's menu sheet wires it, and is a
// plain view where none is, as on iOS, whose system context menu takes the long press itself. On
// iOS a Pressable around a sideways ScrollView keeps the scroller from moving, even a Pressable
// with no handler, so a code block or a table inside one could not be swiped to its end.

import type { ReactNode } from 'react'
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native'

export function LongPressView(props: {
  onLongPress: (() => void) | undefined
  delayLongPress?: number
  style?: StyleProp<ViewStyle>
  children: ReactNode
}) {
  if (!props.onLongPress) return <View style={props.style}>{props.children}</View>
  return (
    <Pressable
      onLongPress={props.onLongPress}
      {...(props.delayLongPress !== undefined ? { delayLongPress: props.delayLongPress } : {})}
      style={props.style}
    >
      {props.children}
    </Pressable>
  )
}
