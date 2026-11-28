import { useLayoutEffect, useRef, type RefObject } from 'react'
import { cn } from 'cn'
import type { TurnDotPatternName } from '@shared/turn-dots'
import { stepLoops } from '@renderer/app/window-front'
import { BY_PHASE, CELLS, turnDotLoops, type RunningPhase } from './turn-dot-patterns'

/**
 * Runs the pattern's loops on the box's dots through the Web Animations API, held paused and
 * stepped with every other loop of the window (app/window-front.ts); none while `still`.
 */
function useDotLoops(
  ref: RefObject<HTMLSpanElement | null>,
  pattern: TurnDotPatternName,
  slower: number,
  still: boolean,
): void {
  useLayoutEffect(() => {
    const box = ref.current
    if (!box || still) return
    const animations: Animation[] = []
    turnDotLoops(pattern, slower).forEach((loop, i) => {
      const dot = box.children[i]
      if (loop && dot) animations.push(dot.animate(loop.keyframes, loop.timing))
    })
    const release = stepLoops(animations, box)
    return () => {
      release()
      for (const animation of animations) animation.cancel()
    }
  }, [ref, pattern, slower, still])
}

function Dots() {
  return CELLS.map(([x, y]) => (
    <svg key={`${x}${y}`} viewBox="0 0 12 12" className="absolute inset-0 size-full">
      <circle cx={2 + x * 4} cy={2 + y * 4} r={1.4} />
    </svg>
  ))
}

/**
 * The running turn's mark: nine dots in the fox's orange acting out the phase. Each dot only
 * changes its opacity, on its own delay into the phase's loop; reduced motion holds the frame the
 * loop starts on, and a window out of front holds the frame it is on (app/window-front.ts).
 * `still` stops the loop, as when the mark has faded out.
 *
 * Huli: each dot is an SVG of its own over the whole box, drawing its circle where the single SVG
 * did, so the mark rasterizes to the same pixels at any scale. Its loop runs through the Web
 * Animations API, held paused and stepped a few times a second with every other loop of the
 * window (app/window-front.ts), so the mark draws a few frames a second, not one per frame of the
 * display; a CSS animation also woke the main thread at every turn of its loop, for the
 * `animationiteration` event React listens for.
 */
export function TurnDots({
  phase,
  still = false,
  className,
  slower = 1,
}: {
  phase: RunningPhase
  still?: boolean
  className?: string
  /** How many times longer than its phase's loop the walk takes, as in the live dock. */
  slower?: number
}) {
  const pattern = BY_PHASE[phase]
  const ref = useRef<HTMLSpanElement>(null)
  useDotLoops(ref, pattern, slower, still)
  return (
    <span
      key={pattern}
      ref={ref}
      data-turn-dots
      aria-hidden
      className={cn(
        'relative inline-block size-3 shrink-0 fill-current text-(--thread-fox)',
        className,
      )}
    >
      <Dots />
    </span>
  )
}

/**
 * Work that runs on after the turn: the running dots' walk round the edge at half its speed, in the
 * secondary text color, so it never reads as a running turn. Huli: stepped like TurnDots.
 */
export function BackgroundDots({ className }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useDotLoops(ref, BY_PHASE.working, 2, false)
  return (
    <span
      ref={ref}
      data-turn-dots
      aria-hidden
      className={cn(
        'relative inline-block size-3 shrink-0 animate-in fill-current text-secondary animation-duration-(--duration-base) fade-in',
        className,
      )}
    >
      <Dots />
    </span>
  )
}
