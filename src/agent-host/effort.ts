// Huli: the reasoning effort levels several agents name alike (low, high, xhigh...), in the
// user's language; a level no other agent shares keeps its own name.

import { t } from './i18n'

const LEVELS = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type Level = (typeof LEVELS)[number]

const isLevel = (value: string): value is Level => (LEVELS as readonly string[]).includes(value)

/** "high" as 高 or High; "extra_high" as Extra High. */
export function effortLevelName(level: string): string {
  const key = level.toLowerCase()
  if (isLevel(key)) return t(`effortLevel.${key}`)
  return level
    .split(/[_-]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ')
}
