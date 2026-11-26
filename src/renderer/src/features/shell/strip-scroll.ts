import { useCallback, useEffect, useLayoutEffect, type RefObject } from 'react'
import { prefersReducedMotion } from '@renderer/stores/settings'

// A row of tabs wider than its place scrolls sideways: a mouse's wheel turns it as a trackpad's
// sideways swipe does, its hidden ends fade under a button that pages it, and a tab revealed stops
// clear of the fade. Edges are written straight onto the row's box, so scrolling renders nothing.

/** How wide a hidden end fades; a revealed tab stops this far from the row's edge. */
export const STRIP_EDGE_PX = 28
/** A wheel that scrolls by lines, as some mice do, moves the row this far per line. */
const LINE_PX = 40
/** A smaller wheel step is a trackpad's, which follows the fingers at once instead of easing. */
const EASED_STEP_PX = 50
/** A page button moves the row by this share of what shows. */
const PAGE_SHARE = 0.7
/** The row counts as scrolling until it has been still this long. */
const SCROLL_REST_MS = 150

function setFlag(
  element: HTMLElement,
  name: 'moreStart' | 'moreEnd' | 'scrolling',
  on: boolean,
): void {
  if ((element.dataset[name] !== undefined) === on) return
  if (on) element.dataset[name] = ''
  else delete element.dataset[name]
}

function behavior(eased: boolean): ScrollBehavior {
  return eased && !prefersReducedMotion() ? 'smooth' : 'instant'
}

/**
 * Scrolls `strip`, whose parent is its box, by the wheel, and marks the box `data-more-start` and
 * `data-more-end` while tabs lie past either end. `layout` changes whenever the tabs do;
 * `onResize` runs when the row's width changes, and `onWheel` when the wheel turns it.
 */
export function useStripScroll(
  stripRef: RefObject<HTMLElement | null>,
  layout: string,
  { onResize, onWheel }: { onResize?: () => void; onWheel?: () => void } = {},
): { page: (direction: 1 | -1) => void } {
  const edges = useCallback(() => {
    const strip = stripRef.current
    const box = strip?.parentElement
    if (!strip || !box) return
    const max = strip.scrollWidth - strip.clientWidth
    setFlag(box, 'moreStart', strip.scrollLeft > 1)
    setFlag(box, 'moreEnd', strip.scrollLeft < max - 1)
  }, [stripRef])

  useLayoutEffect(edges, [edges, layout])

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    // Where an eased wheel scroll is headed, so quick notches add up instead of restarting.
    let target: number | null = null
    const settled = () => {
      target = null
    }
    const wheel = (event: WheelEvent) => {
      // A sideways swipe, and Shift with a wheel, scroll the row natively; Ctrl zooms.
      if (event.ctrlKey || event.shiftKey) return
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      const max = strip.scrollWidth - strip.clientWidth
      if (max <= 0) return
      const step =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * LINE_PX
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * strip.clientWidth
            : event.deltaY
      onWheel?.()
      const eased = Math.abs(step) >= EASED_STEP_PX
      const from = eased && target !== null ? target : strip.scrollLeft
      const to = Math.min(max, Math.max(0, from + step))
      const how = behavior(eased)
      target = how === 'smooth' ? to : null
      strip.scrollTo({ left: to, behavior: how })
    }
    // While the row moves, the tabs passing under the pointer take no hover: each one's hover
    // transitions restyle the row for a quarter of a second, about 10 ms of style per tab passed.
    let rest = 0
    const scrolled = () => {
      edges()
      const box = strip.parentElement
      if (!box) return
      setFlag(box, 'scrolling', true)
      window.clearTimeout(rest)
      rest = window.setTimeout(() => setFlag(box, 'scrolling', false), SCROLL_REST_MS)
    }
    const observer = new ResizeObserver(() => {
      onResize?.()
      edges()
    })
    observer.observe(strip)
    strip.addEventListener('scroll', scrolled, { passive: true })
    strip.addEventListener('scrollend', settled, { passive: true })
    strip.addEventListener('wheel', wheel, { passive: true })
    return () => {
      window.clearTimeout(rest)
      observer.disconnect()
      strip.removeEventListener('scroll', scrolled)
      strip.removeEventListener('scrollend', settled)
      strip.removeEventListener('wheel', wheel)
    }
  }, [stripRef, edges, onResize, onWheel])

  const page = useCallback(
    (direction: 1 | -1) => {
      const strip = stripRef.current
      if (!strip) return
      strip.scrollBy({ left: direction * strip.clientWidth * PAGE_SHARE, behavior: behavior(true) })
    },
    [stripRef],
  )
  return { page }
}

/** Scrolls the strip just enough that the tab of `key` shows clear of the faded ends. */
export function revealTab(strip: HTMLElement, key: string, eased: boolean): void {
  const tab = [...strip.children].find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.dataset.key === key,
  )
  if (!tab) return
  const view = strip.getBoundingClientRect()
  const box = tab.getBoundingClientRect()
  const start = view.left + STRIP_EDGE_PX
  const end = view.right - STRIP_EDGE_PX
  const by =
    box.left < start || box.width > end - start
      ? box.left - start
      : box.right > end
        ? box.right - end
        : 0
  if (Math.abs(by) >= 1) strip.scrollBy({ left: by, behavior: behavior(eased) })
}
