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
 *
 * A loop also holds while it cannot be seen, under opacity 0 or `visibility: hidden`, and while its
 * own CSS rule pauses it, as an artifact card's glow at rest or the jump button's dots while the
 * thread's end shows. A step that moves nothing stops the timer until something could change that:
 * a pointer, a key, focus, a transition, a new loop, or a loop coming on screen.
 */

/** About eight steps a second; the chase's ring of eight dots takes one step each. */
export const TICK_MS = 120

const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

/** The loops by the element whose place on screen decides whether they step. */
const loops = new Map<Element, Set<Animation>>()
/** For a CSS loop, the element whose opacity and visibility say whether it can be seen. */
const frames = new Map<Element, Element>()
const onScreen = new Set<Element>()
let observer: IntersectionObserver | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let following = false
let reduced = false
let resting = false

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

/**
 * Whether a CSS animation's own rule pauses it now. Pausing it here hid that rule from the
 * animation itself, so the computed style tells.
 */
function pausedByStyle(animation: Animation): boolean {
  if (!(animation instanceof CSSAnimation)) return false
  const effect = animation.effect
  if (!(effect instanceof KeyframeEffect) || !effect.target) return false
  const style = getComputedStyle(effect.target, effect.pseudoElement)
  const index = style.animationName
    .split(',')
    .map((name) => name.trim())
    .indexOf(animation.animationName)
  const states = style.animationPlayState.split(',')
  return index !== -1 && states[index % states.length]?.trim() === 'paused'
}

function forget(element: Element): void {
  loops.delete(element)
  frames.delete(element)
  onScreen.delete(element)
  observer?.unobserve(element)
}

function tick(): void {
  timer = null
  const time = stepTime()
  // Everything is read before anything moves: a CSS animation's play state and an element's
  // visibility each bring the style up to date, which each step would make stale again.
  const due: Animation[] = []
  // Loops on one element's children, as the jump button's dots, share its frame.
  const seen = new Map<Element, boolean>()
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
    }
    if (animations.size === 0) {
      forget(element)
      continue
    }
    const frame = frames.get(element) ?? element
    let visible = seen.get(frame)
    if (visible === undefined) {
      visible = frame.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      seen.set(frame, visible)
    }
    if (!visible) continue
    for (const animation of animations) if (!pausedByStyle(animation)) due.push(animation)
  }
  for (const animation of due) show(animation, time)
  resting = due.length === 0
  schedule()
}

function schedule(): void {
  const run = onScreen.size > 0 && !isAway() && !reduced && !resting
  if (timer !== null) {
    if (run) return
    clearTimeout(timer)
    timer = null
  }
  if (run) timer = setTimeout(tick, TICK_MS - (performance.now() % TICK_MS))
}

/** Steps again after a step that moved nothing; the next such step rests again. */
function wake(): void {
  resting = false
  schedule()
}

function sync(): void {
  const next = isReduced()
  if (next && !reduced) {
    for (const animations of loops.values())
      for (const animation of animations) if (animation.playState !== 'idle') show(animation, 0)
  }
  reduced = next
  wake()
}

function observed(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    if (!loops.has(entry.target)) continue
    if (entry.isIntersecting) onScreen.add(entry.target)
    else onScreen.delete(entry.target)
  }
  wake()
}

/**
 * Holds `animation` paused and steps it while `element` is on screen, until it is cancelled.
 * `frame` is the element whose opacity and visibility say whether the loop can be seen.
 */
function track(animation: Animation, element: Element, frame: Element = element): void {
  let animations = loops.get(element)
  if (animations?.has(animation)) return
  if (!animations) {
    loops.set(element, (animations = new Set()))
    if (frame !== element) frames.set(element, frame)
    observer?.observe(element)
  }
  animations.add(animation)
  // One its rule pauses keeps the frame the rule holds it on.
  const held = pausedByStyle(animation)
  animation.pause()
  if (reduced) show(animation, 0)
  else if (!held) show(animation, stepTime())
  animation.addEventListener(
    'cancel',
    () => {
      const set = loops.get(element)
      set?.delete(animation)
      if (set?.size === 0) forget(element)
    },
    { once: true },
  )
  wake()
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
    // The loop may fade its own element, so whether it can be seen is its parent's to say.
    track(animation, target, target.parentElement ?? target)
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
  // What may show a held loop or let its rule run it: a hover, a press, a key, focus, or a fade.
  const stir = (): void => {
    if (resting) wake()
  }
  for (const type of [
    'pointerover',
    'pointerdown',
    'keydown',
    'focusin',
    'transitionrun',
    'transitionend',
  ])
    document.addEventListener(type, stir, { capture: true, passive: true })
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
