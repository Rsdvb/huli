import {
  Component,
  startTransition,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { foldBulk } from '@shared/search-fold'
import { markdownHeight } from '@renderer/features/session/thread-items'

// A long text renders only its chunks near the view (chunks.ts cuts it at block boundaries); the
// others hold their place as placeholders of the size they were last laid out at. A streamed reply
// of 300 KB kept all 65,000 of its elements, 12,000 listeners and 220 MB of heap while its thread
// was open, and the renderer grew by 850 MB as it streamed.

/** The space a chunk takes while it is not rendered, as it was last laid out. */
export interface Slot {
  /** The length of the chunk's text it was laid out with. */
  length: number
  height: number
  /** The space between it and the chunk before, and the chunk after, margins collapsed. */
  before: number
  after: number
}

/** A chunk renders once it comes this near the view, by the scroller's height... */
const NEAR = '100% 0px'
/** ...and goes once it is this far, so a chunk at the edge does not come and go. */
const FAR = '200% 0px'
/** Chunks whose text holds the words that a find renders before it settles for the first. */
const FIND_TRIES = 8

/** A chunk's placeholder, which markdown-impl.tsx marks so. */
const isPlaceholder = (el: Element): boolean => el.hasAttribute('data-part-placeholder')

/** Which chunks are not rendered, and the place each that was rendered keeps. */
interface View {
  hidden: ReadonlySet<number>
  slots: ReadonlyMap<number, Slot>
}

/** A text's chunks and the places measured, kept while its message is not on screen. */
export interface SavedParts {
  markdown: string
  chunks: string[]
  retryAt: number
  slots: Map<number, Slot>
}

// The longest replies of a few sessions; one dropped only lays out at estimated heights again.
const SAVED_KEPT = 40
const saved = new Map<string, SavedParts>()

/**
 * The chunks and places a long text had when it was last shown, for a thread that returns to it to
 * lay it out at the same height, and so put its reader where they were.
 */
export function savedParts(key: string | null, markdown: string): SavedParts | null {
  if (key === null) return null
  const parts = saved.get(key)
  return parts && markdown.startsWith(parts.markdown) ? parts : null
}

export function saveParts(key: string | null, parts: SavedParts): void {
  if (key === null) return
  saved.delete(key)
  saved.set(key, parts)
  if (saved.size > SAVED_KEPT) saved.delete(saved.keys().next().value!)
}

/** The box that scrolls `el`, or null when only the page does. */
function scrollerOf(el: Element): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at)
    if (overflowY === 'auto' || overflowY === 'scroll') return at
  }
  return null
}

const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean =>
  a.size === b.size && [...a].every((i) => b.has(i))

/** The chunks hidden at first: all but the last ones that fill the view from the text's end. */
function firstHidden(chunks: readonly string[], slots: ReadonlyMap<number, Slot>): Set<number> {
  const hidden = new Set<number>()
  let height = 0
  let i = chunks.length - 1
  for (; i >= 0 && height < window.innerHeight; i--) {
    height += slots.get(i)?.height ?? markdownHeight(chunks[i]!)
  }
  for (; i >= 0; i--) if (i < chunks.length - 1) hidden.add(i)
  return hidden
}

/** The window over one text's chunks: what it observes, and the chunks held rendered. */
class Parts {
  root: HTMLElement | null = null
  scroller: HTMLElement | null = null
  chunks: readonly string[] = []
  /** The text is still being written, so its last chunk, the live tail, always renders. */
  live = false
  /** Each chunk's place, as measured whenever a rendered chunk lays out. */
  measured: Map<number, Slot>
  private near: IntersectionObserver | null = null
  private far: IntersectionObserver | null = null
  private sizes: ResizeObserver | null = null
  private observed = new Set<Element>()
  private inNear = new Map<number, boolean>()
  private inFar = new Map<number, boolean>()
  /**
   * The chunks a selection runs through, the chunk that has the focus and the one a find shows,
   * rendered whatever their place: a selection then copies, and quotes, all of its text.
   */
  private selected: { from: number; to: number } | null = null
  private focused = -1
  private found = -1
  private waiting: { index: number; resolve: (el: Element | null) => void }[] = []
  private apply: (next: (view: View) => View, urgent: boolean) => void

