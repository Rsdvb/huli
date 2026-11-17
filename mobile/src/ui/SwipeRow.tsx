// A list row that swipes sideways to reveal an action, as Mail's rows do: a short swipe opens it
// to tap, a long one runs it. Built on PanResponder and the native-driven Animated API, so it
// needs no gesture library; a horizontal drag claims the touch, a vertical one leaves it to the
// list.

import { useRef, useState, type ReactNode } from 'react'
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'
import { haptic } from './haptics'
import { Icon, type IconName } from './Icon'
import { motion, space, type as typeScale, useTokens } from './tokens'

export interface SwipeAction {
  label: string
  icon: IconName
  color: string
  onPress(): void
}

const ACTION_WIDTH = 84

// One row open at a time across the app, as iOS keeps it.
let closeOpen: (() => void) | null = null

export function SwipeRow(props: {
  children: ReactNode
  /** Revealed by swiping right, at the row's start. */
  start?: SwipeAction
  /** Revealed by swiping left, at the row's end. */
  end?: SwipeAction
  /**
   * What the row shows, in a list that recycles its rows: when it changes, the row starts closed
   * rather than as the item it showed before was left.
   */
  item?: string
}) {
  const { c } = useTokens()
  const [width, setWidth] = useState(0)
  const [open, setOpen] = useState(false)
  const x = useRef(new Animated.Value(0)).current
  const base = useRef(0)
  const current = useRef(0)
  const armed = useRef(false)
  const latest = useRef(props)
  latest.current = props

  const settle = (to: number, after?: () => void) => {
    base.current = to
    current.current = to
    setOpen(to !== 0)
    Animated.timing(x, { toValue: to, duration: motion.normal, useNativeDriver: true }).start(() =>
      after?.(),
    )
  }
  const close = () => settle(0)
  // A stable handle for the app-wide open row, whichever render set it.
  const closeThis = useRef(close).current

  const shown = useRef(props.item)
  if (shown.current !== props.item) {
    shown.current = props.item
    base.current = 0
    current.current = 0
    x.setValue(0)
    if (closeOpen === closeThis) closeOpen = null
    if (open) setOpen(false)
  }

  const run = (action: SwipeAction | undefined) => {
    if (!action) return close()
    if (closeOpen === closeThis) closeOpen = null
    settle(0)
    action.onPress()
  }

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
      onPanResponderGrant: () => {
        if (closeOpen && closeOpen !== closeThis) closeOpen()
        closeOpen = closeThis
        armed.current = false
      },
      onPanResponderMove: (_e, g) => {
        const { start, end } = latest.current
        let next = base.current + g.dx
        if (!start && next > 0) next = 0
        if (!end && next < 0) next = 0
        current.current = next
        x.setValue(next)
        const full = Math.abs(next) > widthRef.current * 0.55
        if (full !== armed.current) {
          armed.current = full
          if (full) haptic.select()
        }
      },
      onPanResponderRelease: (_e, g) => {
        const { start, end } = latest.current
        const at = current.current
        if (armed.current) return run(at > 0 ? start : end)
        const flung = Math.abs(g.vx) > 0.5
        if (at > ACTION_WIDTH / 2 || (flung && g.vx > 0 && at > 0)) return settle(ACTION_WIDTH)
        if (at < -ACTION_WIDTH / 2 || (flung && g.vx < 0 && at < 0)) return settle(-ACTION_WIDTH)
        close()
      },
      onPanResponderTerminate: () => close(),
      onPanResponderTerminationRequest: () => false,
    }),
  ).current
  const widthRef = useRef(0)
  widthRef.current = width

  const underlay = (action: SwipeAction, side: 'start' | 'end') => (
    <Animated.View
      pointerEvents={open ? 'auto' : 'none'}
      style={[
        styles.underlay,
        {
          width,
          backgroundColor: action.color,
          transform: [
            { translateX: side === 'end' ? Animated.add(x, width) : Animated.add(x, -width) },
          ],
          alignItems: side === 'end' ? 'flex-start' : 'flex-end',
        },
      ]}
    >
      <Pressable
        onPress={() => run(action)}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        style={styles.action}
      >
        <Icon name={action.icon} size={22} color={c.onAccent} weight="medium" />
        <Text style={[typeScale.caption, { color: c.onAccent }]}>{action.label}</Text>
      </Pressable>
    </Animated.View>
  )

  return (
    <View
      style={styles.clip}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessibilityActions={[
        ...(props.start ? [{ name: 'start', label: props.start.label }] : []),
        ...(props.end ? [{ name: 'end', label: props.end.label }] : []),
      ]}
      onAccessibilityAction={(e) =>
        e.nativeEvent.actionName === 'start' ? props.start?.onPress() : props.end?.onPress()
      }
    >
      {width > 0 && props.start && underlay(props.start, 'start')}
      {width > 0 && props.end && underlay(props.end, 'end')}
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: x }] }}>
        {props.children}
        {open && (
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="收起" />
        )}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  underlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'center',
  },
  action: {
    width: ACTION_WIDTH,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
})
