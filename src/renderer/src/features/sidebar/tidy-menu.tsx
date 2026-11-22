// Huli: a session menu's 稍后提醒 submenu, 收起 and 永不收起 (会话整理), for one session or for
// the several the sidebar has selected.

import {
  AlarmClockIcon,
  ArrowTurnBackwardIcon,
  BatteryChargingIcon,
  Calendar03Icon,
  CalendarAdd01Icon,
  Clock01Icon,
  InboxDownloadIcon,
  Moon02Icon,
  Notification03Icon,
  Sun03Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { snoozePresets, type SnoozePreset } from '@shared/session-tidy'
import { setNeverSettle } from '@renderer/app/actions'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { toast } from '@renderer/components/ui/toast'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { backTime } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { hostOfSession } from '@renderer/stores/sessions'
import {
  askSnoozeTime,
  planReturns,
  settleWithUndo,
  snoozeWithUndo,
  unsettle,
  wakeNow,
} from './tidy'

const PRESET_ICONS: Record<SnoozePreset, IconSvgElement> = {
  hour: Clock01Icon,
  tonight: Moon02Icon,
  tomorrow: Sun03Icon,
  monday: Calendar03Icon,
}

/** When the plan of every session's agent comes back, the latest of them; null when any is not known. */
function usePlanReturns(summaries: readonly SessionSummary[], now: number): number | null {
  return useAgentsStore((s) => {
    let latest = 0
    for (const summary of summaries) {
      const agent = agentsOn(s, hostOfSession(summary)).byId[summary.agentId]
      const back = planReturns(summary, agent, now)
      if (back === null) return null
      latest = Math.max(latest, back)
    }
    return summaries.length > 0 ? latest : null
  })
}

/**
 * 稍后提醒 ›: the quick choices with when each comes back, 额度恢复后 while the plan's reset is
 * known, a time of the user's own, and 取消推迟 for one snoozed already.
 */
export function SnoozeMenu({ summaries }: { summaries: readonly SessionSummary[] }) {
  const { t } = useTranslation('sidebar')
  // Shared with the list's relative times, and running only while the menu is open.
  const now = useNow()
  const reset = usePlanReturns(summaries, now)
  const ids = summaries.map((s) => s.id)
  const snoozed = summaries.filter((s) => !!s.snooze)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MenuGlyph icon={AlarmClockIcon} />
        {t('tidy.snooze')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        {snoozePresets(now).map(({ preset, until }) => (
          <DropdownMenuItem key={preset} onClick={() => snoozeWithUndo(ids, until)}>
            <MenuGlyph icon={PRESET_ICONS[preset]} />
            {t(`tidy.presets.${preset}`)}
            <DropdownMenuShortcut>{backTime(until, now)}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem disabled={reset === null} onClick={() => snoozeWithUndo(ids, 'reset')}>
          <MenuGlyph icon={BatteryChargingIcon} />
          {t('tidy.reset')}
          <DropdownMenuShortcut>
            {reset === null ? t('tidy.resetUnknown') : backTime(reset, now)}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => askSnoozeTime(ids)}>
          <MenuGlyph icon={CalendarAdd01Icon} />
          {t('tidy.custom')}
        </DropdownMenuItem>
        {snoozed.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => wakeNow(snoozed.map((s) => s.id))}>
              <MenuGlyph icon={Notification03Icon} />
              {t('tidy.wake')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** 收起, or 移回列表 when every one of them is settled already. */
export function SettleItem({ summaries }: { summaries: readonly SessionSummary[] }) {
  const { t } = useTranslation('sidebar')
  const ids = summaries.map((s) => s.id)
  const settled = summaries.length > 0 && summaries.every((s) => !!s.settled)
  if (settled) {
    return (
      <DropdownMenuItem onClick={() => unsettle(ids)}>
        <MenuGlyph icon={ArrowTurnBackwardIcon} />
        {t('tidy.unsettle')}
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenuItem onClick={() => settleWithUndo(ids)}>
      <MenuGlyph icon={InboxDownloadIcon} />
      {ids.length > 1 ? t('tidy.settleCount', { count: ids.length }) : t('tidy.settle')}
    </DropdownMenuItem>
  )
}

/** 永不收起: the settings' rules never settle the session. */
export function NeverSettleItem({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation('sidebar')
  const { useSettingsStore } = useHostScope()
  // Only while the rules settle sessions, unless the session has the choice already.
  const rules = useSettingsStore((s) => s.settings.tidy?.autoSettle ?? true)
  if (!rules && !summary.neverSettle) return null
  return (
    <DropdownMenuCheckboxItem
      checked={summary.neverSettle ?? false}
      onCheckedChange={(never) =>
        void setNeverSettle(summary.id, never).catch((error: unknown) => toast(errorMessage(error)))
      }
      closeOnClick
    >
      <MenuGlyph icon={InboxDownloadIcon} />
      {t('tidy.neverSettle')}
    </DropdownMenuCheckboxItem>
  )
}
