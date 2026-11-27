import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_BYTES_PER_TOKEN,
  largeContext,
  partsTraffic,
  requestUpload,
  sessionTraffic,
  UPLOAD_BYTES_PER_TOKEN,
} from './traffic'

describe('traffic estimated from the tokens an agent reports', () => {
  it('counts every request’s whole input as uploaded, cached or not, and the output as downloaded', () => {
    // Fifty requests at 900K tokens of context, nearly all read from the cache.
    const traffic = sessionTraffic({
      total: 45_120_000,
      input: 50_000,
      cacheRead: 44_900_000,
      cacheWrite: 50_000,
      output: 120_000,
      thought: 30_000,
    })
    expect(traffic).toEqual({
      up: 45_000_000 * UPLOAD_BYTES_PER_TOKEN,
      down: 120_000 * DOWNLOAD_BYTES_PER_TOKEN,
    })
    // About 180 MB up for one long turn: the cache saves money, not bytes.
    expect(traffic!.up).toBe(180_000_000)
  })

  it('takes an agent that reports no cache, and none for one that reports no totals', () => {
    expect(
      sessionTraffic({
        total: 1_100,
        input: 1_000,
        cacheRead: null,
        cacheWrite: null,
        output: 100,
        thought: null,
      }),
    ).toEqual({ up: 4_000, down: 1_600 })
    expect(sessionTraffic(null)).toBeNull()
    expect(sessionTraffic(undefined)).toBeNull()
    expect(
      sessionTraffic({ total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thought: 0 }),
    ).toBeNull()
  })

  it('sums the usage page’s rows the same way', () => {
    expect(partsTraffic({ input: 10, cacheRead: 80, cacheWrite: 10, output: 5 })).toEqual({
      up: 400,
      down: 80,
    })
  })

  it('uploads the whole context with each request', () => {
    expect(requestUpload(900_000)).toBe(3_600_000)
    expect(requestUpload(-1)).toBe(0)
  })
})

describe('a large context', () => {
  it('is 300K tokens, or 60% of the window once it holds 100K', () => {
    expect(largeContext({ used: 300_000, size: 1_000_000 })).toBe(true)
    expect(largeContext({ used: 299_999, size: 1_000_000 })).toBe(false)
    expect(largeContext({ used: 160_000, size: 256_000 })).toBe(true)
    expect(largeContext({ used: 150_000, size: 256_000 })).toBe(false)
    // A small window's context is never large on its share alone.
    expect(largeContext({ used: 90_000, size: 128_000 })).toBe(false)
    expect(largeContext({ used: 120_000, size: 200_000 })).toBe(true)
  })

  it('is not one the agent has not reported', () => {
    expect(largeContext(null)).toBe(false)
    expect(largeContext({ used: 0, size: 0 })).toBe(false)
    expect(largeContext({ used: 400_000, size: 0 })).toBe(true)
    expect(largeContext({ used: 150_000, size: 0 })).toBe(false)
  })
})
