// Huli: the sandbox a session runs in, on the composer's tray: its badge, whose tooltip lists what
// the sandbox allows, and a menu of the tiers with what each holds back and costs. New session's
// chip picks the sandbox the session starts in; a session's changes it between turns. A tier the
// agent cannot run in is listed, greyed, with the reason.

import type { Ref } from 'react'
import { useTranslation } from 'react-i18next'
import {
  SANDBOX_IMAGE_MB,
  SANDBOX_NETWORKS,
  supportsChoice,
  type AgentSandboxSupport,
  type SandboxChoice,
  type SandboxTier,
} from '@shared/sandbox'
import type { AgentId } from '@shared/thread'
import { Dropdown, type MenuItem } from '@renderer/components/affect/app-shell'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { sandboxAllowed, sandboxCost, sandboxLabel, type T } from './sandbox-text'

function tierItems(
  t: T,
  tier: Exclude<SandboxTier, 'off'>,
  support: AgentSandboxSupport,
  value: SandboxChoice,
  folder: string | null,
  onChange: (choice: SandboxChoice) => void,
): MenuItem[] {
  const own = support[tier]
  const setup = own.setup
    ? t(`sandbox.setup.${own.setup}`, { mb: SANDBOX_IMAGE_MB.download })
    : null
  const heading: MenuItem = {
    label: t(`sandbox.tier.${tier}`),
    heading: true,
    divider: true,
    description: own.available
      ? [sandboxCost(t, tier, folder), setup].filter(Boolean).join('. ')
      : `${t('sandbox.unsupported')}: ${t(`sandbox.block.${own.block ?? 'noSandbox'}`)}`,
  }
  if (!own.available) return [heading]
  return [
    heading,
    ...SANDBOX_NETWORKS.map((network) => {
      const held = own.networks.includes(network)
      const checked = value.tier === tier && value.network === network
      return {
        label: t(`sandbox.network.${network}`),
        checked,
        disabled: !held,
        ...(held ? {} : { description: t('sandbox.networkUnsupported') }),
        onSelect: () => !checked && onChange({ tier, network }),
      }
    }),
  ]
}

export function SandboxChip({
  agentId,
  hostId,
  value,
  folder,
  onChange,
  disabledHint,
  triggerRef,
}: {
  agentId: AgentId
  hostId: string | null
  value: SandboxChoice
  /** The session's folder, whose drive a container's cost depends on. */
  folder: string | null
  onChange: (choice: SandboxChoice) => void
  /** Why it cannot change now, as during a turn. */
  disabledHint?: string | null
  triggerRef?: Ref<HTMLButtonElement>
}) {
  const { t } = useTranslation('agents')
  const support = useAgentsStore((s) => agentsOn(s, hostId).byId[agentId]?.sandbox)
  if (!support) return null
  const items: MenuItem[] = [
    {
      label: t('sandbox.tier.off'),
      description: t('sandbox.offNote'),
      checked: value.tier === 'off',
      onSelect: () => value.tier !== 'off' && onChange({ tier: 'off', network: 'open' }),
    },
    ...tierItems(t, 'native', support, value, folder, onChange),
    ...tierItems(t, 'container', support, value, folder, onChange),
  ]
  const label = sandboxLabel(t, value)
  const allowed = sandboxAllowed(t, value)
  return (
    <Dropdown
      side="top"
      align="start"
      title={t('sandbox.menu')}
      items={items}
      trigger={({ open, toggle }) => (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                ref={triggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`${t('sandbox.menu')}: ${label}`}
                aria-disabled={disabledHint ? true : undefined}
                className="ui-as-tray-link kettu-tray-link--sandbox"
                data-on={value.tier !== 'off' || undefined}
                data-tone={supportsChoice(support, value) ? undefined : 'warn'}
                onClick={() => !disabledHint && toggle()}
              />
            }
          >
            <span className="kettu-tray-link__text">{label}</span>
          </TooltipTrigger>
          <TooltipContent>
            <span className="kettu-sandbox-tip">
              <b>{t('sandbox.allowed.title', { choice: label })}</b>
              {allowed.map((line) => (
                <span key={line}>{line}</span>
              ))}
              {disabledHint && <span>{disabledHint}</span>}
            </span>
          </TooltipContent>
        </Tooltip>
      )}
    />
  )
}
