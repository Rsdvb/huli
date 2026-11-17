// A session's prompt cache as the composer shows it, by the desktop's rules (shared/prompt-cache.ts,
// features/prompt-cache): when it expires, whether it is warm, in its last minutes or gone, and the
// time it has left. The phase changes a few times in a cache's life, so a screen follows it; only
// the countdown itself ticks, each minute and then each second in the last five, in the one small
// view that shows it.

import { useEffect, useMemo, useState } from 'react'
import { AppState } from 'react-native'
import type { AgentAccount } from '@shared/agent-host'
import {
  cacheExpiry,
  cachePhase,
  endingWindow,
  knownExpiry,
  nextPhaseIn,
  type CachePhase,
  type KnownExpiry,
} from '@shared/prompt-cache'
import type { SessionView } from '@shared/thread'

/** Below this many tokens read again, an expired cache costs too little to warn about. */
export const CACHE_NOTICE_MIN_TOKENS = 20_000

const MINUTE = 60_000
/** The longest delay `setTimeout` takes; a longer one fires at once. */
const MAX_DELAY = 2 ** 31 - 1

/** When the session's cache expires, while its lifetime is known. */
export function useCacheExpiry(
  session: SessionView | undefined,
  account: AgentAccount | null,
): KnownExpiry | null {
  const expiry = session ? knownExpiry(cacheExpiry(session, account)) : null
  const at = expiry?.expiresAt ?? null
  const last = expiry?.lastRequestAt ?? null
  const estimate = expiry?.estimate ?? false
  const ttl = expiry?.ttl ?? null
  // The same object while nothing about the cache changed, so what follows it stays still.
  return useMemo(
    () =>
      at !== null && last !== null && ttl !== null
        ? { lastRequestAt: last, ttl, expiresAt: at, estimate }
        : null,
    [at, last, ttl, estimate],
  )
}

/** The cache's phase, rendering only as the last minutes start and as the cache expires. */
export function useCachePhase(expiry: KnownExpiry | null): CachePhase | null {
  const phaseNow = () =>
    expiry ? cachePhase(expiry.expiresAt, endingWindow(expiry.ttl), Date.now()) : null
  const [phase, setPhase] = useState(phaseNow)
  useEffect(() => {
    if (!expiry) {
      setPhase(null)
      return
    }
    const ending = endingWindow(expiry.ttl)
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      clearTimeout(timer)
      setPhase(cachePhase(expiry.expiresAt, ending, Date.now()))
      const wait = nextPhaseIn(expiry.expiresAt, ending, Date.now())
      if (wait !== null) timer = setTimeout(check, Math.min(wait + 50, MAX_DELAY))
    }
    check()
    // Timers stand still while the phone sleeps.
    const app = AppState.addEventListener('change', (state) => state === 'active' && check())
    return () => {
      clearTimeout(timer)
      app.remove()
    }
  }, [expiry])
  return phase
}

/** Milliseconds the cache has left, ticking each minute, then each second in its last five. */
export function useCacheLeft(expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      clearTimeout(timer)
      const at = Date.now()
      setNow(at)
      const left = expiresAt - at
      if (left <= 0) return
      const wait = left <= 5 * MINUTE ? 1000 - (left % 1000) + 20 : (left % MINUTE) + 50
      timer = setTimeout(tick, Math.min(wait, MINUTE))
    }
    tick()
    const app = AppState.addEventListener('change', (state) => state === 'active' && tick())
    return () => {
      clearTimeout(timer)
      app.remove()
    }
  }, [expiresAt])
  return Math.max(0, expiresAt - now)
}

/** 「4:59」 in the last minutes, else 「12 分钟」. */
export function cacheLeftText(left: number): string {
  if (left <= 0) return '已过期'
  if (left < 5 * MINUTE) {
    const s = Math.ceil(left / 1000)
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  if (left < 60 * MINUTE) return `${Math.floor(left / MINUTE)} 分钟`
  const h = Math.floor(left / (60 * MINUTE))
  const m = Math.floor((left % (60 * MINUTE)) / MINUTE)
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}
