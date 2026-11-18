import { describe, expect, it } from 'vitest'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import { limitDecision } from './fallback'

const NOW = 1_800_000_000_000

const week = (usedPercent: number): PlanLimit => ({
  window: 'seven_day',
  label: 'Weekly',
  usedPercent,
  resetsAt: NOW + 3_600_000,
  state: usedPercent >= 100 ? 'reached' : 'ok',
  observedAt: NOW,
})

const agent = (id: string, usedPercent: number, changes: Partial<AgentStatus> = {}) =>
  ({
    id,
    name: id,
    state: 'ready',
    signIn: 'signed-in',
    hidden: false,
    limits: [week(usedPercent)],
    ...changes,
  }) as AgentStatus

describe('limitDecision', () => {
  const statuses = [agent('codex', 100), agent('claude-code', 65), agent('opencode', 20)]

  it('waits when the routine chose to wait, whatever the others have left', () => {
    expect(limitDecision('wait', 'codex', statuses, NOW)).toEqual({ kind: 'wait' })
  })

  it('switches to the agent with the most room when the routine chose to', () => {
    expect(limitDecision('switch', 'codex', statuses, NOW)).toEqual({
      kind: 'switch',
      to: { agentId: 'opencode', name: 'opencode', usedPercent: 20 },
    })
  })

  it('waits when no other agent is below the share that would pause its own routines', () => {
    const near = [agent('codex', 100), agent('claude-code', 90), agent('gemini', 95)]
    expect(limitDecision('switch', 'codex', near, NOW)).toEqual({ kind: 'wait' })
  })

  it('never switches to an agent that is off or signed out', () => {
    const unusable = [
      agent('codex', 100),
      agent('claude-code', 10, { disabled: true }),
      agent('gemini', 10, { signIn: 'required' }),
    ]
    expect(limitDecision('switch', 'codex', unusable, NOW)).toEqual({ kind: 'wait' })
  })
})
