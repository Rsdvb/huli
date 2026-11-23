// Huli: a session's 工具调用 › in its More menu (简洁视图): how much of its agent's work its thread
// shows, its own choice or the settings'.

import { ViewOffSlashIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { isToolCallView, TOOL_CALL_VIEWS, type ToolCallView } from '@shared/zen-view'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { setThreadView, useDefaultThreadView, useThreadView } from '@renderer/stores/thread-view'

const FOLLOW = 'settings'

export function ZenMenu({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation(['session', 'settings'])
  const own = useThreadView((s) => s.bySession[sessionId] ?? null)
  const fallback = useDefaultThreadView()
  const label = (view: ToolCallView): string => t(`settings:general.toolCalls.${view}`)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MenuGlyph icon={ViewOffSlashIcon} />
        {t('zen.menu')}
        <span className="ml-auto pl-4 text-hint text-tertiary">{label(own ?? fallback)}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <DropdownMenuRadioGroup
          value={own ?? FOLLOW}
          onValueChange={(value: string) =>
            setThreadView(sessionId, isToolCallView(value) ? value : null)
          }
        >
          <DropdownMenuRadioItem value={FOLLOW} closeOnClick>
            {t('zen.followSettings', { view: label(fallback) })}
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {TOOL_CALL_VIEWS.map((view) => (
            <DropdownMenuRadioItem key={view} value={view} closeOnClick>
              {label(view)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
