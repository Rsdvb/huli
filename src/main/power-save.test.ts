import { describe, expect, it } from 'vitest'
import { KeepAwake, staysAwake } from './power-save'

function fakePower() {
  const calls: string[] = []
  let next = 1
  return {
    calls,
    start: (type: 'prevent-app-suspension' | 'prevent-display-sleep') => {
      calls.push(`start:${type}`)
      return next++
    },
    stop: (id: number) => {
      calls.push(`stop:${id}`)
      return true
    },
  }
}

describe('staysAwake', () => {
  it('keeps the computer awake while a session works or a routine runs', () => {
    expect(staysAwake({ enabled: true, running: 1, routines: false })).toBe(true)
    expect(staysAwake({ enabled: true, running: 0, routines: true })).toBe(true)
    expect(staysAwake({ enabled: true, running: 0, routines: false })).toBe(false)
  })

  it('never keeps it awake with the setting off', () => {
    expect(staysAwake({ enabled: false, running: 3, routines: true })).toBe(false)
  })
})

describe('KeepAwake', () => {
  it('blocks system sleep once while anything works and releases it when all is idle', () => {
    const power = fakePower()
    const awake = new KeepAwake(true, power)
    awake.setRunning(1)
    awake.setRunning(2)
    awake.setRoutines(true)
    expect(power.calls).toEqual(['start:prevent-app-suspension'])
    awake.setRunning(0)
    expect(awake.blocking).toBe(true)
    awake.setRoutines(false)
    expect(power.calls).toEqual(['start:prevent-app-suspension', 'stop:1'])
    expect(awake.blocking).toBe(false)
  })

  it('follows the setting while sessions run', () => {
    const power = fakePower()
    const awake = new KeepAwake(false, power)
    awake.setRunning(1)
    expect(power.calls).toEqual([])
    awake.setEnabled(true)
    expect(awake.blocking).toBe(true)
    awake.setEnabled(false)
    expect(power.calls).toEqual(['start:prevent-app-suspension', 'stop:1'])
    expect(awake.blocking).toBe(false)
  })
})
