import type { CSSProperties } from 'react'
import { BY_PHASE, CELLS, PATTERNS, type RunningPhase } from '@shared/turn-dots'

export { BY_PHASE, CELLS, type RunningPhase }

/**
 * Each cell's style for the phase, in CELLS order: its animation, or none for a still dot. The
 * keyframes are globals.css's turn-dot-* ones, which match KEYFRAMES in @shared/turn-dots.
 */
export function turnDotStyles(phase: RunningPhase): (CSSProperties | undefined)[] {
  const pattern = PATTERNS[BY_PHASE[phase]]
  return CELLS.map(([x, y]) => {
    const dot = pattern.dot(x, y)
    // A negative delay starts the dot partway into the loop, so every dot is in step at once.
    const delay = Math.round((dot.at - 1) * pattern.ms)
    return dot.keyframes
      ? { animation: `${dot.keyframes} ${pattern.ms}ms ${pattern.easing} ${delay}ms infinite` }
      : undefined
  })
}
