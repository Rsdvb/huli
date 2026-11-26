// Huli: what the consent card says of a Claude Code or Codex plugin converted into a Kettu plugin:
// that it was converted, what did not come over and why, and what changed on the way.

import {
  ArrowDataTransferHorizontalIcon,
  InformationCircleIcon,
  MinusSignCircleIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { PluginConversion } from '@shared/plugin-convert'
import { Icon } from '@renderer/components/affect/app-shell'
import { Group, Line } from './plugin-install'

export function ConversionLines({ conversion }: { conversion: PluginConversion }) {
  const { t } = useTranslation('marketplace')
  const changed = conversion.notes.filter((note) => note.name !== '')
  return (
    <>
      <div className="k-plug-note" data-selectable="">
        <Icon icon={ArrowDataTransferHorizontalIcon} size={15} />
        <span>
          {t(
            conversion.carried.length > 0
              ? 'plugin.converted.from'
              : 'plugin.converted.fromNothing',
            {
              harness: t(`plugin.converted.harness.${conversion.from}`),
            },
          )}
        </span>
      </div>
      {conversion.leftOut.length > 0 && (
        <Group heading={t('plugin.converted.leftOut', { count: conversion.leftOut.length })}>
          {conversion.leftOut.map((item, index) => (
            <Line
              key={`${item.kind}:${item.name}:${index}`}
              icon={MinusSignCircleIcon}
              title={
                <>
                  {t(`plugin.converted.kind.${item.kind}`)}{' '}
                  <span className="k-plug-domain">{item.name}</span>
                </>
              }
              note={item.text ?? item.message}
            />
          ))}
        </Group>
      )}
      {changed.length > 0 && (
        <Group heading={t('plugin.converted.changed')}>
          {changed.map((item, index) => (
            <Line
              key={`${item.name}:${index}`}
              icon={InformationCircleIcon}
              title={item.name}
              note={item.text ?? item.message}
            />
          ))}
        </Group>
      )}
    </>
  )
}
