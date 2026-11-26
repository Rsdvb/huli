// Kettu's reports that a turn a session asked another one for ended, in the desktop's words: drawn
// from how each turn ended, never from the English sentence the agent was told.

import type { ReportedTurn, StopReason } from '@shared/thread'

export function reportStateText(stopReason: StopReason | null): string {
  switch (stopReason) {
    case 'end_turn':
      return '已结束'
    case 'cancelled':
      return '已停止'
    case 'refusal':
      return '被模型拒绝'
    case null:
      return '失败了'
    default:
      return '到了上限'
  }
}

/** One turn's words, 「标题」的回合已结束, or how many ended and whose. */
export function reportText(turns: readonly ReportedTurn[]): string {
  if (turns.length > 1) {
    return `${turns.length} 个会话的回合结束了：${turns.map((turn) => turn.title).join('、')}`
  }
  const turn = turns[0]
  return turn ? turnText(turn.title, turn.stopReason) : ''
}

export function turnText(title: string, stopReason: StopReason | null): string {
  return `「${title}」的回合${reportStateText(stopReason)}`
}
