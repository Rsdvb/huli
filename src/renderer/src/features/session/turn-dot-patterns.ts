import type { CSSProperties } from 'react'
import {
  BY_PHASE,
  CELLS,
  KEYFRAMES,
  PATTERNS,
  type RunningPhase,
  type TurnDotPatternName,
} from '@shared/turn-dots'

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

/** A dot's loop for Element.animate(). */
export interface DotLoop {
  keyframes: Keyframe[]
  timing: KeyframeAnimationOptions
}

/**
 * Huli: each cell's loop for the pattern, in CELLS order, or null for a still dot, for TurnDots to
 * run through the Web Animations API. As in CSS, the easing applies between each pair of stops and
 * a negative delay starts the dot partway into the loop.
 */
export function turnDotLoops(name: TurnDotPatternName): (DotLoop | null)[] {
  const pattern = PATTERNS[name]
  return CELLS.map(([x, y]) => {
    const dot = pattern.dot(x, y)
    if (!dot.keyframes) return null
    return {
      keyframes: KEYFRAMES[dot.keyframes].map(([offset, opacity]) => ({
        offset,
        opacity,
        easing: pattern.easing,
      })),
      timing: {
        duration: pattern.ms,
        delay: Math.round((dot.at - 1) * pattern.ms),
        iterations: Infinity,
      },
    }
  })
}
