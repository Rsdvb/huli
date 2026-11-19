// The running turn's mark: nine dots that act out what the turn does now, each only changing its
// opacity on its own offset into the phase's loop. The desktop plays KEYFRAMES through the Web
// Animations API, and its jump button's dots as CSS animations, whose keyframes in the renderer's
// globals.css must match KEYFRAMES; the phone plays the same data on its own native driver from
// the phase it already knows, never in step with the desktop.

import type { TurnPhaseName } from './turn-phase'

/** The phases with a pattern of their own: the waits show the attention mark instead. */
export type RunningPhase = Exclude<TurnPhaseName, 'approval'>

/** A loop's opacity stops, from 0 to 1 of the loop; the timing function eases between stops. */
export const KEYFRAMES = {
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
  // A soft bar sweeping across the columns and back: the edge columns light once a loop, the
  // middle one on the way over and on the way back.
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
} satisfies Record<string, readonly (readonly [number, number])[]>

export type DotKeyframes = keyof typeof KEYFRAMES

/** A dot's keyframes, or none for a still one, and where in the loop it starts, from 0 to 1. */
export interface TurnDot {
  keyframes: DotKeyframes | null
  at: number
}

export interface TurnDotPattern {
  ms: number
  easing: 'linear' | 'ease-in-out'
  dot: (x: number, y: number) => TurnDot
}

const STILL: TurnDot = { keyframes: null, at: 0 }

// Each dot's place on the edge, clockwise from the top left, by row; the centre is not on it.
const RING = [0, 1, 2, 7, -1, 3, 6, 5, 4]
// When in the loop each dot twinkles, scattered so no order shows.
const TWINKLE = [0, 0.53, 0.21, 0.78, 0.37, 0.91, 0.12, 0.66, 0.45]

const trail = (at: number): TurnDot => ({ keyframes: 'turn-dot-trail', at })
const fromCentre = (x: number, y: number) => Math.hypot(x - 1, y - 1)

export const PATTERNS = {
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
    dot: (x, y) => ({ keyframes: 'turn-dot-twinkle', at: (1 - TWINKLE[y * 3 + x]!) % 1 }),
  },
  read: { ms: 1500, easing: 'linear', dot: (x, y) => trail((y * 1.2 + x * 0.3) / 3.6) },
  search: {
    ms: 1600,
    easing: 'linear',
    dot: (x) =>
      x === 1
        ? { keyframes: 'turn-dot-sweep-mid', at: 0 }
        : { keyframes: 'turn-dot-sweep-edge', at: x / 4 },
  },
  edit: {
    ms: 1400,
    easing: 'ease-in-out',
    dot: (x, y) => ({ keyframes: 'turn-dot-swap', at: (x + y) % 2 ? 0.5 : 0 }),
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
    dot: (x, y) => ({ keyframes: 'turn-dot-fill', at: (y * 3 + x) * 0.05 }),
  },
} satisfies Record<string, TurnDotPattern>

export type TurnDotPatternName = keyof typeof PATTERNS

export const BY_PHASE: Record<RunningPhase, TurnDotPatternName> = {
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

/** The pattern a phase plays; a wait, or a phase this build does not know, plays the chase. */
export function turnDotPattern(phase: string | null | undefined): TurnDotPatternName {
  return (phase && BY_PHASE[phase as RunningPhase]) || 'chase'
}
