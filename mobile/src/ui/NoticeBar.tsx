// A short note at the top of whatever screen shows, as the desktop's toasts are: how a git write
// went with its next step, or a session archived with Undo. One at a time; it leaves on its own.

import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Glass } from './Glass'
import { useReduceMotion } from './Press'
import { HEADER_BAR } from './ScrollHeader'
import { G, Icon } from './session/icons'
import { useSessionTokens } from './session/palette'
import { motion, size as sizes, space, type as typeScale } from './tokens'

export interface Notice {
  text: string
  tone?: 'success' | 'info' | 'warning'
  action?: { label: string; onPress(): void }
}

const SHOWN_MS = 6000

/** The action's text grows to a 44pt target over the capsule's height. */
const ACTION_SLOP = { top: 13, bottom: 13, left: 10, right: 10 }

let current: (Notice & { id: number }) | null = null
let count = 0
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function showNotice(notice: Notice): void {
  current = { ...notice, id: ++count }
  emit()
}

export function hideNotice(): void {
  current = null
  emit()
}

/** Mounted once at the app's root, over every screen. */
export function NoticeBar() {
  const { c } = useSessionTokens()
  const insets = useSafeAreaInsets()
  const reduce = useReduceMotion()
  const [notice, setNotice] = useState(current)
  const shown = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const update = () => setNotice(current)
    listeners.add(update)
    return () => {
      listeners.delete(update)
    }
  }, [])

  useEffect(() => {
    if (!notice) return
    shown.setValue(0)
    Animated.timing(shown, {
      toValue: 1,
      duration: reduce ? motion.fast : motion.normal,
      useNativeDriver: true,
    }).start()
    const timer = setTimeout(() => {
      Animated.timing(shown, { toValue: 0, duration: motion.fast, useNativeDriver: true }).start(
        ({ finished }) => {
          if (finished && current?.id === notice.id) hideNotice()
        },
      )
    }, SHOWN_MS)
    return () => clearTimeout(timer)
  }, [notice, shown, reduce])

  if (!notice) return null
  const color =
    notice.tone === 'warning' ? c.warning : notice.tone === 'success' ? c.success : c.tint
  const icon = notice.tone === 'warning' ? G.warning : notice.tone === 'success' ? G.done : G.info
  return (
    <View pointerEvents="box-none" style={[styles.dock, { top: insets.top + HEADER_BAR }]}>
      <Animated.View
        accessibilityLiveRegion="polite"
        style={{
          opacity: shown,
          transform: reduce
            ? []
            : [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
          maxWidth: '92%',
        }}
      >
        {/* A capsule on one line; two lines grow it into a rounded card rather than clip. */}
        <Glass shape="rounded" radius={sizes.hit / 2} elevated style={styles.capsule}>
          <Icon icon={icon} size={15} color={color} />
          <Text style={[styles.text, { color: c.text }]} numberOfLines={2}>
            {notice.text}
          </Text>
          {notice.action ? (
            <Pressable
              hitSlop={ACTION_SLOP}
              accessibilityRole="button"
              onPress={() => {
                const action = notice.action
                hideNotice()
                action?.onPress()
              }}
              style={({ pressed }) => [styles.action, { opacity: pressed ? 0.55 : 1 }]}
            >
              <Text style={[styles.actionText, { color: c.tint }]}>{notice.action.label}</Text>
            </Pressable>
          ) : null}
        </Glass>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  dock: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 50 },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: sizes.hit,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
  },
  text: { ...typeScale.subhead, flexShrink: 1 },
  action: { paddingLeft: space.xs },
  actionText: { ...typeScale.subhead, fontWeight: '600' },
})
