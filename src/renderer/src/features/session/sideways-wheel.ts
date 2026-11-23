import { useEffect, type RefObject } from 'react'

// Huli: the browser gives a whole wheel gesture to the scroller its first movement fits. A
// trackpad swipe that starts with a vertical lean (macOS keeps a swipe to the axis of its first
// events) goes to the thread for the rest of the gesture, so a code block or table under the
// pointer never moves sideways; in a long thread, which can move, the thread takes every swipe
// that does not start squarely sideways. The thread watches the wheel and, when the browser left a
// sideways movement over such a block unused, scrolls the block itself.

/** A sideways movement counts at this many pixels and at half the vertical one. */
const MIN_DX = 4
const DOMINANCE = 0.5
/** A gesture ends after this long without a sideways movement. */
const GESTURE_GAP_MS = 200
/** Frames to wait for the browser's own scroll of the block to show before taking over. */
const SETTLE_FRAMES = 2
/** Chromium's pixels per wheel line. */
const LINE_PX = 40

/** How one gesture over a block is scrolled: being found out, by the browser, or by the thread. */
interface Gesture {
  block: WeakRef<HTMLElement>
  by: 'watching' | 'browser' | 'thread'
  /** The block's scrollLeft at the gesture's start, then where the thread's own scroll left it. */
  left: number
  /** Movement to apply at the next frame. */
  pending: number
  frames: number
  last: number
}

function pixels(delta: number, mode: number, page: number): number {
  if (mode === WheelEvent.DOM_DELTA_LINE) return delta * LINE_PX
  if (mode === WheelEvent.DOM_DELTA_PAGE) return delta * page
  return delta
}

/** The block under `target` that scrolls sideways and has more to show, or null. */
function sidewaysBlock(target: EventTarget | null, view: HTMLElement): HTMLElement | null {
  let el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  for (; el && el !== view; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollWidth <= el.clientWidth + 1) continue
    const { overflowX } = getComputedStyle(el)
    if (overflowX === 'auto' || overflowX === 'scroll') return el
  }
  return null
}

/**
 * Scrolls a code block, table or formula of the thread sideways when the browser gave a sideways
 * swipe over it to the thread instead. It never scrolls a block the browser moves in the same
 * gesture, and never cancels the wheel: Shift+wheel and a swipe the browser gives the block are
 * left as they are. One passive listener on the thread; a frame runs only while a gesture does.
 */
export function useSidewaysWheel(viewport: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const view = viewport.current
    if (!view) return
    let gesture: Gesture | null = null
    let frame = 0

    const step = (): void => {
      frame = 0
      const g = gesture
      const block = g?.block.deref()
      if (!g || !block?.isConnected) {
        gesture = null
        return
      }
      if (g.by === 'watching') {
        if (Math.abs(block.scrollLeft - g.left) > 0.5) {
          g.by = 'browser'
          g.pending = 0
          return
        }
        if (++g.frames < SETTLE_FRAMES) {
          frame = requestAnimationFrame(step)
          return
        }
        g.by = 'thread'
      }
      if (g.by !== 'thread') return
      // The browser moved it after all, as when the gesture's axis changes on the way.
      if (Math.abs(block.scrollLeft - g.left) > 0.5) {
        g.by = 'browser'
        g.pending = 0
        return
      }
      if (g.pending !== 0) {
        block.scrollLeft = g.left + g.pending
        g.left = block.scrollLeft
        g.pending = 0
      }
    }

    // A scroll of the block the browser made, perhaps already in place when the gesture's first
    // wheel event arrived, so its scrollLeft alone could not tell.
    const onScroll = (event: Event): void => {
      const g = gesture
      if (g?.by !== 'watching' || event.target !== g.block.deref()) return
      g.by = 'browser'
      g.pending = 0
    }

    const onWheel = (event: WheelEvent): void => {
      const page = view.clientWidth
      const dx = pixels(event.deltaX, event.deltaMode, page)
      const dy = pixels(event.deltaY, event.deltaMode, page)
      if (Math.abs(dx) < MIN_DX || Math.abs(dx) < DOMINANCE * Math.abs(dy)) return
      const now = event.timeStamp
      let g = gesture
      const current = g?.block.deref()
      if (
        !g ||
        !current ||
        now - g.last > GESTURE_GAP_MS ||
        !(event.target instanceof Node && current.contains(event.target))
      ) {
        const block = sidewaysBlock(event.target, view)
        if (!block) {
          gesture = null
          return
        }
        g = {
          block: new WeakRef(block),
          by: 'watching',
          left: block.scrollLeft,
          pending: 0,
          frames: 0,
          last: now,
        }
        gesture = g
      }
      g.last = now
      if (g.by === 'browser') return
      g.pending += dx
      if (!frame) frame = requestAnimationFrame(step)
    }

    view.addEventListener('wheel', onWheel, { capture: true, passive: true })
    view.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      view.removeEventListener('wheel', onWheel, { capture: true })
      view.removeEventListener('scroll', onScroll, { capture: true })
      cancelAnimationFrame(frame)
      gesture = null
    }
  }, [viewport])
}
