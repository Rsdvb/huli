import {
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { markdownHeight } from '@renderer/features/session/thread-items'
import { InPartsContext } from './live'

/** How many window heights of a written text render at first, from its end, where a thread opens. */
const FIRST_SCREENS = 1

/** The first chunk rendered at once: the last ones, by their estimated height, at least the last. */
function firstRendered(chunks: readonly string[]): number {
  const room = window.innerHeight * FIRST_SCREENS
  let height = 0
  for (let i = chunks.length - 1; i > 0; i--) {
    height += markdownHeight(chunks[i]!)
    if (height >= room) return i
  }
  return 0
}

/** The box that scrolls `el`, or null when only the page does. */
function scrollerOf(el: Element): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at)
    if (overflowY === 'auto' || overflowY === 'scroll') return at
  }
  return null
}

/** What the reader scrolls with, as against the thread following its end. */
const INTENT = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const

/** Where a chunk in view sat before others rendered, to keep it there after. */
interface Anchor {
  scroller: HTMLElement
  el: Element
  top: number
  taken: boolean
  stop: () => void
}

/** The first chunk, or its placeholder, that reaches into the scroller's view. */
function anchorIn(root: HTMLElement, scroller: HTMLElement): Anchor | null {
  const view = scroller.getBoundingClientRect()
  for (const el of root.children) {
    const box = el.getBoundingClientRect()
    if (box.bottom <= view.top) continue
    if (box.top >= view.bottom) return null
    const anchor: Anchor = { scroller, el, top: box.top, taken: false, stop: () => {} }
    // A scroll of the reader's own before the parts render is left alone.
    const intent = (): void => {
      anchor.taken = true
    }
    for (const name of INTENT) scroller.addEventListener(name, intent, { passive: true })
    anchor.stop = () => {
      for (const name of INTENT) scroller.removeEventListener(name, intent)
    }
    return anchor
  }
  return null
}

/**
 * Which chunks render. A long text shown already written renders only its last chunks at first,
 * then one more a frame towards its start, each in a transition; a chunk that comes into view
 * renders next. Opening a finished reply of 120 KB rendered all 16,000 of its elements at once,
 * which blocked the page for 0.9 s and kept it busy for 1.4 s before it showed.
 *
 * A chunk renders at its real height, not its placeholder's, so the chunk in view is kept where
 * it was. Chromium's scroll anchoring left a reply's chunks to jump by that difference for a frame
 * or two, until the thread caught up with its end.
 */
export function useRenderedChunks(
  chunks: readonly string[],
  live: boolean,
  root: RefObject<HTMLElement | null>,
) {
  const inParts = useContext(InPartsContext)
  const [from, setFrom] = useState(() => (inParts && !live ? firstRendered(chunks) : 0))
  const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set())
  const anchor = useRef<Anchor | null>(null)
  const scroller = useRef<HTMLElement | null | undefined>(undefined)
  const hold = useCallback((): void => {
    const el = root.current
    if (anchor.current || !el) return
    scroller.current ??= scrollerOf(el)
    if (scroller.current) anchor.current = anchorIn(el, scroller.current)
  }, [root])
  useEffect(() => {
    if (from === 0) return
    const frame = requestAnimationFrame(() => {
      hold()
      startTransition(() => setFrom((at) => Math.max(0, at - 1)))
    })
    return () => cancelAnimationFrame(frame)
  }, [from, hold])
  const show = useCallback(
    (index: number): void => {
      hold()
      startTransition(() => setSeen((now) => (now.has(index) ? now : new Set(now).add(index))))
    },
    [hold],
  )
  useLayoutEffect(() => {
    const held = anchor.current
    if (!held) return
    anchor.current = null
    held.stop()
    if (held.taken || !held.el.isConnected) return
    const moved = held.el.getBoundingClientRect().top - held.top
    if (Math.abs(moved) >= 1) held.scroller.scrollTop += moved
  }, [from, seen])
  useEffect(() => () => anchor.current?.stop(), [])
  // A text cut shorter renders its last chunk at once.
  const first = Math.min(from, chunks.length - 1)
  return { rendered: (index: number) => index >= first || seen.has(index), show }
}

/** How long a find waits for a text's parts to render before it looks at what has. */
const PARTS_WAIT_MS = 3000

/**
 * Resolves once every text in `within` has rendered all its parts, or after PARTS_WAIT_MS, so a
 * find looks for its words in the whole text rather than in the parts rendered so far.
 */
export function partsRendered(within: Element): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now()
    const check = (): void => {
      const waiting = within.querySelector('[data-parts-pending]') !== null
      if (!waiting || performance.now() - started > PARTS_WAIT_MS) resolve()
      else requestAnimationFrame(check)
    }
    check()
  })
}
