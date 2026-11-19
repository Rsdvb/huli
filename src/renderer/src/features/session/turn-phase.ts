import type { ControlStep } from '@shared/control'
import type { SessionView, ThreadState } from '@shared/thread'
import {
  turnDoing as sharedDoing,
  turnPhase as sharedPhase,
  type TurnDoing as SharedDoing,
  type TurnPhaseName as SharedPhaseName,
} from '@shared/turn-phase'

export { writingId } from '@shared/turn-phase'

/**
 * The phase as the desktop says it: the host's, where a wait on questions alone reads as one for
 * your answer rather than your approval. The host's summary keeps `approval` for both, as the
 * devices that read it know no other.
 */
export type TurnPhaseName = SharedPhaseName | 'question'

/**
 * What the agent is doing now in its running turn. For a tool call's work, `count` is how many
 * such calls run at once; it is 1 otherwise.
 */
export interface TurnPhase {
  phase: TurnPhaseName
  count: number
}

/** The phase with what it works on; see the shared `TurnDoing`. */
export interface TurnDoing extends Omit<SharedDoing, 'phase'> {
  phase: TurnPhaseName
}

// The turn's latest entries are read no further back than this, as they are on every chunk.
const LOOKBACK = 64

/** The phase, from the turn's latest entries; see the shared `turnPhase`. */
export function turnPhase(state: ThreadState | null | undefined): TurnPhase {
  const phase = sharedPhase(state)
  return phase.phase === 'approval' && awaitsAnswer(state) ? { ...phase, phase: 'question' } : phase
}

/** What the agent is doing now, with what it works on; see the shared `turnDoing`. */
export function turnDoing(state: ThreadState | null | undefined): TurnDoing {
  const doing = sharedDoing(state)
  return doing.phase === 'approval' && awaitsAnswer(state) ? { ...doing, phase: 'question' } : doing
}

/**
 * Whether what the session waits on is a question to answer, not a permission, a plan or an MCP
 * server's request to decide: every pending request is one, as the thread's cards tell them apart.
 */
export function awaitsAnswer(state: ThreadState | null | undefined): boolean {
  if (!state) return false
  const { order, byId } = state
  let asked = false
  for (let i = order.length - 1; i >= Math.max(0, order.length - LOOKBACK); i--) {
    const entry = byId[order[i]!]
    if (entry?.kind !== 'tool' || !entry.permission) continue
    const { plan, elicitation, questions } = entry.permission
    if (plan || elicitation || (!questions && entry.question === undefined)) return false
    asked = true
  }
  return asked
}

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
