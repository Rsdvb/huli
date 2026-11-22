// A judgment of one thing a request does: its level and the reason the card gives.

import type { RiskLevel } from '@shared/risk'
import type { Place } from './places'

export type RiskReason =
  // Low
  | 'readProject'
  | 'readCommand'
  | 'projectCheck'
  // Medium
  | 'editProject'
  | 'editConfig'
  | 'readOutside'
  | 'install'
  | 'download'
  | 'network'
  | 'projectScript'
  | 'outsideProject'
  | 'gitWrite'
  | 'mcp'
  | 'globRead'
  | 'unclearScope'
  | 'grant'
  // High
  | 'unsafe'
  | 'delete'
  | 'gitDanger'
  | 'writeOutside'
  | 'gitDir'
  | 'sensitive'
  | 'system'
  | 'unparsed'
  | 'unknownCommand'
  | 'unknown'
  | 'globalInstall'
  | 'publish'
  | 'upload'
  | 'mcpDanger'
  | 'input'

export interface Verdict {
  level: RiskLevel
  reason: RiskReason
  /** What the reason names, such as a path, a program or a tool. */
  detail?: string
}

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }

/** The longest detail a reason quotes. */
const DETAIL_CHARS = 80

export function verdict(level: RiskLevel, reason: RiskReason, detail?: string): Verdict {
  if (detail === undefined) return { level, reason }
  const shown = detail.length > DETAIL_CHARS ? `${detail.slice(0, DETAIL_CHARS - 1)}…` : detail
  return { level, reason, detail: shown }
}

export const low = (reason: RiskReason, detail?: string): Verdict => verdict('low', reason, detail)
export const medium = (reason: RiskReason, detail?: string): Verdict =>
  verdict('medium', reason, detail)
export const high = (reason: RiskReason, detail?: string): Verdict =>
  verdict('high', reason, detail)

/** The higher of two; on a tie, the first, so a line keeps the reason of its first such step. */
export function worst(a: Verdict, b: Verdict): Verdict {
  return RANK[b.level] > RANK[a.level] ? b : a
}

export function above(a: Verdict, level: RiskLevel): boolean {
  return RANK[a.level] > RANK[level]
}

/** Reading what lies there: the project is low, elsewhere medium, the system and keys high. */
export function readVerdict(place: Place, shown: string): Verdict {
  switch (place) {
    case 'project':
    case 'git':
      return low('readProject')
    case 'outside':
      return medium('readOutside', shown)
    case 'system':
      return high('system', shown)
    case 'secret':
      return high('sensitive', shown)
  }
}

/** Writing there: the project is medium, its `.git`, elsewhere, the system and keys high. */
export function writeVerdict(place: Place, shown: string): Verdict {
  switch (place) {
    case 'project':
      return medium('editProject')
    case 'git':
      return high('gitDir', shown)
    case 'outside':
      return high('writeOutside', shown)
    case 'system':
      return high('system', shown)
    case 'secret':
      return high('sensitive', shown)
  }
}
