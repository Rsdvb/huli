// What a session's composer says in its empty field, by the desktop's rules (composer.tsx): the
// agent starting, an agent to pick, an approval waited for, a used-up plan window, a denied tool
// call, a running turn, or the agent to reply to.

import type { PlanLimit } from '@shared/agent-host'
import type { ThreadState } from '@shared/thread'
import { whenText, windowName } from './limits'

// How far back the thread is read for a denied tool call.
const LOOKBACK = 40

/**
 * Whether the thread's latest tool call is one the user rejected, with no message from them since:
 * what they write next most likely says what to do instead.
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

export function sessionPlaceholder(state: {
  agent: string
  starting: boolean
  /** The session's agent cannot go on, and none is picked yet. */
  pickAgent: boolean
  awaiting: boolean
  /** A question of the agent's waits above the composer, which the reply may answer too. */
  asking?: boolean
  running: boolean
  steering: boolean
  /** A used-up window of the session's model, with when it resets. */
  reached: PlanLimit | null
  rejected: boolean
}): string {
  if (state.starting) return `正在启动 ${state.agent}…`
  if (state.pickAgent) return '选一个 Agent 接着做…'
  if (state.asking) return '回复，或在上方作答'
  if (state.awaiting) return '等待你的授权'
  if (!state.running && state.reached?.resetsAt) {
    return `${windowName(state.reached)}限额已用完 · ${whenText(state.reached.resetsAt, Date.now())} 重置`
  }
  if (!state.running && state.rejected) return `告诉 ${state.agent} 改用什么做法`
  if (state.running)
    return state.steering ? '排队一条消息 · 按住发送键可插入这一轮' : '排队一条消息'
  return `回复 ${state.agent}…`
}
