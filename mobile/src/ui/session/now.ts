// The time, ticking: one timer for every component that shows the same kind of clock, running only
// while some does on a focused screen with the app active, so the clocks on screen redraw together
// in one pass rather than each on its own timer, and none redraws out of sight. By the minute for
// relative times such as 「3 分钟前」, by the second for what runs, by 15 seconds for a running
// row's minutes.

import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { useIsFocused } from 'expo-router'

const tickers = new Set<{ wake(): void; sleep(): void }>()
let active = AppState.currentState === 'active'
AppState.addEventListener('change', (next) => {
  const was = active
  active = next === 'active'
  if (was === active) return
  for (const each of tickers) {
    if (active) each.wake()
    else each.sleep()
  }
})

const idle = () => () => {}

function ticker(every: number): (on?: boolean) => number {
  const listeners = new Set<() => void>()
  let now = Date.now()
  let timer: ReturnType<typeof setInterval> | null = null
  const tell = () => {
    now = Date.now()
    for (const each of listeners) each()
  }
  const self = {
    wake() {
      if (timer || listeners.size === 0) return
      tell()
      timer = setInterval(tell, every)
    },
    sleep() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
  tickers.add(self)
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    if (!timer && active) {
      now = Date.now()
      timer = setInterval(tell, every)
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) self.sleep()
    }
  }
  const read = () => now
  // Off or out of sight, the clock holds the time it last showed.
  return function useTicker(on = true) {
    const focused = useIsFocused()
    return useSyncExternalStore(on && focused ? subscribe : idle, read)
  }
}

export const useMinute = ticker(30_000)

/** The time to the second, for the clocks of what runs, such as a running sub-agent's. */
export const useSecond = ticker(1000)

/** The time every 15 seconds, for a clock of minutes and hours that counts up. */
export const useQuarterMinute = ticker(15_000)
