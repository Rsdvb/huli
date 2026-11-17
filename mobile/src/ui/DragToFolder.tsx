// Dragging sessions onto a folder's header, while the home list selects: a row held a moment lifts
// into a small card that follows the finger, the header under it lights up, and letting go there
// moves the sessions into that folder. The headers say where they are as the drag starts, so the
// list keeps scrolling and recycling rows as it likes.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import Reanimated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import { haptic } from './haptics'
import { Icon } from './Icon'
import { radius, space, type as typeScale, useTokens } from './tokens'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Target {
  measure(): Promise<Rect | null>
  drop(ids: string[]): void
}

interface Drag {
  label: string
  ids: string[]
}

interface DragValue {
  register(key: string, target: Target): () => void
  /** The target the dragged sessions are over now, by key. */
  hover: string | null
  begin(drag: Drag, x: number, y: number): void
  move(x: number, y: number): void
  end(): void
}

const DragContext = createContext<DragValue | null>(null)

const GHOST_WIDTH = 200

/** Holds the targets and draws the card that follows the finger, over its children. */
export function DragProvider(props: { children: ReactNode }) {
  const { c } = useTokens()
  const targets = useRef(new Map<string, Target>())
  const rects = useRef(new Map<string, Rect>())
  const current = useRef<Drag | null>(null)
  const hoverRef = useRef<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const x = useSharedValue(0)
  const y = useSharedValue(0)

  const register = useCallback((key: string, target: Target) => {
    targets.current.set(key, target)
    return () => {
      if (targets.current.get(key) === target) targets.current.delete(key)
    }
  }, [])

  const hitTest = useCallback((px: number, py: number) => {
    for (const [key, r] of rects.current) {
      if (px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height) return key
    }
    return null
  }, [])

  const value = useMemo<DragValue>(
    () => ({
      register,
      hover,
      begin(next, px, py) {
        current.current = next
        hoverRef.current = null
        x.value = px
        y.value = py
        setDrag(next)
        setHover(null)
        haptic.tap()
        rects.current = new Map()
        for (const [key, target] of targets.current) {
          void target.measure().then((rect) => {
            if (rect && current.current === next) rects.current.set(key, rect)
          })
        }
      },
      move(px, py) {
        if (!current.current) return
        x.value = px
        y.value = py
        const over = hitTest(px, py)
        if (over !== hoverRef.current) {
          hoverRef.current = over
          setHover(over)
          if (over) haptic.select()
        }
      },
      end() {
        const done = current.current
        const over = hoverRef.current
        current.current = null
        hoverRef.current = null
        setDrag(null)
        setHover(null)
        if (done && over) targets.current.get(over)?.drop(done.ids)
      },
    }),
    [register, hover, hitTest, x, y],
  )

  const ghost = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value - GHOST_WIDTH / 2 }, { translateY: y.value - 28 }],
  }))

  return (
    <DragContext.Provider value={value}>
      {props.children}
      {drag ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Reanimated.View
            style={[
              styles.ghost,
              { backgroundColor: c.surfaceRaised, borderColor: c.border, shadowColor: c.shadow },
              ghost,
            ]}
          >
            <Icon name="message" size={16} color={c.tint} />
            <Text
              style={[typeScale.subhead, styles.ghostText, { color: c.text }]}
              numberOfLines={1}
            >
              {drag.label}
            </Text>
          </Reanimated.View>
        </View>
      ) : null}
    </DragContext.Provider>
  )
}

/** A folder header the dragged sessions can be let go on; `children` gets whether they are over it. */
export function DropTarget(props: {
  id: string
  onDrop(ids: string[]): void
  children: (over: boolean) => ReactElement
}) {
  const drag = useContext(DragContext)
  const ref = useRef<ComponentRef<typeof View>>(null)
  const drop = useRef(props.onDrop)
  drop.current = props.onDrop
  const register = drag?.register
  useEffect(() => {
    if (!register) return
    return register(props.id, {
      drop: (ids) => drop.current(ids),
      measure: () =>
        new Promise((resolve) => {
          const view = ref.current
          if (!view) return resolve(null)
          view.measureInWindow((x, y, width, height) =>
            resolve(width > 0 ? { x, y, width, height } : null),
          )
        }),
    })
  }, [register, props.id])
  return (
    <View ref={ref} collapsable={false}>
      {props.children(drag?.hover === props.id)}
    </View>
  )
}

/**
 * A row that lifts into a drag after a short hold while `enabled`; `what` says what it carries as
 * the drag starts (the row alone, or every selected row with it).
 */
export function DragSource(props: { enabled: boolean; what: () => Drag; children: ReactElement }) {
  const drag = useContext(DragContext)
  const what = useRef(props.what)
  what.current = props.what
  const pan = usePanGesture({
    enabled: props.enabled && drag !== null,
    activateAfterLongPress: 250,
    runOnJS: true,
    onActivate: (e) => drag?.begin(what.current(), e.absoluteX, e.absoluteY),
    onUpdate: (e) => {
      if ('absoluteX' in e) drag?.move(e.absoluteX, e.absoluteY)
    },
    onFinalize: () => drag?.end(),
  })
  if (!props.enabled || !drag) return props.children
  return <GestureDetector gesture={pan}>{props.children}</GestureDetector>
}

const styles = StyleSheet.create({
  ghost: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: GHOST_WIDTH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  ghostText: { flex: 1, fontWeight: '600' },
})
