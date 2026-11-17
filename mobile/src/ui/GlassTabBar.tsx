// The floating tab bar: a glass capsule of icon tabs with a highlight that slides to the chosen one,
// and the round new-session button beside it. On iOS the glass is a real blur; Android gets the
// translucent fill, since its blur needs a target view around the whole screen.
//
// A tab may let it minimize while its content scrolls down, as iOS does: the capsule gives way to
// one round button for the current tab, and comes back on a scroll up, at the top, or on a tap.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { BlurView } from 'expo-blur'
import { useFocusEffect } from 'expo-router'
import type { BottomTabBarProps } from 'expo-router/js-tabs'
import { haptic } from './haptics'
import { Icon, type IconName } from './Icon'
import { Press, useReduceMotion } from './Press'
import { motion, radius, size as sizes, space, useTokens } from './tokens'

export interface TabItem {
  icon: IconName
  label: string
}

const INSET = 4

let minimized = false
const listeners = new Set<() => void>()

function setMinimized(next: boolean) {
  if (next === minimized) return
  minimized = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** How far the content must move one way before the bar changes. */
const TRAVEL = 24
/** Within this of the top, the bar is always whole. */
const NEAR_TOP = 48

/**
 * Opts the focused tab in: pass the returned listener to its scroll view's `onScroll`. The bar
 * comes back whole when the tab loses focus.
 */
export function useMinimizingTabBar(): (event: NativeSyntheticEvent<NativeScrollEvent>) => void {
  const anchor = useRef(0)
  useFocusEffect(
    useCallback(() => {
      anchor.current = 0
      return () => setMinimized(false)
    }, []),
  )
  return useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentInset, contentSize, layoutMeasurement } = event.nativeEvent
    const insetTop = contentInset?.top ?? 0
    const y = contentOffset.y + insetTop
    const end =
      contentSize.height + insetTop + (contentInset?.bottom ?? 0) - layoutMeasurement.height
    if (y <= NEAR_TOP) {
      anchor.current = y
      setMinimized(false)
      return
    }
    // The bounce past the end scrolls back up by itself, which is no wish to see the bar.
    if (y >= end) return
    if (minimized) {
      if (y > anchor.current) anchor.current = y
      else if (anchor.current - y > TRAVEL) {
        anchor.current = y
        setMinimized(false)
      }
    } else if (y < anchor.current) anchor.current = y
    else if (y - anchor.current > TRAVEL) {
      anchor.current = y
      setMinimized(true)
    }
  }, [])
}

/** The capsule's own glass: a blur on iOS, a translucent fill elsewhere. */
export function Glass(props: { round: number }) {
  const { c, scheme } = useTokens()
  if (Platform.OS !== 'ios') {
    return (
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: c.glass, borderRadius: props.round }]}
      />
    )
  }
  return (
    <BlurView
      tint={scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
      intensity={90}
      style={[StyleSheet.absoluteFill, { borderRadius: props.round, overflow: 'hidden' }]}
    />
  )
}

