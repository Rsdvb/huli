// Huli: Settings › Keyboard shortcuts: the shortcuts the user may rebind, the global screenshot
// hotkey, and the keys that stay as they are. The controls are in shortcut-rows.tsx.

import { KeyboardIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { SHORTCUT_GROUPS, SHORTCUT_IDS } from '@shared/shortcuts'
import { isWeb } from '@renderer/lib/platform'
import type { GroupDef, RowDef, SectionDef } from './model'
import { FixedKeys, ScreenshotControl, ShortcutControl } from './shortcut-rows'

function group(id: string, label: string): GroupDef {
  return { id, label }
}

export function useShortcutsSection(): SectionDef {
  const { t } = useTranslation(['settings', 'shell'])
  const rows: RowDef[] = SHORTCUT_IDS.map((id) => ({
    id,
    setting: `shortcuts.${id}`,
    group: group(SHORTCUT_GROUPS[id], t(`shell:shortcuts.groups.${SHORTCUT_GROUPS[id]}`)),
    render: () => <ShortcutControl id={id} />,
  }))
  return {
    id: 'shortcuts',
    title: t('sections.shortcuts'),
    description: t('pages.shortcuts'),
    icon: KeyboardIcon,
    rows: [
      ...(isWeb
        ? []
        : [
            {
              id: 'screenshot',
              setting: 'shortcuts.screenshot',
              group: group('global', t('shortcuts.groups.global')),
              render: () => <ScreenshotControl />,
            } satisfies RowDef,
          ]),
      ...rows,
      {
        id: 'fixed',
        setting: 'shortcuts.fixed',
        group: group('fixed', t('shortcuts.groups.fixed')),
        layout: 'block',
        render: () => <FixedKeys />,
      },
    ],
  }
}
