import { useEffect, useState, type RefObject } from 'react'

/** Media asks for its file once it is within one viewport of the visible part of its scroller. */
const MARGIN = '100% 0px'

const watched = new Map<Element, () => void>()
/**
 * One observer per scroller while something in it is watched. The observer holds its root, and a
 * root kept after its thread closed held that thread's whole detached DOM: every thread with media
 * opened once stayed in memory.
 */
const observers = new Map<Element | null, { observer: IntersectionObserver; users: number }>()

function acquire(root: Element | null): IntersectionObserver {
  let held = observers.get(root)
  if (!held) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) watched.get(entry.target)?.()
      },
      { root, rootMargin: MARGIN },
    )
    held = { observer, users: 0 }
    observers.set(root, held)
  }
  held.users++
  return held.observer
}

function release(root: Element | null, element: Element): void {
  const held = observers.get(root)
  if (!held) return
  held.observer.unobserve(element)
  if (--held.users > 0) return
  held.observer.disconnect()
  observers.delete(root)
}

/**
 * Whether the element has come near the view, through one observer per scroller: the margin
 * applies to the scroller's visible part only when the scroller is the root. Once near, it stays
 * so, and the media it holds keeps its source. `scroller` finds the scroller from the element.
 */
export function useNearView(
  ref: RefObject<Element | null>,
  enabled = true,
  scroller = '[data-slot="message-scroller-viewport"]',
): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || !enabled || near) return
    const root = element.closest(scroller)
    const observer = acquire(root)
    watched.set(element, () => setNear(true))
    observer.observe(element)
    return () => {
      watched.delete(element)
      release(root, element)
    }
  }, [ref, enabled, near, scroller])
  return near
}