export function GlassTabBar(
  props: BottomTabBarProps & {
    items: Record<string, TabItem>
    onPlus(): void
    plusDisabled?: boolean
  },
) {
  const { c } = useTokens()
  const reduce = useReduceMotion()
  const { state, descriptors, emitter, navigateToTab, insets } = props
  const routes = state.routes.filter((route) => props.items[route.name])
  const focusedKey = state.routes[state.index]?.key
  const index = Math.max(
    0,
    routes.findIndex((route) => route.key === focusedKey),
  )
  const [width, setWidth] = useState(0)
  const slot = width > 0 ? (width - INSET * 2) / routes.length : 0
  const x = useRef(new Animated.Value(0)).current
  const placed = useRef(false)
  const small = useSyncExternalStore(subscribe, () => minimized)
  const shrink = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (slot === 0) return
    if (!placed.current || reduce) {
      x.setValue(index * slot)
      placed.current = true
      return
    }
    Animated.spring(x, {
      toValue: index * slot,
      useNativeDriver: true,
      speed: 22,
      bounciness: 4,
    }).start()
  }, [index, slot, reduce, x])

  useEffect(() => {
    const to = small ? 1 : 0
    if (reduce) {
      Animated.timing(shrink, { toValue: to, duration: motion.fast, useNativeDriver: true }).start()
      return
    }
    Animated.spring(shrink, {
      toValue: to,
      useNativeDriver: true,
      speed: 18,
      bounciness: 3,
    }).start()
  }, [small, reduce, shrink])

  const focusedRoute = routes[index]
  const focusedItem = focusedRoute ? props.items[focusedRoute.name] : undefined
  const bottom = Math.max(insets.bottom - space.xs, space.md)
  const fade = (from: number, to: number) =>
    shrink.interpolate({ inputRange: [0, 1], outputRange: [from, to], extrapolate: 'clamp' })
  // Reduce Motion keeps the crossfade and drops the change of size.
  const scale = (from: number, to: number) => (reduce ? 1 : fade(from, to))

  return (
    <View pointerEvents="box-none" style={[styles.dock, { paddingBottom: bottom }]}>
      <Animated.View
        pointerEvents={small ? 'none' : 'auto'}
        accessibilityElementsHidden={small}
        importantForAccessibility={small ? 'no-hide-descendants' : 'auto'}
        style={[styles.barWrap, { opacity: fade(1, 0), transform: [{ scale: scale(1, 0.4) }] }]}
      >
        <View
          style={[styles.bar, { borderColor: c.borderStrong, shadowColor: c.shadow }]}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          accessibilityRole="tablist"
        >
          <Glass round={sizes.tabBar / 2} />
          {slot > 0 && (
            <Animated.View
              style={[
                styles.highlight,
                { width: slot, backgroundColor: c.fillStrong, transform: [{ translateX: x }] },
              ]}
            />
          )}
          {routes.map((route) => {
            const item = props.items[route.name]!
            const focused = route.key === focusedKey
            const { options } = descriptors[route.key]!
            return (
              <Pressable
                key={route.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={options.tabBarAccessibilityLabel ?? item.label}
                onPress={() => {
                  const event = emitter.emit({
                    type: 'tabPress',
                    target: route.key,
                    canPreventDefault: true,
                  })
                  if (!focused && !event.defaultPrevented) {
                    haptic.tap()
                    navigateToTab(route.key)
                  }
                }}
                onLongPress={() => emitter.emit({ type: 'tabLongPress', target: route.key })}
                style={styles.tab}
              >
                <Icon
                  name={item.icon}
                  size={24}
                  color={focused ? c.tint : c.text}
                  weight={focused ? 'semibold' : 'regular'}
                />
              </Pressable>
            )
          })}
        </View>
      </Animated.View>
      {focusedItem && (
        <Animated.View
          pointerEvents={small ? 'auto' : 'none'}
          accessibilityElementsHidden={!small}
          importantForAccessibility={small ? 'auto' : 'no-hide-descendants'}
          style={[
            styles.mini,
            {
              left: space.lg,
              bottom,
              opacity: fade(0, 1),
              transform: [{ scale: scale(0.6, 1) }],
            },
          ]}
        >
          <Press
            onPress={() => {
              haptic.tap()
              setMinimized(false)
            }}
            accessibilityRole="button"
            accessibilityLabel={`${focusedItem.label}，显示标签栏`}
            style={[styles.round, { borderColor: c.borderStrong, shadowColor: c.shadow }]}
          >
            <Glass round={sizes.tabBar / 2} />
            <Icon name={focusedItem.icon} size={24} color={c.tint} weight="semibold" />
          </Press>
        </Animated.View>
      )}
      <Press
        onPress={() => {
          haptic.tap()
          props.onPlus()
        }}
        disabled={props.plusDisabled}
        accessibilityRole="button"
        accessibilityLabel="新会话"
        style={[styles.round, { borderColor: c.borderStrong, shadowColor: c.shadow }]}
      >
        <Glass round={sizes.tabBar / 2} />
        <Icon name="plus" size={26} weight="medium" />
      </Press>
    </View>
  )
}

const styles = StyleSheet.create({
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  barWrap: { flex: 1, transformOrigin: 'left center' },
  bar: {
    height: sizes.tabBar,
    flexDirection: 'row',
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    padding: INSET,
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  highlight: {
    position: 'absolute',
    top: INSET,
    bottom: INSET,
    left: INSET,
    borderRadius: radius.pill,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mini: { position: 'absolute', transformOrigin: 'left center' },
  round: {
    width: sizes.tabBar,
    height: sizes.tabBar,
    borderRadius: sizes.tabBar / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
})
