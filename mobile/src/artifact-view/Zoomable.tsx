// A slide that pinches to zoom and pans while zoomed, and zooms in and out on a double tap, about
// the point between the fingers or under the tap, as Photos does. While it is zoomed it tells the
// pager, which stops paging so a pan moves the slide instead.

import { useRef, type ComponentRef, type ReactNode } from 'react'
import { Animated, PanResponder, StyleSheet, View, type GestureResponderEvent } from 'react-native'
import { useReduceMotion } from '../ui/Press'

const MAX = 4
const DOUBLE_TAP_MS = 280
const DOUBLE_TAP_SCALE = 2.5

function distance(event: GestureResponderEvent): number {
  const [a, b] = event.nativeEvent.touches
  if (!a || !b) return 0
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY)
}

/** The point between two fingers, on the page. */
function midpoint(event: GestureResponderEvent): { x: number; y: number } {
  const [a, b] = event.nativeEvent.touches
  if (!a || !b) return { x: 0, y: 0 }
  return { x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 }
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
    /** The pinch's first midpoint, from the view's center. */
    focusX: 0,
    focusY: 0,
  })
  const view = useRef<ComponentRef<typeof View>>(null)
  /** The view's center on the page, for where the fingers are on it. */
  const center = useRef({ x: 0, y: 0 })
  const measure = () =>
    view.current?.measure((_x, _y, width, height, pageX, pageY) => {
      center.current = { x: pageX + width / 2, y: pageY + height / 2 }
    })
  const lastTap = useRef(0)
  const onZoomed = useRef(props.onZoomed)
  onZoomed.current = props.onZoomed
  const size = useRef({ width: props.width, height: props.height })
  size.current = { width: props.width, height: props.height }
  // Read by the gesture's handlers, made once.
  const reduce = useRef(false)
  reduce.current = useReduceMotion()

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
      // Under Reduce Motion it eases there quickly instead of springing, as the app's springs do.
      const to = (value: Animated.Value, toValue: number) =>
        reduce.current
          ? Animated.timing(value, { toValue, duration: 120, useNativeDriver: true })
          : Animated.spring(value, { toValue, useNativeDriver: true, bounciness: 0 })
      Animated.parallel([to(scale, next.s), to(x, next.x), to(y, next.y)]).start()
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
      onPanResponderGrant: () => {
        const s = state.current
        // A pager moves the slide on the page, so where it is is read anew for each touch; the
        // pinch takes its first midpoint on its first move, once that is known.
        measure()
        s.startScale = s.scale
        s.startDistance = 0
        s.startX = s.x
        s.startY = s.y
      },
      onPanResponderMove: (event, g) => {
        const s = state.current
        if (event.nativeEvent.touches.length >= 2) {
          const d = distance(event)
          const mid = midpoint(event)
          const fx = mid.x - center.current.x
          const fy = mid.y - center.current.y
          if (s.startDistance === 0) {
            s.startDistance = d
            s.startScale = s.scale
            s.startX = s.x
            s.startY = s.y
            s.focusX = fx
            s.focusY = fy
            return
          }
          const next = Math.max(1, Math.min(MAX, (s.startScale * d) / s.startDistance))
          // The point that was between the fingers stays between them as they spread and move.
          const at = clamp(
            next,
            fx - (next * (s.focusX - s.startX)) / s.startScale,
            fy - (next * (s.focusY - s.startY)) / s.startScale,
          )
          s.scale = next
          s.x = at.x
          s.y = at.y
          scale.setValue(next)
          x.setValue(at.x)
          y.setValue(at.y)
        } else if (s.scale > 1) {
          const at = clamp(s.scale, s.startX + g.dx, s.startY + g.dy)
          s.x = at.x
          s.y = at.y
          x.setValue(at.x)
          y.setValue(at.y)
        }
      },
      onPanResponderRelease: (event, g) => {
        const s = state.current
        s.startDistance = 0
        const tap = Math.abs(g.dx) < 6 && Math.abs(g.dy) < 6
        if (tap) {
          const now = Date.now()
          if (now - lastTap.current < DOUBLE_TAP_MS) {
            lastTap.current = 0
            if (s.scale > 1) {
              settle(1, 0, 0, true)
            } else {
              // In about the tapped point, which stays where it was.
              const fx = event.nativeEvent.pageX - center.current.x
              const fy = event.nativeEvent.pageY - center.current.y
              settle(
                DOUBLE_TAP_SCALE,
                fx * (1 - DOUBLE_TAP_SCALE),
                fy * (1 - DOUBLE_TAP_SCALE),
                true,
              )
            }
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
      ref={view}
      onLayout={measure}
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
