// A slide that pinches to zoom and pans while zoomed, and zooms in and out on a double tap. While it
// is zoomed it tells the pager, which stops paging so a pan moves the slide instead.

import { useRef, type ReactNode } from 'react'
import { Animated, PanResponder, StyleSheet, View, type GestureResponderEvent } from 'react-native'

const MAX = 4
const DOUBLE_TAP_MS = 280

function distance(event: GestureResponderEvent): number {
  const [a, b] = event.nativeEvent.touches
  if (!a || !b) return 0
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY)
}

export function Zoomable(props: {
  width: number
  height: number
  onZoomed(zoomed: boolean): void
  children: ReactNode
}) {
  const scale = useRef(new Animated.Value(1)).current
  const x = useRef(new Animated.Value(0)).current
  const y = useRef(new Animated.Value(0)).current
  const state = useRef({
    scale: 1,
    x: 0,
    y: 0,
    startScale: 1,
    startDistance: 0,
    startX: 0,
    startY: 0,
  })
  const lastTap = useRef(0)
  const onZoomed = useRef(props.onZoomed)
  onZoomed.current = props.onZoomed
  const size = useRef({ width: props.width, height: props.height })
  size.current = { width: props.width, height: props.height }

  const clamp = (s: number, px: number, py: number) => {
    const maxX = (size.current.width * (s - 1)) / 2
    const maxY = (size.current.height * (s - 1)) / 2
    return {
      x: Math.max(-maxX, Math.min(maxX, px)),
      y: Math.max(-maxY, Math.min(maxY, py)),
    }
  }

  const settle = (s: number, px: number, py: number, animate: boolean) => {
    const next = s < 1.05 ? { s: 1, x: 0, y: 0 } : { s, ...clamp(s, px, py) }
    state.current = { ...state.current, scale: next.s, x: next.x, y: next.y }
    if (animate) {
      Animated.parallel([
        Animated.spring(scale, { toValue: next.s, useNativeDriver: true, bounciness: 0 }),
        Animated.spring(x, { toValue: next.x, useNativeDriver: true, bounciness: 0 }),
        Animated.spring(y, { toValue: next.y, useNativeDriver: true, bounciness: 0 }),
      ]).start()
    } else {
      scale.setValue(next.s)
      x.setValue(next.x)
      y.setValue(next.y)
    }
    onZoomed.current(next.s > 1)
  }

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: (event, g) =>
        event.nativeEvent.touches.length >= 2 ||
        (state.current.scale > 1 && Math.abs(g.dx) + Math.abs(g.dy) > 3),
      onPanResponderTerminationRequest: () => state.current.scale === 1,
      onPanResponderGrant: (event) => {
        const s = state.current
        s.startScale = s.scale
        s.startDistance = distance(event)
        s.startX = s.x
        s.startY = s.y
      },
      onPanResponderMove: (event, g) => {
        const s = state.current
        if (event.nativeEvent.touches.length >= 2) {
          const d = distance(event)
          if (s.startDistance === 0) {
            s.startDistance = d
            s.startScale = s.scale
            return
          }
          const next = Math.max(1, Math.min(MAX, (s.startScale * d) / s.startDistance))
          s.scale = next
          scale.setValue(next)
        } else if (s.scale > 1) {
          const at = clamp(s.scale, s.startX + g.dx, s.startY + g.dy)
          s.x = at.x
          s.y = at.y
          x.setValue(at.x)
          y.setValue(at.y)
        }
      },
      onPanResponderRelease: (_event, g) => {
        const s = state.current
        s.startDistance = 0
        const tap = Math.abs(g.dx) < 6 && Math.abs(g.dy) < 6
        if (tap) {
          const now = Date.now()
          if (now - lastTap.current < DOUBLE_TAP_MS) {
            lastTap.current = 0
            settle(s.scale > 1 ? 1 : 2.5, 0, 0, true)
            return
          }
          lastTap.current = now
        }
        settle(s.scale, s.x, s.y, true)
      },
      onPanResponderTerminate: () => {
        const s = state.current
        s.startDistance = 0
        settle(s.scale, s.x, s.y, true)
      },
    }),
  ).current

  return (
    <View
      style={[styles.clip, { width: props.width, height: props.height }]}
      {...responder.panHandlers}
    >
      <Animated.View style={{ transform: [{ translateX: x }, { translateY: y }, { scale }] }}>
        {props.children}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
})
