import { useTranslation } from 'react-i18next'
import type { PlanLimit } from '@shared/agent-host'
import { limitLabel } from '@renderer/lib/format'
import { groupName } from '@renderer/lib/plan-limit'

/**
 * A window's short name where room is short, as the usage page's lines and the composer's tray:
 * 5h, 7d, 7d · Fable, 5h · Gemini, 30d; a window it does not know keeps the agent's own name.
 */
export function useShortWindow(): (limit: Pick<PlanLimit, 'window' | 'label'>) => string {
  const { t, i18n } = useTranslation(['usage', 'composer', 'tasks'])
  return (limit) => {
    const known = `composer:usage.shortWindow.${limit.window}`
    if (limit.window === 'rolling') return t('composer:usage.shortWindow.five_hour')
    if (limit.window === 'weekly') return t('composer:usage.shortWindow.seven_day')
    // A model group's line drops the "Models" and says "and" in the interface's language, as the
    // account menu's cards do, so "5h · Claude and GPT Models" fits a card beside its figure.
    if (limit.window.startsWith('seven_day_')) {
      const model = /^Weekly · (.+)$/.exec(limit.label)?.[1] ?? limitLabel(limit)
      return t('usage:limits.weeklyOf', { model: groupName(model, t('tasks:and')) })
    }
    if (limit.window.startsWith('five_hour_')) {
      const model = /^5-hour · (.+)$/.exec(limit.label)?.[1] ?? limitLabel(limit)
      return t('usage:limits.fiveHourOf', { model: groupName(model, t('tasks:and')) })
    }
    if (i18n.exists(known)) return t(known as 'composer:usage.shortWindow.five_hour')
    const counted = /^(\d+)_(minute|hour|day)$/.exec(limit.window)
    if (counted) {
      const unit = { minute: 'minutes', hour: 'hours', day: 'days' }[counted[2]!]!
      return t(`usage:limits.short.${unit}` as 'usage:limits.short.hours', {
        count: Number(counted[1]),
      })
    }
    return limitLabel(limit)
  }
}