  constructor(
    measured: Map<number, Slot>,
    apply: (next: (view: View) => View, urgent: boolean) => void,
  ) {
    this.measured = measured
    this.apply = apply
  }

  start(root: HTMLElement): void {
    this.root = root
    this.scroller = scrollerOf(root)
    const options = { root: this.scroller }
    this.near = new IntersectionObserver((entries) => this.onNear(entries), {
      ...options,
      rootMargin: NEAR,
    })
    this.far = new IntersectionObserver((entries) => this.onFar(entries), {
      ...options,
      rootMargin: FAR,
    })
    this.sizes = new ResizeObserver(() => this.measure())
    root.addEventListener('focusin', this.onFocus)
    root.addEventListener('focusout', this.onFocus)
    register(this)
    this.committed()
  }

  stop(): void {
    this.near?.disconnect()
    this.far?.disconnect()
    this.sizes?.disconnect()
    this.observed.clear()
    this.root?.removeEventListener('focusin', this.onFocus)
    this.root?.removeEventListener('focusout', this.onFocus)
    unregister(this)
    for (const { resolve } of this.waiting) resolve(null)
    this.waiting = []
    this.root = null
  }

  /** After each render: observes the chunks and placeholders that are new. */
  committed(chunks = this.chunks, measured = this.measured, live = this.live): void {
    this.chunks = chunks
    this.measured = measured
    this.live = live
    const root = this.root
    if (!root || !this.near || !this.far || !this.sizes) return
    for (const el of this.observed) {
      if (el.parentElement === root) continue
      this.near.unobserve(el)
      this.far.unobserve(el)
      this.sizes.unobserve(el)
      this.observed.delete(el)
    }
    for (const el of root.children) {
      if (this.observed.has(el)) continue
      this.observed.add(el)
      this.near.observe(el)
      this.far.observe(el)
      if (!isPlaceholder(el)) this.sizes.observe(el)
    }
    this.waiting = this.waiting.filter(({ index, resolve }) => {
      const el = root.children[index]
      if (!el || isPlaceholder(el)) return true
      resolve(el)
      return false
    })
  }

  indexOf(node: Node | null): number {
    const root = this.root
    if (!root || !node) return -1
    let el = node instanceof Element ? node : node.parentElement
    while (el && el.parentElement !== root) el = el.parentElement
    return el ? Array.prototype.indexOf.call(root.children, el) : -1
  }

  /** The place of every rendered chunk, which a chunk then keeps while it is not rendered. */
  private measure(): void {
    const root = this.root
    if (!root) return
    const children = root.children
    for (let i = 0; i < children.length; i++) {
      const el = children[i]!
      if (isPlaceholder(el)) continue
      const box = el.getBoundingClientRect()
      const before = i > 0 ? box.top - children[i - 1]!.getBoundingClientRect().bottom : 0
      const after =
        i < children.length - 1 ? children[i + 1]!.getBoundingClientRect().top - box.bottom : 0
      this.measured.set(i, {
        length: this.chunks[i]?.length ?? 0,
        height: box.height,
        before: Math.max(0, before),
        after: Math.max(0, after),
      })
    }
  }

  private onNear(entries: IntersectionObserverEntry[]): void {
    let urgent = false
    const view = this.scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
    for (const entry of entries) {
      const i = this.indexOf(entry.target)
      if (i < 0) continue
      this.inNear.set(i, entry.isIntersecting)
      const box = entry.boundingClientRect
      // A placeholder on screen renders at once, one coming near in a transition.
      if (entry.isIntersecting && isPlaceholder(entry.target)) {
        urgent ||= box.bottom > view.top && box.top < view.bottom
      }
    }
    this.update(urgent)
  }

