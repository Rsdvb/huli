// A session's prompt cache as the composer shows it, by the desktop's rules (shared/prompt-cache.ts,
// features/prompt-cache): when it expires, whether it is warm, in its last minutes or gone, and a
// clock that ticks each minute, then each second in its last five, so the countdown stays true.

import { useEffect, useState } from 'react'
import type { AgentAccount } from '@shared/agent-host'
import {
  cacheExpiry,
  cachePhase,
  endingWindow,
  knownExpiry,
  type CachePhase,
  type KnownExpiry,
} from '@shared/prompt-cache'
import type { SessionView } from '@shared/thread'

/** Below this many tokens read again, an expired cache costs too little to warn about. */
export const CACHE_NOTICE_MIN_TOKENS = 20_000

const MINUTE = 60_000

export interface CacheState {
  expiry: KnownExpiry
  phase: CachePhase
  /** Milliseconds left, 0 once expired. */
  left: number
}

export function useCacheState(
  session: SessionView | undefined,
  account: AgentAccount | null,
): CacheState | null {
  const expiry = session ? knownExpiry(cacheExpiry(session, account)) : null
  const expiresAt = expiry?.expiresAt ?? null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAt === null) return
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const at = Date.now()
      setNow(at)
      const left = expiresAt - at
      if (left <= 0) return
      const wait = left <= 5 * MINUTE ? 1000 - (left % 1000) + 20 : (left % MINUTE) + 50
      timer = setTimeout(tick, Math.min(wait, MINUTE))
    }
    tick()
    return () => clearTimeout(timer)
  }, [expiresAt])
  if (!expiry) return null
  return {
    expiry,
    phase: cachePhase(expiry.expiresAt, endingWindow(expiry.ttl), now),
    left: Math.max(0, expiry.expiresAt - now),
  }
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
