import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hello, HostLink } from './link'
import type { KeyPair } from './noise'
import type { Transport } from './transport'

/** A link whose dials fail as told, and the failure counts its backoff was asked for. */
function failingLink(dial: () => Promise<Transport>) {
  const asked: number[] = []
  const link = new HostLink({
    dial,
    hostKey: new Uint8Array(32),
    key: {} as KeyPair,
    hello: hello({ kind: 'ios', version: '1', platform: 'test' }),
    retryDelay: (failures) => {
      asked.push(failures)
      return 60_000
    },
  })
  return { link, asked }
}

describe('reconnecting a link at once', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('skips the backoff wait and starts the backoff over', async () => {
    const dial = vi.fn(() => Promise.reject(new Error('offline')))
    const { link, asked } = failingLink(dial)
    link.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dial).toHaveBeenCalledTimes(2)
    expect(asked).toEqual([1, 2])

    link.reconnectNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(dial).toHaveBeenCalledTimes(3)
    expect(asked).toEqual([1, 2, 1])
    link.stop()
  })

  it('follows a try under way that fails with another at once, then backs off again', async () => {
    const fails: ((error: Error) => void)[] = []
    const dial = vi.fn(() => new Promise<Transport>((_, reject) => void fails.push(reject)))
    const { link, asked } = failingLink(dial)
    link.start()
    link.reconnectNow()
    expect(dial).toHaveBeenCalledTimes(1)

    fails[0]!(new Error('offline'))
    await vi.advanceTimersByTimeAsync(0)
    expect(dial).toHaveBeenCalledTimes(2)
    expect(asked).toEqual([])

    fails[1]!(new Error('offline'))
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toEqual([1])
    expect(dial).toHaveBeenCalledTimes(2)
    link.stop()
  })
})
