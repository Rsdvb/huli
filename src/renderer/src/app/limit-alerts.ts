// A plan window that crossed 90% or ran out, as the window shows it: a toast with the window, its
// use and when it resets, View usage and Switch agent. The host says each once per reset period;
// while no window is in front, main's notification says it too, by the same switch.

import type { PlanAlert } from '@shared/agent-host'
import { alertToast } from '@renderer/components/ui/toast'
import { planReset } from '@renderer/features/sidebar/plan-usage'
import { backTime, limitPhrase } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { askAgentSwitch } from '@renderer/stores/agent-switch'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { openUsage, useViewStore } from '@renderer/stores/view'
import { newSession } from './actions'

/** Toasts shown this run, so an account two hosts share says each crossing once. */
const shown = new Set<string>()

/** Ten minutes: two hosts read the same reset to the minute or the second. */
const RESET_BUCKET = 10 * 60_000

function alertKey(alert: PlanAlert): string {
  const reset = alert.resetsAt === null ? '' : Math.round(alert.resetsAt / RESET_BUCKET)
  return [alert.agentId, alert.provider ?? '', alert.window, alert.level, reset].join('\n')
}

/**
 * Switch agent: the session shown, when it is on the agent that is running out and between turns,
 * opens its agent menu; anywhere else New session opens, where the agent is picked.
 */
function switchAgent(alert: PlanAlert, hostId: string | null): void {
  const main = useViewStore.getState().main
  const summary =
    main.kind === 'session' ? useSessionsStore.getState().byId[main.sessionId] : undefined
  if (
    summary &&
    summary.agentId === alert.agentId &&
    hostOfSession(summary) === hostId &&
    (summary.status === 'ready' || summary.status === 'closed')
  ) {
    askAgentSwitch(summary.id)
    return
  }
  newSession()
}

/** A host's alert, shown when the window is in front and Plan limit alerts is on. */
export function showLimitAlert(alert: PlanAlert, hostId: string | null): void {
  if (!useSettingsStore.getState().settings.notifications.limits) return
  const key = alertKey(alert)
  if (shown.has(key)) return
  shown.add(key)
  const now = Date.now()
  const out = alert.level === 100
  const params = { agent: alert.agentName, limit: limitPhrase(alert) }
  const title = out
    ? i18n.t('usage:alert.out', params)
    : i18n.t('usage:alert.near', {
        ...params,
        percent: Math.round(alert.usedPercent ?? alert.level),
      })
  const detail =
    alert.resetsAt === null || alert.resetsAt <= now
      ? i18n.t('usage:alert.noReset')
      : out
        ? i18n.t('usage:alert.back', { time: backTime(alert.resetsAt, now) })
        : planReset(alert.resetsAt, now)
  alertToast(
    title,
    detail,
    [
      { label: i18n.t('usage:alert.viewUsage'), onClick: openUsage },
      { label: i18n.t('usage:alert.switchAgent'), onClick: () => switchAgent(alert, hostId) },
    ],
    out ? 'danger' : 'warning',
  )
}