  private onFar(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const i = this.indexOf(entry.target)
      if (i >= 0) this.inFar.set(i, entry.isIntersecting)
    }
    // Chunks go at once, which costs little and moves nothing: in a transition they waited while a
    // fast stream's updates kept coming, and a reply streamed in 8 s kept 30,000 elements at its end.
    this.apply((view) => this.next(view, false), true)
  }

  private onFocus = (event: FocusEvent): void => {
    const into = event.type === 'focusin' ? event.target : event.relatedTarget
    const index = into instanceof Node ? this.indexOf(into) : -1
    if (index === this.focused) return
    this.focused = index
    this.update(true)
  }

  /** The chunks the selection runs through in this text, or null when it is not in it. */
  selectionChanged(selection: Selection | null): void {
    const root = this.root
    let next: { from: number; to: number } | null = null
    if (root && selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      if (range.intersectsNode(root)) {
        const last = root.children.length - 1
        // An end between two chunks is given as an offset into the text's own element.
        const at = (node: Node, offset: number, end: boolean): number =>
          node === root
            ? Math.min(last, Math.max(0, end ? offset - 1 : offset))
            : root.contains(node)
              ? this.indexOf(node)
              : end
                ? last
                : 0
        const from = at(range.startContainer, range.startOffset, false)
        const to = at(range.endContainer, range.endOffset, true)
        next = { from: Math.max(0, from), to: to < 0 ? last : to }
      }
    }
    const was = this.selected
    if (was?.from === next?.from && was?.to === next?.to) return
    this.selected = next
    this.update(next !== null)
  }

  /**
   * The next view: rendered chunks far from the view go, and with `show`, placeholders near it
   * render.
   */
  private next(view: View, show = true): View {
    const end = this.live ? this.chunks.length - 1 : this.chunks.length
    if (this.found >= 0 && this.inNear.get(this.found)) this.found = -1
    const hidden = new Set<number>()
    const selected = this.selected
    for (let i = 0; i < end; i++) {
      const held =
        i === this.found ||
        i === this.focused ||
        this.inNear.get(i) === true ||
        (selected !== null && i >= selected.from && i <= selected.to)
      const was = view.hidden.has(i)
      if (was ? !show || !held : !held && this.inFar.get(i) === false) hidden.add(i)
    }
    if (sameSet(hidden, view.hidden)) return view
    const slots = new Map(view.slots)
    for (const i of hidden) {
      const slot = this.measured.get(i)
      if (!view.hidden.has(i) && slot) slots.set(i, slot)
    }
    return { hidden, slots }
  }

  private update(urgent: boolean): void {
    if (!this.root) return
    this.apply((view) => this.next(view), urgent)
  }

  /**
   * Renders the first chunk whose text holds one of the folded `words` and that `shows` them
   * once rendered, trying a few, and resolves with it; with the first such chunk when none shows
   * them, and null when no chunk's text holds them.
   */
  async reveal(words: readonly string[], shows: (el: Element) => boolean): Promise<Element | null> {
    let first: Element | null = null
    let tries = 0
    for (let i = 0; i < this.chunks.length && tries < FIND_TRIES; i++) {
      const text = foldBulk(this.chunks[i]!)
      if (!words.some((word) => text.includes(word))) continue
      tries++
      const el = await this.show(i)
      if (!el) continue
      first ??= el
      if (shows(el)) return el
    }
    if (first) this.found = this.indexOf(first)
    return first
  }

  /** Renders the chunk at `index`, which stays until it has come into view once. */
  private show(index: number): Promise<Element | null> {
    const root = this.root
    if (!root) return Promise.resolve(null)
    this.found = index
    const el = root.children[index]
    if (el && !isPlaceholder(el)) return Promise.resolve(el)
    return new Promise((resolve) => {
      this.waiting.push({ index, resolve })
      this.update(true)
    })
  }
}

// One listener for the document's selection, however many long texts are shown.
const shown = new Set<Parts>()
const byRoot = new WeakMap<Element, Parts>()

function onSelectionChange(): void {
  const selection = document.getSelection()
  for (const parts of shown) parts.selectionChanged(selection)
}

function register(parts: Parts): void {
  if (shown.size === 0) {
    document.addEventListener('selectionchange', onSelectionChange)
  }
  shown.add(parts)
  if (parts.root) byRoot.set(parts.root, parts)
}

