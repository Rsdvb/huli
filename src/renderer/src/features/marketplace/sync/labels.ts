// Marketplace › Sync's names: of the agents a place serves, of formats and of read problems.

import { useTranslation } from 'react-i18next'
import type { SyncFormat, SyncReadProblem } from '@shared/agent-sync'
import type { AgentId } from '@shared/thread'
import { useAgentName } from '../hooks'

/** The agents' own names for their formats, which a conversion note names. */
export const FORMAT_NAMES: Record<SyncFormat, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  opencode: 'OpenCode',
  'opencode-v2': 'OpenCode',
  kilo: 'Kilo',
  copilot: 'Copilot CLI',
  cursor: 'Cursor',
  droid: 'Droid',
  amp: 'Amp',
  pi: 'Pi',
  qoder: 'Qoder',
}

export function useAgentsLabel(): (agentIds: readonly AgentId[]) => string {
  const name = useAgentName()
  return (agentIds) => agentIds.map(name).join(', ')
}

export function useProblemText(): (problem: SyncReadProblem, detail?: string | null) => string {
  const { t } = useTranslation('marketplace')
  return (problem, detail) => t(`sync.readProblem.${problem}`, { detail: detail ?? '' })
}
