import { useLayoutEffect, useRef } from 'react'
import { cn } from 'cn'
import { holdLoops } from '@renderer/app/window-front'
import { BY_PHASE, CELLS, turnDotLoops, type RunningPhase } from './turn-dot-patterns'

/**
 * The running turn's mark: nine dots in the fox's orange acting out the phase. Each dot only
 * changes its opacity, on its own delay into the phase's loop; reduced motion holds the frame the
 * loop starts on, and a window out of front holds the frame it is on (app/window-front.ts).
 * `still` stops the loop, as when the mark has faded out.
 *
 * Huli: each dot is an SVG of its own over the whole box, drawing its circle where the single SVG
 * did, so the mark rasterizes to the same pixels at any scale, and its loop runs through the Web
 * Animations API. Both keep it off the main thread: a circle's opacity inside one SVG repainted
 * the mark every frame of the display, and a CSS animation still woke the main thread at every
 * turn of its loop, for the `animationiteration` event React listens for.
 */
export function TurnDots({
  phase,
  still = false,
  className,
}: {
  phase: RunningPhase
  still?: boolean
  className?: string
}) {
  const pattern = BY_PHASE[phase]
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const box = ref.current
    if (!box || still) return
    const animations: Animation[] = []
    turnDotLoops(pattern).forEach((loop, i) => {
      const dot = box.children[i]
      if (loop && dot) animations.push(dot.animate(loop.keyframes, loop.timing))
    })
    const release = holdLoops(animations)
    return () => {
      release()
      for (const animation of animations) animation.cancel()
    }
  }, [pattern, still])
  return (
    <span
      key={pattern}
      ref={ref}
      data-turn-dots
      aria-hidden
      className={cn(
        'relative inline-block size-3 shrink-0 animate-in fill-current text-(--thread-fox) animation-duration-(--duration-base) fade-in',
        className,
      )}
    >
      {CELLS.map(([x, y]) => (
        <svg key={`${x}${y}`} viewBox="0 0 12 12" className="absolute inset-0 size-full">
          <circle cx={2 + x * 4} cy={2 + y * 4} r={1.4} />
        </svg>
      ))}
    </span>
  )
}