function unregister(parts: Parts): void {
  shown.delete(parts)
  if (parts.root) byRoot.delete(parts.root)
  if (shown.size === 0) {
    document.removeEventListener('selectionchange', onSelectionChange)
  }
}

/**
 * Renders the part of a long text in `within` that shows the folded `words`, which `shows` tells,
 * and resolves with it; null when no long text there holds them, as a short one is all rendered.
 */
export async function revealPart(
  within: Element,
  words: readonly string[],
  shows: (el: Element) => boolean,
): Promise<Element | null> {
  for (const root of within.querySelectorAll('.markdown')) {
    const parts = byRoot.get(root)
    const el = parts ? await parts.reveal(words, shows) : null
    if (el) return el
  }
  return null
}

/**
 * Which chunks of a text render: those near the view, the last while the text is written, and the
 * ones a selection, the focus or a find holds. A text shown already written renders only its end
 * at first, where a thread opens; one written while shown renders each chunk as it comes. A chunk
 * that is not rendered keeps its place (`slot`), so the text around it stays put.
 */
export function useRenderedChunks(
  chunks: readonly string[],
  live: boolean,
  root: RefObject<HTMLElement | null>,
  measured: Map<number, Slot>,
): { view: View; rendered: (index: number) => boolean; slot: (index: number) => Slot | null } {
  const [view, setView] = useState<View>(() => ({
    hidden: firstHidden(chunks, measured),
    slots: new Map(measured),
  }))
  const [parts] = useState(
    () =>
      new Parts(measured, (next, urgent) => {
        if (urgent) setView(next)
        else startTransition(() => setView(next))
      }),
  )
  const windowed = chunks.length > 1
  useLayoutEffect(() => parts.committed(chunks, measured, live))
  useLayoutEffect(() => {
    const el = root.current
    if (!windowed || !el) return
    parts.start(el)
    return () => parts.stop()
  }, [parts, root, windowed])
  const last = chunks.length - 1
  return {
    view,
    // A text cut back to one chunk, as a footnote makes it, renders it whatever was hidden.
    rendered: (index) => !windowed || (live && index >= last) || !view.hidden.has(index),
    slot: (index) => {
      const slot = view.slots.get(index)
      return slot && slot.length === chunks[index]?.length ? slot : null
    },
  }
}

/** Where the first chunk in view sat before others rendered or went, to keep it there after. */
interface Anchor {
  scroller: HTMLElement
  index: number
  top: number
}

/**
 * Keeps the chunk in view where it was as chunks around it render or go: one rendering above it
 * at its real height rather than its placeholder's would move it. Measured right before the
 * change is written to the page, so a scroll of the reader's own in between is left alone.
 */
export class KeepInPlace extends Component<{
  root: RefObject<HTMLElement | null>
  view: View
  children: ReactNode
}> {
  getSnapshotBeforeUpdate(previous: { view: View }): Anchor | null {
    const root = this.props.root.current
    const before = previous.view.hidden
    const after = this.props.view.hidden
    if (!root || before === after) return null
    const scroller = scrollerOf(root)
    if (!scroller) return null
    const { top, bottom } = scroller.getBoundingClientRect()
    let anchor: Anchor | null = null
    const children = root.children
    for (let i = 0; i < children.length; i++) {
      const box = children[i]!.getBoundingClientRect()
      if (box.bottom <= top) continue
      if (box.top >= bottom) break
      // Rather a chunk that stays as it is than one about to change.
      const changes = before.has(i) !== after.has(i)
      if (!anchor || !changes) anchor = { scroller, index: i, top: box.top }
      if (!changes) break
    }
    return anchor
  }

  componentDidUpdate(_: unknown, __: unknown, anchor: Anchor | null): void {
    const el = anchor && this.props.root.current?.children[anchor.index]
    if (!anchor || !el) return
    const moved = el.getBoundingClientRect().top - anchor.top
    if (Math.abs(moved) >= 0.5) anchor.scroller.scrollTop += moved
  }

  render(): ReactNode {
    return this.props.children
  }
}
