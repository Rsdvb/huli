// Huli: how often something of one key may happen within sliding windows, such as a session's notes
// or a routine's webhook requests. Nothing runs between calls: each one drops what has aged out,
// and the keys with nothing left.

export interface WindowLimit {
  windowMs: number
  max: number
}

export class WindowLimiter {
  private readonly seen = new Map<string, number[]>()
  private readonly longest: number

  constructor(
    private readonly limits: readonly WindowLimit[],
    private readonly now: () => number = Date.now,
  ) {
    this.longest = Math.max(...limits.map((limit) => limit.windowMs))
  }

  /** How long until the key may go again; 0 when it may now. */
  wait(key: string): number {
    const now = this.now()
    this.prune(now)
    const times = this.seen.get(key) ?? []
    let wait = 0
    for (const { windowMs, max } of this.limits) {
      const inWindow = times.filter((at) => now - at < windowMs)
      if (inWindow.length >= max) {
        wait = Math.max(wait, inWindow[inWindow.length - max]! + windowMs - now)
      }
    }
    return wait
  }

  /** Counts one of the key's when it is within every limit; else how long until it is. */
  take(key: string): { ok: true } | { ok: false; retryMs: number } {
    const retryMs = this.wait(key)
    if (retryMs > 0) return { ok: false, retryMs }
    this.seen.set(key, [...(this.seen.get(key) ?? []), this.now()])
    return { ok: true }
  }

  private prune(now: number): void {
    for (const [key, times] of this.seen) {
      const kept = times.filter((at) => now - at < this.longest)
      if (kept.length === 0) this.seen.delete(key)
      else if (kept.length !== times.length) this.seen.set(key, kept)
    }
  }
}
