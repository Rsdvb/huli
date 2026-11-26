// Content cut to a height until shown whole, as the desktop's Clamp: a long message, a thought or a
// tool's result shows its first part, with 展开 under it, and 收起 once open.

import { useState, type ReactNode } from 'react'
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native'
import { useDisclosure } from './disclosure'
import { useSessionTokens } from './palette'

// Past the height by less than this, the content shows whole: a button would hide too little.
const SLACK = 24

/** The most of a text a closed clamp lays out: more could never show above its button. */
const CLAMPED_CHARS = 4000

/**
 * The heights content with an id was measured at, so a row the list mounts again is cut at once
 * rather than drawn whole for a frame and then cut, which would move the rows around it.
 */
const heights = new Map<string, number>()
const HEIGHTS_KEPT = 2000

/**
 * A box that shows at most `maxHeight` of what it holds, which is still laid out, and measured, at
 * its whole height. Yoga lays a non-scrolling box's content out within the box's height, and a text
 * measured within a height comes back cut to it: under `overflow: 'hidden'` a long paragraph
 * measured as short as the clamp, so the clamp let it go, measured it whole, held it again, and so
 * on every frame. A scrolling box's content is laid out unbounded; it clips all the same.
 */
export function clipTo(maxHeight: number): ViewStyle {
  return { maxHeight, overflow: 'scroll' }
}

export function Clamp(props: {
  maxHeight: number
  children: ReactNode
  /** The button's words while cut; 展开 by default. */
  more?: string
  /** Where the button sits: at the start, or at the end as under a bubble. */
  align?: 'start' | 'end'
  /** The button's color; the tint by default. */
  color?: string
  /** What the content is, in its conversation: whether it is open is kept under it. */
  id?: string
}) {
  const { c } = useSessionTokens()
  const { id } = props
  const [measured, setMeasured] = useState(() => ({
    id,
    height: id !== undefined ? (heights.get(id) ?? 0) : 0,
  }))
  const [ownOpen, setOwnOpen] = useState(false)
  const [keptOpen, setKeptOpen] = useDisclosure(`clamp:${id ?? ''}`)
  const open = id !== undefined ? keptOpen : ownOpen
  const setOpen = id !== undefined ? setKeptOpen : setOwnOpen
  // A view the list hands to other content starts from what that content was measured at.
  const height =
    measured.id === id ? measured.height : id !== undefined ? (heights.get(id) ?? 0) : 0
  const cut = height > props.maxHeight + SLACK
  // Until its height is known it is held to the clamp's: drawn whole for a frame and then cut,
  // it moved everything under it.
  const held = !open && (cut || height === 0)
  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.height)
    if (id !== undefined) {
      heights.delete(id)
      heights.set(id, next)
      if (heights.size > HEIGHTS_KEPT) heights.delete(heights.keys().next().value!)
    }
    setMeasured((was) =>
      was.id === id && Math.abs(was.height - next) < 1 ? was : { id, height: next },
    )
  }
  return (
    <View>
      <View style={held ? clipTo(props.maxHeight) : null}>
        <View onLayout={onLayout}>{props.children}</View>
      </View>
      {cut && (
        <Pressable
          onPress={() => {
            setOpen((v) => !v)
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          style={[styles.button, { alignSelf: props.align === 'end' ? 'flex-end' : 'flex-start' }]}
        >
          <Text style={[styles.text, { color: props.color ?? c.tint }]}>
            {open ? '收起' : (props.more ?? '展开')}
          </Text>
        </Pressable>
      )}
    </View>
  )
}

/** Whether the content with this id is shown whole, as its Clamp keeps it. */
export function useClampOpen(id: string): boolean {
  return useDisclosure(`clamp:${id}`)[0]
}

/**
 * A long text cut to what a closed clamp can show, so the rest is not read and laid out behind it,
 * which for a long message or a file's whole content held the screen up.
 */
export function clampedText(text: string, open: boolean): string {
  return open || text.length <= CLAMPED_CHARS ? text : text.slice(0, CLAMPED_CHARS)
}

const styles = StyleSheet.create({
  button: { paddingTop: 6, paddingBottom: 2 },
  text: { fontSize: 13, fontWeight: '600' },
})
