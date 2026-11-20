/**
 * Huli: the window's loops step a few times a second from one timer instead of drawing every frame
 * of the display. A loop is the turn's dots (run through the Web Animations API, which register
 * here) or any CSS animation that repeats forever: the reply's caret, the jump button's dots, a
 * running step's pulse, a spinner, a loading pulse. While one ran, Chromium drew a frame at the
 * display's rate for as long as a session ran, in the renderer and again in the GPU process, which
 * on macOS also composites the window's translucent material every frame.
 *
 * Each loop is held paused and moved to the current step every TICK_MS, so the page draws about
 * eight frames a second for it. The timer runs only while a loop's element is on screen, the window
 * is visible and in front, and motion is not reduced; otherwise each loop holds the frame it is on,
 * and under reduced motion the frame it starts on. Every loop takes its step from the same clock,
 * so marks shown together move together. Focus inside one of the page's own frames still counts as
 * in front.
 */

/** About eight steps a second; the chase's ring of eight dots takes one step each. */
export const TICK_MS = 120

const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

/** The loops by the element whose place on screen decides whether they step. */
const loops = new Map<Element, Set<Animation>>()
const onScreen = new Set<Element>()
let observer: IntersectionObserver | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let following = false
let reduced = false

const isAway = (): boolean => document.visibilityState !== 'visible' || !document.hasFocus()

const isReduced = (): boolean =>
  document.documentElement.dataset.reduceMotion === 'always' || reducedQuery.matches

/** The current step's time on the document timeline, which every loop shows. */
const stepTime = (): number => Math.floor(performance.now() / TICK_MS) * TICK_MS

function show(animation: Animation, time: number): void {
  try {
    animation.currentTime = time
  } catch {
    // An animation without a timeline any more has nothing to show.
  }
}

function forget(element: Element): void {
  loops.delete(element)
  onScreen.delete(element)
  observer?.unobserve(element)
}

function tick(): void {
  timer = null
  const time = stepTime()
  for (const element of onScreen) {
    const animations = loops.get(element)
    if (!animations || !element.isConnected) {
      forget(element)
      continue
    }
    for (const animation of animations) {
      // Cancelled without its event, as a CSS animation whose element lost the rule: setting its
      // time would bring it back.
      if (animation.playState === 'idle') animations.delete(animation)
      else show(animation, time)
    }
    if (animations.size === 0) forget(element)
  }
  schedule()
}

function schedule(): void {
  if (timer !== null) {
    if (onScreen.size > 0 && !isAway() && !reduced) return
    clearTimeout(timer)
    timer = null
  }
  if (onScreen.size === 0 || isAway() || reduced) return
  timer = setTimeout(tick, TICK_MS - (performance.now() % TICK_MS))
}

function sync(): void {
  const next = isReduced()
  if (next && !reduced) {
    for (const animations of loops.values())
      for (const animation of animations) if (animation.playState !== 'idle') show(animation, 0)
  }
  reduced = next
  schedule()
}

function observed(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    if (!loops.has(entry.target)) continue
    if (entry.isIntersecting) onScreen.add(entry.target)
    else onScreen.delete(entry.target)
  }
  schedule()
}

/** Holds `animation` paused and steps it while `element` is on screen, until it is cancelled. */
function track(animation: Animation, element: Element): void {
  let animations = loops.get(element)
  if (animations?.has(animation)) return
  if (!animations) {
    loops.set(element, (animations = new Set()))
    observer?.observe(element)
  }
  animations.add(animation)
  animation.pause()
  show(animation, reduced ? 0 : stepTime())
  animation.addEventListener(
    'cancel',
    () => {
      const set = loops.get(element)
      set?.delete(animation)
      if (set?.size === 0) forget(element)
    },
    { once: true },
  )
}

/** A CSS animation that just started: one that repeats forever becomes a stepped loop. */
function started(event: AnimationEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const pseudo = event.pseudoElement || null
  const candidates = pseudo ? target.getAnimations({ subtree: true }) : target.getAnimations()
  for (const animation of candidates) {
    if (!(animation instanceof CSSAnimation) || animation.animationName !== event.animationName)
      continue
    const effect = animation.effect as KeyframeEffect | null
    if (!effect || effect.target !== target || (effect.pseudoElement || null) !== pseudo) continue
    if (effect.getTiming().iterations !== Infinity) continue
    // Scroll-driven ones follow the scroll, not time.
    if (animation.timeline !== document.timeline) continue
    track(animation, target)
  }
}

/** Starts following the window's focus and visibility; the first call is the one that counts. */
export function followWindowFront(): void {
  if (following) return
  following = true
  observer = new IntersectionObserver(observed)
  window.addEventListener('focus', sync)
  window.addEventListener('blur', sync)
  document.addEventListener('visibilitychange', sync)
  document.addEventListener('animationstart', started, true)
  reducedQuery.addEventListener('change', sync)
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-reduce-motion'],
  })
  reduced = isReduced()
  sync()
}

/**
 * Steps `animations`, loops made with Element.animate(), while `element` is on screen, until the
 * returned function is called. Started under reduced motion, a loop keeps the frame it starts on.
 */
export function stepLoops(animations: Animation[], element: Element): () => void {
  followWindowFront()
  for (const animation of animations) track(animation, element)
  return () => {
    const set = loops.get(element)
    if (!set) return
    for (const animation of animations) set.delete(animation)
    if (set.size === 0) forget(element)
  }
}
