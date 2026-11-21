// Huli: the API provider profile a session runs with, on the composer's tray: its name, and a menu
// of the agent's profiles and its own sign-in to run the next turn with. New session's chip picks
// the profile the session starts with.

import type { Ref } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { Dropdown } from '@renderer/components/affect/app-shell'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'

export function ProfileChip({
  agentId,
  hostId,
  value,
  onChange,
  disabledHint,
  triggerRef,
}: {
  agentId: AgentId
  hostId: string | null
  /** The profile chosen; null for the agent's own sign-in. */
  value: string | null
  onChange: (profileId: string | null) => void
  /** Why it cannot change now, as during a turn. */
  disabledHint?: string | null
  triggerRef?: Ref<HTMLButtonElement>
}) {
  const { t } = useTranslation('agents')
  const status = useAgentsStore((s) => agentsOn(s, hostId).byId[agentId])
  const profiles = status?.profiles
  if (!status || !profiles || profiles.items.length === 0) return null
  const chosen = profiles.items.find((p) => p.id === value)
  // A profile removed since the session took it: its next turn waits for another.
  const gone = value !== null && !chosen
  const label = chosen?.name ?? t(gone ? 'profiles.gone' : 'profiles.ownShort')
  const items = [
    { label: t('profiles.menu'), heading: true },
    {
      label: t('profiles.own', { name: status.harnessName }),
      ...(profiles.defaultId === null ? { description: t('profiles.default') } : {}),
      checked: value === null,
      onSelect: () => value !== null && onChange(null),
    },
    ...profiles.items.map((profile) => ({
      label: profile.name,
      description: [
        ...(t(`profiles.preset.${profile.preset}`) === profile.name
          ? []
          : [t(`profiles.preset.${profile.preset}`)]),
        ...(profile.id === profiles.defaultId ? [t('profiles.default')] : []),
      ].join(' · '),
      checked: value === profile.id,
      onSelect: () => value !== profile.id && onChange(profile.id),
    })),
  ]
  return (
    <Dropdown
      side="top"
      align="start"
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
                aria-label={`${t('profiles.menu')}: ${label}`}
                aria-disabled={disabledHint ? true : undefined}
                className="ui-as-tray-link kettu-tray-link--agent"
                data-tone={gone ? 'warn' : undefined}
                onClick={() => !disabledHint && toggle()}
              />
            }
          >
            <span className="kettu-tray-link__text">{label}</span>
          </TooltipTrigger>
          <TooltipContent>{disabledHint ?? t('profiles.menu')}</TooltipContent>
        </Tooltip>
      )}
    />
  )
}
