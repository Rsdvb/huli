// The floating tab bar: a glass capsule of icon tabs with a highlight that slides to the chosen one,
// and the round new-session button beside it. On iOS the glass is a real blur; Android gets the
// translucent fill, since its blur needs a target view around the whole screen.

import { useEffect, useRef, useState } from 'react'
import { Animated, Platform, Pressable, StyleSheet, View } from 'react-native'
import { BlurView } from 'expo-blur'
import type { BottomTabBarProps } from 'expo-router/js-tabs'
import { haptic } from './haptics'
import { Icon, type IconName } from './Icon'
import { Press, useReduceMotion } from './Press'
import { radius, size as sizes, space, useTokens } from './tokens'

export interface TabItem {
  icon: IconName
  label: string
}

const INSET = 4

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

  return (
    <View
      pointerEvents="box-none"
      style={[styles.dock, { paddingBottom: Math.max(insets.bottom - space.xs, space.md) }]}
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
      <Press
        onPress={() => {
          haptic.tap()
          props.onPlus()
        }}
        disabled={props.plusDisabled}
        accessibilityRole="button"
        accessibilityLabel="新会话"
        style={[styles.plus, { borderColor: c.borderStrong, shadowColor: c.shadow }]}
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
  bar: {
    flex: 1,
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
  plus: {
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
