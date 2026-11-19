/**
 * Huli: whether the window is in front, for the running marks' loops (the turn's dots, the
 * "Writing" shimmer, the reply's caret), which hold their frame while the window is hidden or
 * another window has the focus instead of drawing every frame of the display behind it: a running
 * turn in the background cost about 40% of a core in the renderer and as much in the GPU process
 * on a 240 Hz display. `<html>` carries `data-window-away` for the loops CSS runs; the ones run
 * through the Web Animations API register here, and hold their frame under reduced motion too.
 * Focus inside one of the page's own frames still counts as in front.
 */

const loops = new Set<Animation>()
const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
let following = false
let held = false

const isHeld = (): boolean =>
  document.visibilityState !== 'visible' ||
  !document.hasFocus() ||
  document.documentElement.dataset.reduceMotion === 'always' ||
  reducedQuery.matches

function sync(): void {
  const root = document.documentElement
  root.toggleAttribute(
    'data-window-away',
    document.visibilityState !== 'visible' || !document.hasFocus(),
  )
  const next = isHeld()
  if (next === held) return
  held = next
  for (const loop of loops) {
    if (held) loop.pause()
    else loop.play()
  }
}

/** Starts following the window's focus and visibility; the first call is the one that counts. */
export function followWindowFront(): void {
  if (following) return
  following = true
  window.addEventListener('focus', sync)
  window.addEventListener('blur', sync)
  document.addEventListener('visibilitychange', sync)
  reducedQuery.addEventListener('change', sync)
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-reduce-motion'],
  })
  held = isHeld()
  sync()
}

/**
 * Holds `animations` on their frame whenever the window is out of front or motion is reduced, from
 * now until the returned function is called. Started under reduced motion, a loop keeps the frame
 * it starts on.
 */
export function holdLoops(animations: Animation[]): () => void {
  followWindowFront()
  for (const animation of animations) {
    loops.add(animation)
    if (held) animation.pause()
  }
  return () => {
    for (const animation of animations) loops.delete(animation)
  }
}
