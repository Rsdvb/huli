import { describe, expect, it } from 'vitest'
import { LOWER_PRIORITY, processPriority, type PriorityCalls } from './priority'

/** A process at `start` whose raises fail when `raise` is false, as without privileges on Unix. */
function fakeOs(start: number, raise = true): PriorityCalls & { now: number; set: number[] } {
  const calls = {
    now: start,
    set: [] as number[],
    getPriority: () => calls.now,
    setPriority: (priority: number) => {
      if (!raise && priority < calls.now) throw new Error('EACCES')
      calls.set.push(priority)
      calls.now = priority
    },
  }
  return calls
}

describe("the agent host's priority", () => {
  it('lowers once, and restores what it found once turned off', () => {
    const os = fakeOs(0)
    const apply = processPriority(os)
    expect(apply(true)).toEqual({ kind: 'lowered', from: 0 })
    expect(apply(true)).toBeNull()
    expect(os.now).toBe(LOWER_PRIORITY)
    expect(apply(false)).toEqual({ kind: 'restored', to: 0 })
    expect(apply(false)).toBeNull()
    expect(os.set).toEqual([LOWER_PRIORITY, 0])
  })

  it('restores a priority above normal it found', () => {
    const os = fakeOs(-7)
    const apply = processPriority(os)
    apply(true)
    apply(false)
    expect(os.set).toEqual([LOWER_PRIORITY, -7])
  })

  it('leaves alone a process that started as low or lower', () => {
    for (const start of [LOWER_PRIORITY, 19]) {
      const os = fakeOs(start)
      const apply = processPriority(os)
      expect(apply(true)).toBeNull()
      expect(apply(false)).toBeNull()
      expect(os.set).toEqual([])
    }
  })

  it('does nothing while off, or for a parent that sends no setting', () => {
    const os = fakeOs(0)
    const apply = processPriority(os)
    expect(apply(false)).toBeNull()
    expect(apply(undefined)).toBeNull()
    expect(os.set).toEqual([])
  })

  it('stays low when it may not raise itself again, and tries again later', () => {
    const os = fakeOs(0, false)
    const apply = processPriority(os)
    apply(true)
    expect(apply(false)).toMatchObject({ kind: 'kept-low' })
    expect(os.now).toBe(LOWER_PRIORITY)
    expect(apply(true)).toBeNull()
    expect(apply(false)).toMatchObject({ kind: 'kept-low' })
  })

  it('never throws when the system refuses', () => {
    const apply = processPriority({
      getPriority: () => 0,
      setPriority: () => {
        throw new Error('EPERM')
      },
    })
    expect(apply(true)).toMatchObject({ kind: 'failed' })
    // Not lowered, so there is nothing to restore.
    expect(apply(false)).toBeNull()
  })
})
