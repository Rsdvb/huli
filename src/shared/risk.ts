// Huli: how risky an agent's permission request is, as the host judges it, and which requests the
// host may answer by itself.

/** 低: only reads, or runs the project's own checks. 中: changes the project or uses the network. 高: the rest. */
export type RiskLevel = 'low' | 'medium' | 'high'

export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high']

/** A request's level and why, in the host's words, which every client shows on the request's card. */
export interface PermissionRisk {
  level: RiskLevel
  reason: string
}

/**
 * Which requests the host allows once by itself: none, the low ones, or the low ones and edits of
 * files inside the project.
 */
export type AutoApprove = 'off' | 'low' | 'edits'

export const AUTO_APPROVE_LEVELS: readonly AutoApprove[] = ['off', 'low', 'edits']

export function isAutoApprove(value: unknown): value is AutoApprove {
  return typeof value === 'string' && (AUTO_APPROVE_LEVELS as readonly string[]).includes(value)
}

export function isPermissionRisk(value: unknown): value is PermissionRisk {
  if (typeof value !== 'object' || value === null) return false
  const { level, reason } = value as Record<string, unknown>
  return (
    typeof level === 'string' &&
    (RISK_LEVELS as readonly string[]).includes(level) &&
    typeof reason === 'string'
  )
}
