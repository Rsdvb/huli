// Huli: a session menu's 总管模式 › submenu: manager mode on or off between turns, its review loop,
// and whether its agent may answer its workers' low requests, which can change at any time.

import { Crown02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { canManage } from '@shared/manager'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { useSettingsStore } from '@renderer/stores/settings'
import { setManager } from './model'

export function ManagerMenu({
  summary,
}: {
  summary: Pick<SessionSummary, 'id' | 'agentId' | 'manager' | 'status'>
}) {
  const { t } = useTranslation('session')
  const defaults = useSettingsStore((s) => s.settings.manager ?? null)
  if (!canManage(summary.agentId)) return null
  const manager = summary.manager ?? null
  const between = summary.status === 'ready' || summary.status === 'closed'
  const choices = {
    autoReview: manager?.autoReview ?? defaults?.autoReview ?? true,
    approvals: manager?.approvals ?? defaults?.approvals ?? 'user',
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MenuGlyph icon={Crown02Icon} />
        <span className="min-w-0 flex-1 truncate">{t('manager.menu.title')}</span>
        <span className="shrink-0 pl-4 text-hint text-tertiary">
          {manager ? t('manager.menu.on') : t('manager.menu.off')}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <DropdownMenuCheckboxItem
          checked={!!manager}
          disabled={!between}
          onCheckedChange={(on) => void setManager(summary.id, on, on ? choices : undefined)}
          closeOnClick
        >
          {t('manager.menu.switch')}
        </DropdownMenuCheckboxItem>
        {manager && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={manager.autoReview}
              onCheckedChange={(autoReview) =>
                void setManager(summary.id, true, { ...choices, autoReview })
              }
              closeOnClick
            >
              {t('manager.chip.autoReview')}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={manager.approvals === 'low'}
              onCheckedChange={(low) =>
                void setManager(summary.id, true, { ...choices, approvals: low ? 'low' : 'user' })
              }
              closeOnClick
            >
              {t('manager.chip.approvals')}
            </DropdownMenuCheckboxItem>
          </>
        )}
        {!between && (
          <p className="px-2 py-1 text-hint text-tertiary">{t('manager.menu.betweenTurns')}</p>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
