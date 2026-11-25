// Huli: Settings > Features, this computer's: a switch for each of Kite's big optional
// features, from the registry in src/shared/features.ts. See tools/huli/README.md (Feature
// switches).

import { ToggleOnIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { FEATURE_IDS, featureOn } from '@shared/features'
import {
  FEATURE_GROUP,
  FEATURE_GROUPS,
  type FeatureGroup,
  type SettingId,
} from '@shared/settings-catalog'
import { useSettingsStore } from '@renderer/stores/settings'
import { platform } from '@renderer/lib/platform'
import {
  ComputerElevatedLink,
  ComputerUseLink,
  FeatureSwitch,
  PromptSuggestionsLink,
} from './features-rows'
import { WebReaderSwitch } from './web-reader-rows'
import type { GroupDef, RowDef, SectionDef } from './model'
import { GroupNote } from './rows'

export function useFeaturesSection(): SectionDef {
  const { t } = useTranslation('settings')
  // The default sandbox holds its switch on: hidden, new sessions would still start in it.
  const sandboxHeld = useSettingsStore((s) => s.settings.sandbox.tier !== 'off')
  const sandboxOn = useSettingsStore((s) => featureOn(s.settings.features, 'sandbox'))
  const groups = Object.fromEntries(
    FEATURE_GROUPS.map((id, i) => [
      id,
      {
        id: `features-${id}`,
        label: t(`features.groups.${id}`),
        ...(i === FEATURE_GROUPS.length - 1
          ? { note: <GroupNote>{t('features.note')}</GroupNote> }
          : {}),
      } satisfies GroupDef,
    ]),
  ) as Record<FeatureGroup, GroupDef>
  const rows: RowDef[] = FEATURE_GROUPS.flatMap((group) => [
    ...FEATURE_IDS.filter((id) => FEATURE_GROUP[id] === group).map((id): RowDef => ({
      id,
      setting: `features.${id}` as SettingId,
      group: groups[group],
      ...(id === 'sandbox' && sandboxHeld && sandboxOn
        ? { description: t('features.sandboxHeld') }
        : {}),
      render: () =>
        id === 'webReader' ? (
          <WebReaderSwitch label={t(`features.items.${id}.name`)} />
        ) : (
          <FeatureSwitch
            id={id}
            label={t(`features.items.${id}.name`)}
            held={id === 'sandbox' && sandboxHeld}
          />
        ),
    })),
    ...(group === 'work'
      ? [
          {
            id: 'prompt-suggestions',
            setting: 'features.prompt-suggestions',
            group: groups.work,
            render: () => <PromptSuggestionsLink />,
          } satisfies RowDef,
        ]
      : []),
    ...(group === 'agents'
      ? [
          {
            id: 'computer-use',
            setting: 'features.computer-use',
            group: groups.agents,
            render: () => <ComputerUseLink />,
          } satisfies RowDef,
          ...(platform === 'win32'
            ? [
                {
                  id: 'computer-elevated',
                  setting: 'features.computer-elevated',
                  group: groups.agents,
                  render: () => <ComputerElevatedLink />,
                } satisfies RowDef,
              ]
            : []),
        ]
      : []),
  ])
  return {
    id: 'features',
    title: t('sections.features'),
    description: t('pages.features'),
    icon: ToggleOnIcon,
    rows,
  }
}
