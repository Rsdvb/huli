import {
  Archive01Icon,
  CommandLineIcon,
  ComputerTerminal01Icon,
  Download04Icon,
  FolderMinusIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/agent-host'
import { newSession } from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { startAgentInProject } from '@renderer/features/agents/agent-terminal'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { openWorktreeSettings } from '@renderer/features/worktrees/worktree-settings-model'
import { hostOfPath } from '@renderer/lib/host-paths'
import { fileManagerName, formatShortcut, isWeb } from '@renderer/lib/platform'
import { agentsOn, isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useGitStore } from '@renderer/stores/git'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { openSettings } from '@renderer/stores/view'
import { openProjectTerminal } from './project-menu-model'

/**
 * A project's actions. A context menu is a Base UI menu, so the same items serve the project
 * row's context menu and its More button. A project whose folder is gone keeps only what needs
 * no folder, Remove included.
 */
export function ProjectMenuItems({
  project,
  pinDisabled,
  onPin,
  onImport,
  onRemove,
}: {
  project: Project
  pinDisabled: boolean
  onPin: (pinned: boolean) => Promise<void>
  onImport: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation('sidebar')
  const terminal = useTerminalAllowed(project.path)
  const gone = project.missing
  const local = hostOfPath(project.path) === null
  // Only this computer's folders open in its file manager.
  const revealable = !isWeb && local
  // Left out once the project is known not to be a Git repository.
  const git = useGitStore((s) => s.status[project.path]?.repo !== null)
  const pinned = project.pinnedAt != null
  const pinItem = project.pinnedAt !== undefined && (
    <DropdownMenuItem disabled={pinDisabled} onClick={() => void onPin(!pinned)}>
      <MenuGlyph icon={pinned ? PinOffIcon : PinIcon} />
      {t(pinned ? 'project.menu.unpin' : 'project.menu.pin')}
    </DropdownMenuItem>
  )
  if (!local) return <DropdownMenuGroup>{pinItem}</DropdownMenuGroup>

  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem disabled={gone} onClick={() => newSession(project.path)}>
          <MenuGlyph icon={PencilEdit02Icon} />
          {t('project.menu.newSession')}
          <DropdownMenuShortcut>{formatShortcut('Mod+N')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {pinItem}
      </DropdownMenuGroup>
      <DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={gone} onClick={onImport}>
          <MenuGlyph icon={Download04Icon} />
          {t('project.importSessions')}
        </DropdownMenuItem>
        {terminal && (
          <DropdownMenuItem disabled={gone} onClick={() => void openProjectTerminal(project.path)}>
            <MenuGlyph icon={ComputerTerminal01Icon} />
            {t('project.menu.openInTerminal')}
          </DropdownMenuItem>
        )}
        {terminal && <StartAgentMenu projectPath={project.path} disabled={!!gone} />}
        {revealable && (
          <DropdownMenuItem
            disabled={gone}
            onClick={() => void window.kettu.shell.showItem(project.path)}
          >
            <MenuGlyph icon={FolderOpenIcon} />
            {t('project.menu.showIn', { name: fileManagerName() })}
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
      {git && (
        <DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={gone} onClick={() => openWorktreeSettings(project)}>
            <MenuGlyph icon={GitBranchIcon} />
            {t('project.menu.worktreeSettings')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      )}
      <DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openSettings('archived')}>
          <MenuGlyph icon={Archive01Icon} />
          {t('project.menu.showArchived')}
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Glyph icon={FolderMinusIcon} size={15} />
          {t('project.menu.remove')}
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  )
}

/**
 * Huli: Start agent in terminal, a submenu of this computer's agents whose own CLI is installed and
 * has an interactive UI, each started in the project's folder; none shows without one.
 */
function StartAgentMenu({ projectPath, disabled }: { projectPath: string; disabled: boolean }) {
  const { t } = useTranslation('sidebar')
  const agents = useAgentsStore(
    useShallow((s) => {
      const { order, byId } = agentsOn(s, null)
      return usableAgents(order, byId).filter(
        (a) => isInstalled(a) && !a.hidden && !a.disabled && !!a.terminal,
      )
    }),
  )
  if (agents.length === 0) return null
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <MenuGlyph icon={CommandLineIcon} />
        {t('project.menu.startAgent')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-59">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('project.menu.startAgentLabel')}</DropdownMenuLabel>
          {agents.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              onClick={() => void startAgentInProject(agent, projectPath)}
            >
              <AgentMark agent={agent.id} size={15} hostId={null} />
              <span className="min-w-0 flex-1 truncate">{agent.harnessName}</span>
              {agent.name !== agent.harnessName && (
                <span className="max-w-24 shrink-0 truncate pl-4 text-hint text-tertiary">
                  {agent.name}
                </span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
