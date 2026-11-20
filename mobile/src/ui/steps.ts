// The clock of what shows that something works: the running turn's dots, the avatar's typing
// bubble, the spinners of what runs. They step through their patterns a few times a second, all
// on this one clock, instead of each running an animation of its own that the screen redraws on
// every frame, 120 times a second on a ProMotion phone. Each step is one write of a shared value
// that the marks read on the UI thread, so a step redraws no React component. The clock ticks only
// while a mark that shows it is in front: on a focused screen, with the app active and Reduce
// Motion off; otherwise the marks hold still.

import { useEffect } from 'react'
import { AppState } from 'react-native'
import { useIsFocused } from 'expo-router'
import { makeMutable, type SharedValue } from 'react-native-reanimated'
import { useReduceMotion } from './Press'

/** How long a step lasts: eight a second. */
export const STEP_MS = 125

const clock = makeMutable(0)
let count = 0
let users = 0
let timer: ReturnType<typeof setInterval> | null = null
let active = AppState.currentState === 'active'

function run(): void {
  const on = users > 0 && active
  if (on && !timer) {
    timer = setInterval(() => {
      count += 1
      clock.value = count
    }, STEP_MS)
  } else if (!on && timer) {
    clearInterval(timer)
    timer = null
  }
}

AppState.addEventListener('change', (next) => {
  active = next === 'active'
  run()
})

/**
 * The step clock for a mark that shows while `on`: it ticks while some such mark is on a focused
 * screen and the app is active. Null under Reduce Motion, where the mark draws its first frame.
 */
export function useSteps(on = true): SharedValue<number> | null {
  const focused = useIsFocused()
  const reduce = useReduceMotion()
  const live = on && focused && !reduce
  useEffect(() => {
    if (!live) return
    users += 1
    run()
    return () => {
      users -= 1
      run()
    }
  }, [live])
  return reduce ? null : clock
}

/** A loop of `ms` as a whole number of steps, never fewer than `least`. */
export function stepsIn(ms: number, least = 4): number {
  return Math.max(least, Math.round(ms / STEP_MS))
}
