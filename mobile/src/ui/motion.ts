// The app's springs on the UI thread, tuned as UIKit's: a press settles in quickly and lets go
// with a little give, and things that move travel on a damped spring of about 0.4s.

import {
  useReducedMotion,
  withSpring,
  withTiming,
  type WithSpringConfig,
} from 'react-native-reanimated'

/** UIKit's default spring for things that move: damping 0.84 over about 0.4s. */
export const SPRING: WithSpringConfig = { dampingRatio: 0.84, duration: 400 }

/** A press going in: quick and without overshoot. */
export const PRESS_IN: WithSpringConfig = { dampingRatio: 1, duration: 180 }

/** A press letting go: a touch of give, as a UIKit control has. */
export const PRESS_OUT: WithSpringConfig = { dampingRatio: 0.62, duration: 420 }

/** Springs to a value, or eases there quickly when Reduce Motion is on. */
export function spring(to: number, config: WithSpringConfig, reduce: boolean | null): number {
  'worklet'
  return reduce ? withTiming(to, { duration: 120 }) : withSpring(to, config)
}

export { useReducedMotion }
