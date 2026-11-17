// The time by the minute, for relative times such as 「3 分钟前」: one timer for every row that
// shows one, running only while some row does.

import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const each of listeners) each()
    }, 30_000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

export function useMinute(): number {
  return useSyncExternalStore(subscribe, () => now)
}
