// FlashList for the tabs' lists, which hand their scroll to the collapsing header's native-driven
// Animated.event (ScrollHeader.tsx). FlashList's own animated export is typed loosely; this gives
// it the list's props back.

import type { ReactElement, Ref } from 'react'
import {
  AnimatedFlashList as Animated,
  type FlashListProps,
  type FlashListRef,
} from '@shopify/flash-list'

export type { FlashListRef }

export const AnimatedFlashList = Animated as unknown as <T>(
  props: FlashListProps<T> & { ref?: Ref<FlashListRef<T>> },
) => ReactElement
