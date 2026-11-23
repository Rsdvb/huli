// Huli: the menu items of a group's own session order (shared/session-order.ts): 按最近活动排序 and
// 手动排序 in a project's, No project's or folder's menu, and 上移 / 下移 in a session's. Huli's own;
// see tools/huli/README.md (Session order).

import { ArrowDown02Icon, ArrowUp02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { canOrder } from '@shared/session-order'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@renderer/components/ui/dropdown-menu'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { formatShortcut } from '@renderer/lib/platform'
import { moveRow, rowPlace, setGroupOrder } from './row-drag'

/** The keys that move a focused row up and down in its group. */
export const MOVE_UP = 'Alt+↑'
export const MOVE_DOWN = 'Alt+↓'

/** How the group's rows go, for its menu; nothing on a host that cannot keep an order. */
export function GroupOrderItems({
  groupKey,
  order,
  disabled = false,
}: {
  groupKey: string
  order: readonly string[] | null | undefined
  disabled?: boolean
}) {
  const { t } = useTranslation('sidebar')
  if (!canOrder(order)) return null
  return (
    <DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('order.label')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={order ? 'manual' : 'activity'}
        onValueChange={(value: string) =>
          setGroupOrder(groupKey, value === 'manual' ? 'manual' : 'activity')
        }
      >
        <DropdownMenuRadioItem value="activity" disabled={disabled}>
          {t('order.activity')}
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="manual" disabled={disabled}>
          {t('order.manual')}
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  )
}

/** 上移 and 下移 for a session's row in a group that can take an order; nothing elsewhere. */
export function RowOrderItems({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('sidebar')
  // The menu's content mounts as it opens, so the row's place is read as it is then.
  const place = rowPlace(sessionId)
  if (!place) return null
  return (
    <>
      <DropdownMenuItem disabled={place.first} onClick={() => moveRow(sessionId, -1)}>
        <MenuGlyph icon={ArrowUp02Icon} />
        {t('order.moveUp')}
        <DropdownMenuShortcut>{formatShortcut(MOVE_UP)}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={place.last} onClick={() => moveRow(sessionId, 1)}>
        <MenuGlyph icon={ArrowDown02Icon} />
        {t('order.moveDown')}
        <DropdownMenuShortcut>{formatShortcut(MOVE_DOWN)}</DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  )
}
