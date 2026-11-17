// The time, ticking: one timer for every component that shows the same kind of clock, running only
// while some does, so the clocks on screen redraw together in one pass rather than each on its own
// timer. By the minute for relative times such as 「3 分钟前」, by the tenth of a second for a
// running step's time.

import { useSyncExternalStore } from 'react'

function ticker(every: number): () => number {
  const listeners = new Set<() => void>()
  let now = Date.now()
  let timer: ReturnType<typeof setInterval> | null = null
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    if (!timer) {
      now = Date.now()
      timer = setInterval(() => {
        now = Date.now()
        for (const each of listeners) each()
      }, every)
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
  const read = () => now
  return () => useSyncExternalStore(subscribe, read)
}

export const useMinute = ticker(30_000)

/** The time to a tenth of a second, while a step that runs shows it. */
export const useTenth = ticker(100)
