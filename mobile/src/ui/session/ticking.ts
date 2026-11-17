// The clock that sheets and lines counting down to a reset go by.

import { useEffect, useState } from 'react'

/** The time now, read again every 15 seconds while `on`. */
export function useTicking(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [on])
  return now
}
