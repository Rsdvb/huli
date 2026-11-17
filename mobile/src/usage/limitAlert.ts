// A plan window that crossed 90% or ran out, while the app is in front: a banner with the window,
// its use and when it resets, which opens the agent's usage. The computer says each once per
// reset period; with the app away, its notification says it, by the same switch.

import { AppState } from 'react-native'
import { router } from 'expo-router'
import type { PlanAlert, PlanLimit } from '@shared/agent-host'
import { getPrefs } from '../prefs'
import { showNotice } from '../ui/NoticeBar'
import { inlineReset, windowName } from '../ui/session/limits'

/** Banners shown this run, so a reconnect that hears one again shows it once. */
const shown = new Set<string>()

function keyOf(alert: PlanAlert): string {
  return [alert.agentId, alert.provider ?? '', alert.window, alert.level, alert.resetsAt].join('\n')
}

/** The banner's line: 「Claude Code · 5 小时限额已用 92% · 2 小时后重置」. */
export function alertLine(alert: PlanAlert, now = Date.now()): string {
  const limit: PlanLimit = {
    window: alert.window,
    label: alert.label,
    usedPercent: alert.level === 100 ? 100 : alert.usedPercent,
    resetsAt: alert.resetsAt,
    state: alert.level === 100 ? 'reached' : 'ok',
    observedAt: now,
  }
  const reset = inlineReset(limit, now)
  const use =
    alert.level === 100
      ? `${windowName(limit)}限额已用完`
      : `${windowName(limit)}限额已用 ${Math.round(alert.usedPercent ?? 90)}%`
  return [alert.agentName, use, reset].filter(Boolean).join(' · ')
}

/** A computer's alert, shown while the app is in front and 额度提醒 is on. */
export function showLimitAlert(alert: PlanAlert): void {
  if (!getPrefs().limitAlerts || AppState.currentState !== 'active') return
  const key = keyOf(alert)
  if (shown.has(key)) return
  shown.add(key)
  showNotice({
    text: alertLine(alert),
    tone: 'warning',
    action: {
      label: '查看',
      onPress: () => {
        if (router.canDismiss()) router.dismissAll()
        router.navigate({
          pathname: '/usage',
          params: { agent: alert.agentId, at: String(Date.now()) },
        })
      },
    },
  })
}
