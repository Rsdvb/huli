// A header that floats over its screen's scrolling content: clear at rest, so the screen's title
// reads as a large title, and frosted with a hairline once content scrolls beneath it.

import { useMemo, useRef, type ReactNode } from 'react'
import {
  Animated,
  Platform,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { BlurView } from 'expo-blur'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { space, useTokens } from './tokens'

export const HEADER_BAR = 64

export interface CollapsingHeader {
  /** The header's full height, safe area included. */
  height: number
  /** 0 at rest, 1 once content is under the header. */
  progress: Animated.AnimatedInterpolation<number>
  /** Spread on the scroll view: the scroll listener and, on iOS, the inset under the header. */
  scrollProps: {
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
    scrollEventThrottle: number
    contentInset?: { top: number }
    contentOffset?: { x: number; y: number }
    scrollIndicatorInsets?: { top: number }
    contentInsetAdjustmentBehavior: 'never'
  }
  /** The content's top padding: the header on Android, where insets do not exist. */
  contentTop: number
}

export function useCollapsingHeader(): CollapsingHeader {
  const insets = useSafeAreaInsets()
  const height = insets.top + HEADER_BAR
  const scrollY = useRef(new Animated.Value(0)).current
  const ios = Platform.OS === 'ios'
  return useMemo(() => {
    const rest = ios ? -height : 0
    return {
      height,
      progress: scrollY.interpolate({
        inputRange: [rest, rest + space.lg],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
      scrollProps: {
        onScroll: Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: true,
        }),
        scrollEventThrottle: 16,
        ...(ios
          ? {
              contentInset: { top: height },
              contentOffset: { x: 0, y: -height },
              scrollIndicatorInsets: { top: height - insets.top },
            }
          : {}),
        contentInsetAdjustmentBehavior: 'never',
      },
      contentTop: ios ? 0 : height,
    }
  }, [height, insets.top, ios, scrollY])
}

/** The floating header: its backdrop fades in with `progress`, its content sits in the bar. */
export function FloatingHeader(props: { header: CollapsingHeader; children: ReactNode }) {
  const { c, scheme } = useTokens()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.wrap, { height: props.header.height }]} pointerEvents="box-none">
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { opacity: props.header.progress }]}
      >
        {Platform.OS === 'ios' ? (
          <BlurView
            tint={scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
            intensity={80}
            style={StyleSheet.absoluteFill}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }]} />
        )}
        <View style={[styles.hairline, { backgroundColor: c.border }]} />
      </Animated.View>
      <View style={[styles.bar, { marginTop: insets.top }]} pointerEvents="box-none">
        {props.children}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  hairline: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
  bar: {
    height: HEADER_BAR,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    paddingHorizontal: space.lg,
  },
})
