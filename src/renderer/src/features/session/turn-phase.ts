import type { ControlStep } from '@shared/control'
import type { SessionView, ThreadState } from '@shared/thread'
import {
  awaitsAnswer,
  turnDoing as sharedDoing,
  type TurnDoing as SharedDoing,
  type TurnPhase,
} from '@shared/turn-phase'

export { awaitsAnswer, turnPhase, writingId, type TurnPhase } from '@shared/turn-phase'

/** The phase as the desktop says it, where a wait on questions alone reads as `question`. */
export type TurnPhaseName = TurnPhase['phase']

/** The phase with what it works on; see the shared `TurnDoing`. */
export interface TurnDoing extends Omit<SharedDoing, 'phase'> {
  phase: TurnPhaseName
}

/** What the agent is doing now, with what it works on; see the shared `turnDoing`. */
export function turnDoing(state: ThreadState | null | undefined): TurnDoing {
  const doing = sharedDoing(state)
  return doing.phase === 'approval' && awaitsAnswer(state) ? { ...doing, phase: 'question' } : doing
}

// These are read on every streamed chunk, so a long run of tool calls is read no further back.
const LOOKBACK = 64

/** The step the agent asked the user to do on a surface, while its card waits; else null. */
export function askedStep(state: ThreadState | null | undefined): ControlStep | null {
  if (!state) return null
  const { order, byId } = state
  for (let i = order.length - 1; i >= Math.max(0, order.length - LOOKBACK); i--) {
    const entry = byId[order[i]!]
    if (entry?.kind === 'control_ask') return entry.outcome === null ? entry.step : null
    if (entry?.kind === 'user') return null
  }
  return null
}

/**
 * The tokens the running turn has added to the context, from the context the agent reports during
 * the turn; null when it reports none, or after a compaction left the context smaller.
 */
export function turnTokens(session: SessionView | null | undefined): number | null {
  const start = session?.turnStartUsed ?? null
  const used = session?.usage?.used
  if (start === null || used === undefined) return null
  return used > start ? used - start : null
}

/**
 * Whether an entry is in the thread's latest turn: no message you sent as a turn of its own
 * follows it. A message steered into the turn does not start one.
 */
export function inLatestTurn(state: ThreadState, entryId: string): boolean {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const id = state.order[i]!
    if (id === entryId) return true
    const entry = state.byId[id]
    if (entry?.kind === 'user' && !entry.steered) return false
  }
  return false
}

/**
 * Whether the thread's latest tool call is one you rejected, with no message from you since: what
 * you write next most likely says what to do instead.
 */
export function endedOnRejection(state: ThreadState | null | undefined): boolean {
  if (!state) return false
  const { order, byId } = state
  for (let i = order.length - 1; i >= Math.max(0, order.length - LOOKBACK); i--) {
    const entry = byId[order[i]!]
    if (entry?.kind === 'user') return false
    if (entry?.kind === 'tool') {
      const result = entry.permissionResult
      return typeof result === 'object' && result !== null && result.kind.startsWith('reject')
    }
  }
  return false
}
