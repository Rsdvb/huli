import { describe, expect, it } from 'vitest'
import { isOnLimit, isRoutineRun, type RoutineRun } from './routines'

const run: RoutineRun = {
  id: 'run-0123456789ab',
  routineId: 'r-0123456789ab',
  trigger: 'schedule',
  scheduledFor: 1,
  count: 1,
  status: 'succeeded',
  reason: null,
  sessionId: 's',
  startedAt: 1,
  endedAt: 2,
  workingMs: 1,
  stopReason: 'end_turn',
  error: null,
  output: null,
  usage: null,
  changedFiles: [],
  seen: false,
}

describe('isRoutineRun', () => {
  it('reads a run with or without the agent it switched to', () => {
    expect(isRoutineRun(run)).toBe(true)
    expect(
      isRoutineRun({
        ...run,
        switched: { from: 'codex', to: 'claude-code', reason: 'plan_limit' },
      }),
    ).toBe(true)
    expect(
      isRoutineRun({
        ...run,
        switched: { from: 'codex', to: 'claude-code', reason: 'limit_stop' },
      }),
    ).toBe(true)
  })

  it('refuses a switch without its agents or its reason', () => {
    expect(isRoutineRun({ ...run, switched: { from: 'codex', reason: 'plan_limit' } })).toBe(false)
    expect(
      isRoutineRun({ ...run, switched: { from: 'codex', to: 'claude-code', reason: 'other' } }),
    ).toBe(false)
    expect(
      isRoutineRun({ ...run, switched: { from: 'codex', to: 'no agent!', reason: 'plan_limit' } }),
    ).toBe(false)
    expect(isRoutineRun({ ...run, switched: null })).toBe(false)
  })
})

describe('isOnLimit', () => {
  it('takes only wait and switch', () => {
    expect(isOnLimit('wait')).toBe(true)
    expect(isOnLimit('switch')).toBe(true)
    expect(isOnLimit('skip')).toBe(false)
    expect(isOnLimit(undefined)).toBe(false)
  })
})
