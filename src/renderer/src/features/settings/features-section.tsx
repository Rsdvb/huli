// Huli: Settings > Features, this computer's: a switch for each of Kite's big optional
// features, from the registry in src/shared/features.ts. See tools/huli/README.md (Feature
// switches).

import { useState } from 'react'
import { ToggleOnIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { FEATURE_IDS, featureOn, type FeatureId } from '@shared/features'
import {
  FEATURE_GROUP,
  FEATURE_GROUPS,
  type FeatureGroup,
  type SettingId,
} from '@shared/settings-catalog'
import { errorMessage } from '@renderer/lib/host'
import { useSettingsStore } from '@renderer/stores/settings'
import { openSettings } from '@renderer/stores/view'
import { ControlError, Pill, SetButton, SettingSwitch } from './controls'
import type { GroupDef, RowDef, SectionDef } from './model'
import { GroupNote } from './rows'

function FeatureSwitch({ id, label, held }: { id: FeatureId; label: string; held: boolean }) {
  const on = useSettingsStore((s) => featureOn(s.settings.features, id))
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={on}
        disabled={held && on}
        onChange={(next) => {
          setError(null)
          useSettingsStore
            .getState()
            .update({ features: { [id]: next } })
            .catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
    </>
  )
}

/** Computer use keeps its own switch on its own page; this row says where and how it is. */
function ComputerUseLink() {
  const { t } = useTranslation('settings')
  const on = useSettingsStore((s) => s.settings.computerUse.enabled)
  return (
    <span className="flex items-center gap-2">
      <Pill tone={on ? 'success' : 'neutral'}>
        {on ? t('features.computerUse.on') : t('features.computerUse.off')}
      </Pill>
      <SetButton variant="ghost" onClick={() => openSettings('computer-use')}>
        {t('features.computerUse.open')}
      </SetButton>
    </span>
  )
}

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
        ? {
            description: `${t('features.items.sandbox.description')} ${t('features.sandboxHeld')}`,
          }
        : {}),
      render: () => (
        <FeatureSwitch
          id={id}
          label={t(`features.items.${id}.name`)}
          held={id === 'sandbox' && sandboxHeld}
        />
      ),
    })),
    ...(group === 'agents'
      ? [
          {
            id: 'computer-use',
            setting: 'features.computer-use',
            group: groups.agents,
            render: () => <ComputerUseLink />,
          } satisfies RowDef,
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
