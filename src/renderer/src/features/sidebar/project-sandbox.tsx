// Huli: a project's own choice of the sandbox its new sessions start in, from its menu. Each
// session's agent must be able to run in it; one that cannot does not start, and says so.

import { Shield01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { Project } from '@shared/agent-host'
import {
  resolveSandbox,
  SANDBOX_NETWORKS,
  sandboxChoiceOf,
  type SandboxChoice,
} from '@shared/sandbox'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { useEntry } from '@renderer/lib/features'
import { toast } from '@renderer/components/ui/toast'
import { sandboxLabel } from '@renderer/features/session/composer/sandbox-text'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { useSettingsStore } from '@renderer/stores/settings'

const DEFAULT = 'default'

const CHOICES: SandboxChoice[] = [
  { tier: 'off', network: 'open' },
  ...(['native', 'container'] as const).flatMap((tier) =>
    SANDBOX_NETWORKS.map((network) => ({ tier, network })),
  ),
]

const valueOf = (choice: SandboxChoice): string => `${choice.tier}:${choice.network}`

async function setSandbox(path: string, sandbox: SandboxChoice | null): Promise<void> {
  try {
    await host('projects.setSandbox', { path, sandbox })
  } catch (error) {
    toast(errorMessage(error), undefined, { tone: 'warning' })
  }
}

export function ProjectSandboxMenu({ project, disabled }: { project: Project; disabled: boolean }) {
  const { t } = useTranslation('sidebar')
  const { t: ta } = useTranslation('agents')
  const fallback = useSettingsStore((s) => s.settings.sandbox)
  // Huli: with sandboxes turned off it shows only for a project that still has one of its own.
  const shown = useEntry('projectMenu.sandbox') || (project.sandbox ?? null) !== null
  // A host older than sandboxes lists none.
  if (project.sandbox === undefined || !shown) return null
  const label = (choice: SandboxChoice): string =>
    choice.tier === 'off' ? ta('sandbox.tier.off') : sandboxLabel(ta, choice)
  const choose = (value: string): void => {
    if (value === DEFAULT) return void setSandbox(project.path, null)
    const [tier, network] = value.split(':')
    const choice = sandboxChoiceOf({ tier, network })
    if (choice) void setSandbox(project.path, choice)
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <MenuGlyph icon={Shield01Icon} />
        {t('project.menu.sandbox')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72">
        <DropdownMenuRadioGroup
          value={project.sandbox ? valueOf(project.sandbox) : DEFAULT}
          onValueChange={choose}
        >
          <DropdownMenuRadioItem value={DEFAULT} closeOnClick>
            {t('project.sandbox.default', {
              choice: label(resolveSandbox(undefined, null, fallback)),
            })}
          </DropdownMenuRadioItem>
          {CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={valueOf(choice)} value={valueOf(choice)} closeOnClick>
              {label(choice)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
