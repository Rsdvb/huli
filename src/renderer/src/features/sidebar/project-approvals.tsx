// Huli: a project's own choice of the requests the host allows by itself, from its menu, and the
// confirmation its edits level asks, which shows after the menu closed.

import { SecurityCheckIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import type { Project } from '@shared/agent-host'
import { AUTO_APPROVE_LEVELS, isAutoApprove, type AutoApprove } from '@shared/risk'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { toast } from '@renderer/components/ui/toast'
import { EditsConfirm } from '@renderer/features/settings/auto-approve-rows'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { useSettingsStore } from '@renderer/stores/settings'

const DEFAULT = 'default'

/** The project whose edits level waits for the user's confirmation. */
const useConfirming = create<{ path: string | null }>(() => ({ path: null }))

async function setLevel(path: string, autoApprove: AutoApprove | null): Promise<void> {
  try {
    await host('projects.setAutoApprove', { path, autoApprove })
  } catch (error) {
    toast(errorMessage(error), undefined, { tone: 'warning' })
  }
}

export function ProjectApprovalsMenu({
  project,
  disabled,
}: {
  project: Project
  disabled: boolean
}) {
  const { t } = useTranslation('sidebar')
  const fallback = useSettingsStore((s) => s.settings.permissions?.autoApprove ?? 'off')
  // A host older than the setting lists no level.
  if (project.autoApprove === undefined) return null
  const levelName = (level: AutoApprove): string => t(`project.autoApprove.level.${level}`)
  const choose = (value: string): void => {
    if (value === 'edits') useConfirming.setState({ path: project.path })
    else if (value === DEFAULT) void setLevel(project.path, null)
    else if (isAutoApprove(value)) void setLevel(project.path, value)
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <MenuGlyph icon={SecurityCheckIcon} />
        {t('project.menu.autoApprove')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <DropdownMenuRadioGroup value={project.autoApprove ?? DEFAULT} onValueChange={choose}>
          <DropdownMenuRadioItem value={DEFAULT}>
            {t('project.autoApprove.default', { level: levelName(fallback) })}
          </DropdownMenuRadioItem>
          {AUTO_APPROVE_LEVELS.map((level) => (
            <DropdownMenuRadioItem key={level} value={level}>
              {levelName(level)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Mounted once beside the app's other dialogs. */
export function ProjectApprovalsConfirm() {
  const path = useConfirming((s) => s.path)
  return (
    <EditsConfirm
      open={path !== null}
      onAnswer={(confirmed) => {
        useConfirming.setState({ path: null })
        if (confirmed && path !== null) void setLevel(path, 'edits')
      }}
    />
  )
}
