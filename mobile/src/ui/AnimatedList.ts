// The list the tabs scroll under their collapsing header (ScrollHeader.tsx), whose scroll goes to a
// native-driven Animated.event. It is React Native's FlatList: FlashList 2 mis-measured the window
// under the header's iOS contentInset and negative start offset, so home opened blank, then sat a
// header too low with a pull-to-refresh spinner stuck over it. These lists are short (sessions,
// tasks), so FlatList with memoized rows costs little. `getItemType` is kept in the props so the
// callers stay as they are; FlatList has no use for it.

import { createElement, forwardRef, type ReactElement, type Ref } from 'react'
import { Animated, type FlatList, type FlatListProps } from 'react-native'

export type FlashListRef<T> = FlatList<T>

type Props<T> = FlatListProps<T> & {
  getItemType?: (item: T, index: number) => string | number | undefined
}

export const AnimatedFlashList = forwardRef(function AnimatedList(
  props: Props<unknown>,
  ref: Ref<FlatList<unknown>>,
) {
  const { getItemType: _unused, ...rest } = props
  return createElement(Animated.FlatList<unknown>, {
    windowSize: 11,
    initialNumToRender: 14,
    ...rest,
    ref,
  })
}) as unknown as <T>(props: Props<T> & { ref?: Ref<FlatList<T>> }) => ReactElement
