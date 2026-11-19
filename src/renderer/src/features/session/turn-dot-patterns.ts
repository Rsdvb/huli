import type { CSSProperties } from 'react'
import type { TurnPhase } from './turn-phase'

export type RunningPhase = Exclude<TurnPhase['phase'], 'approval' | 'question'>

/** A dot's keyframes in globals.css, and where in the loop it starts, from 0 to 1. */
interface Dot {
  name: string | null
  at: number
}

interface Pattern {
  ms: number
  easing: string
  dot: (x: number, y: number) => Dot
}

const STILL: Dot = { name: null, at: 0 }

// Each dot's place on the edge, clockwise from the top left, by row; the centre is not on it.
const RING = [0, 1, 2, 7, -1, 3, 6, 5, 4]
// When in the loop each dot twinkles, scattered so no order shows.
const TWINKLE = [0, 0.53, 0.21, 0.78, 0.37, 0.91, 0.12, 0.66, 0.45]

const trail = (at: number): Dot => ({ name: 'turn-dot-trail', at })
const fromCentre = (x: number, y: number) => Math.hypot(x - 1, y - 1)

const PATTERNS = {
  chase: {
    ms: 960,
    easing: 'linear',
    dot: (x, y) => {
      const place = RING[y * 3 + x]!
      return place < 0 ? STILL : trail(place / 8)
    },
  },
  think: {
    ms: 2000,
    easing: 'ease-in-out',
    dot: (x, y) => ({ name: 'turn-dot-twinkle', at: (1 - TWINKLE[y * 3 + x]!) % 1 }),
  },
  read: { ms: 1500, easing: 'linear', dot: (x, y) => trail((y * 1.2 + x * 0.3) / 3.6) },
  search: {
    ms: 1600,
    easing: 'linear',
    dot: (x) =>
      x === 1 ? { name: 'turn-dot-sweep-mid', at: 0 } : { name: 'turn-dot-sweep-edge', at: x / 4 },
  },
  edit: {
    ms: 1400,
    easing: 'ease-in-out',
    dot: (x, y) => ({ name: 'turn-dot-swap', at: (x + y) % 2 ? 0.5 : 0 }),
  },
  fetch: { ms: 1200, easing: 'linear', dot: (x, y) => trail(fromCentre(x, y) / 2.6) },
  compact: {
    ms: 1200,
    easing: 'linear',
    dot: (x, y) => trail((Math.SQRT2 - fromCentre(x, y)) / 2.6),
  },
  write: {
    ms: 1800,
    easing: 'linear',
    dot: (x, y) => ({ name: 'turn-dot-fill', at: (y * 3 + x) * 0.05 }),
  },
} satisfies Record<string, Pattern>

/** A loop the dots act out; phases share them. */
export type TurnDotPattern = keyof typeof PATTERNS

export const BY_PHASE: Record<RunningPhase, TurnDotPattern> = {
  thinking: 'think',
  execute: 'chase',
  read: 'read',
  search: 'search',
  fetch: 'fetch',
  edit: 'edit',
  writing: 'write',
  compacting: 'compact',
  working: 'chase',
}

/** The grid's cells by row, as [x, y]. */
export const CELLS = [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => [x, y] as const))

/**
 * Huli: the keyframes of globals.css's turn-dot-* animations, which the jump button's dots run as
 * CSS animations, for TurnDots to run through the Web Animations API; keep the two in step.
 */
const KEYFRAMES: Record<string, [offset: number, opacity: number][]> = {
  'turn-dot-trail': [
    [0, 1],
    [0.4, 0.22],
    [1, 0.22],
  ],
  'turn-dot-twinkle': [
    [0, 0.22],
    [0.15, 1],
    [0.3, 0.22],
    [1, 0.22],
  ],
  'turn-dot-swap': [
    [0, 0.22],
    [0.5, 1],
    [1, 0.22],
  ],
  'turn-dot-sweep-edge': [
    [0, 1],
    [0.125, 0.74],
    [0.25, 0.22],
    [0.75, 0.22],
    [0.875, 0.74],
    [1, 1],
  ],
  'turn-dot-sweep-mid': [
    [0, 0.22],
    [0.125, 0.36],
    [0.25, 1],
    [0.375, 0.36],
    [0.5, 0.22],
    [0.625, 0.36],
    [0.75, 1],
    [0.875, 0.36],
    [1, 0.22],
  ],
  'turn-dot-fill': [
    [0, 1],
    [0.55, 1],
    [0.62, 0.22],
    [1, 0.22],
  ],
}

/** A dot's loop for Element.animate(). */
export interface DotLoop {
  keyframes: Keyframe[]
  timing: KeyframeAnimationOptions
}

/**
 * Each cell's loop for the phase, in CELLS order, or null for a still dot. As with CSS, the easing
 * applies between each pair of keyframes, and a negative delay starts the dot partway into the
 * loop, so every dot is in step at once.
 */
export function turnDotLoops(name: TurnDotPattern): (DotLoop | null)[] {
  const pattern: Pattern = PATTERNS[name]
  return CELLS.map(([x, y]) => {
    const dot = pattern.dot(x, y)
    if (!dot.name) return null
    const frames = KEYFRAMES[dot.name] ?? []
    return {
      keyframes: frames.map(([offset, opacity]) => ({ offset, opacity, easing: pattern.easing })),
      timing: {
        duration: pattern.ms,
        delay: Math.round((dot.at - 1) * pattern.ms),
        iterations: Infinity,
      },
    }
  })
}

/** Each cell's style for the phase, in CELLS order: its animation, or none for a still dot. */
export function turnDotStyles(phase: RunningPhase): (CSSProperties | undefined)[] {
  const pattern: Pattern = PATTERNS[BY_PHASE[phase]]
  return CELLS.map(([x, y]) => {
    const dot = pattern.dot(x, y)
    // A negative delay starts the dot partway into the loop, so every dot is in step at once.
    const delay = Math.round((dot.at - 1) * pattern.ms)
    return dot.name
      ? { animation: `${dot.name} ${pattern.ms}ms ${pattern.easing} ${delay}ms infinite` }
      : undefined
  })
}
