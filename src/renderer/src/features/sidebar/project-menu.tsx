import {
  Archive01Icon,
  Delete02Icon,
  CommandLineIcon,
  ComputerTerminal01Icon,
  Download04Icon,
  FolderMinusIcon,
  FolderOpenIcon,
  FoldersIcon,
  GitBranchIcon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  RadioButtonIcon,
} from '@hugeicons/core-free-icons'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/agent-host'
import { useEntry } from '@renderer/lib/features'
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
import { shortcutKeysOf } from '@renderer/lib/shortcut-keys'
import { agentsOn, isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useGitStore } from '@renderer/stores/git'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { openIssues, openSettings } from '@renderer/stores/view'
import { ProjectApprovalsMenu } from './project-approvals'
import { openProjectFolders } from './project-folders-model'
import { ProjectSandboxMenu } from './project-sandbox'
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
  orderItems,
}: {
  project: Project
  pinDisabled: boolean
  onPin: (pinned: boolean) => Promise<void>
  onImport: () => void
  onRemove: () => void
  /** Huli: how its sessions go, after the pin (group-order-menu.tsx). */
  orderItems?: ReactNode
}) {
  const { t } = useTranslation('sidebar')
  const terminal = useTerminalAllowed(project.path)
  const gone = project.missing
  const local = hostOfPath(project.path) === null
  // Only this computer's folders open in its file manager.
  const revealable = !isWeb && local
  // Left out once the project is known not to be a Git repository.
  const git = useGitStore((s) => s.status[project.path]?.repo !== null)
  // Huli: left out once its remote is known not to be on GitHub.
  const github = useGitStore((s) => {
    const status = s.status[project.path]
    return status === undefined || !!status.remote?.github
  })
  const issues = useEntry('projectMenu.issues')
  const pinned = project.pinnedAt != null
  const pinItem = project.pinnedAt !== undefined && (
    <DropdownMenuItem disabled={pinDisabled} onClick={() => void onPin(!pinned)}>
      <MenuGlyph icon={pinned ? PinOffIcon : PinIcon} />
      {t(pinned ? 'project.menu.unpin' : 'project.menu.pin')}
    </DropdownMenuItem>
  )
  if (!local) {
    return (
      <>
        <DropdownMenuGroup>{pinItem}</DropdownMenuGroup>
        {orderItems}
      </>
    )
  }

  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem disabled={gone} onClick={() => newSession(project.path)}>
          <MenuGlyph icon={PencilEdit02Icon} />
          {t('project.menu.newSession')}
          <DropdownMenuShortcut>
            {formatShortcut(shortcutKeysOf('newSession'))}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        {pinItem}
      </DropdownMenuGroup>
      {orderItems}
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
      <DropdownMenuGroup>
        <DropdownMenuSeparator />
        {project.folders !== undefined && (
          <DropdownMenuItem disabled={gone} onClick={() => openProjectFolders(project.path)}>
            <MenuGlyph icon={FoldersIcon} />
            {t('project.menu.folders')}
          </DropdownMenuItem>
        )}
        <ProjectApprovalsMenu project={project} disabled={!!gone} />
        {local && <ProjectSandboxMenu project={project} disabled={!!gone} />}
        {git && github && issues && (
          <DropdownMenuItem disabled={gone} onClick={() => openIssues(project.path)}>
            <MenuGlyph icon={RadioButtonIcon} />
            {t('project.menu.issues')}
          </DropdownMenuItem>
        )}
        {git && (
          <DropdownMenuItem disabled={gone} onClick={() => openWorktreeSettings(project)}>
            <MenuGlyph icon={GitBranchIcon} />
            {t('project.menu.worktreeSettings')}
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
      <DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openSettings('archived')}>
          <MenuGlyph icon={Archive01Icon} />
          {t('project.menu.showArchived')}
        </DropdownMenuItem>
        {/* Huli: Settings shows this computer's recycle bin, so only its projects lead there. */}
        {local && (
          <DropdownMenuItem onClick={() => openSettings('recycle-bin')}>
            <MenuGlyph icon={Delete02Icon} />
            {t('project.menu.showBin')}
          </DropdownMenuItem>
        )}
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

/**
 * No project's actions: only what fits a group of scratch folders, which is no folder itself.
 * `pinned` is undefined on a host that cannot pin it.
 */
export function NoProjectMenuItems({
  local,
  pinned,
  pinDisabled,
  onPin,
  orderItems,
}: {
  local: boolean
  pinned: boolean | undefined
  pinDisabled: boolean
  onPin: (pinned: boolean) => Promise<void>
  /** Huli: how its sessions go, after the pin (group-order-menu.tsx). */
  orderItems?: ReactNode
}) {
  const { t } = useTranslation('sidebar')
  const pinItem = pinned !== undefined && (
    <DropdownMenuItem disabled={pinDisabled} onClick={() => void onPin(!pinned)}>
      <MenuGlyph icon={pinned ? PinOffIcon : PinIcon} />
      {t(pinned ? 'project.menu.unpinNoProject' : 'project.menu.pinNoProject')}
    </DropdownMenuItem>
  )
  if (!local) {
    return (
      <>
        <DropdownMenuGroup>{pinItem}</DropdownMenuGroup>
        {orderItems}
      </>
    )
  }

  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => newSession(null, true)}>
          <MenuGlyph icon={PencilEdit02Icon} />
          {t('project.menu.newSession')}
          <DropdownMenuShortcut>
            {formatShortcut(shortcutKeysOf('newSession'))}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        {pinItem}
      </DropdownMenuGroup>
      {orderItems}
      <DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openSettings('archived')}>
          <MenuGlyph icon={Archive01Icon} />
          {t('project.menu.showArchived')}
        </DropdownMenuItem>
        {local && (
          <DropdownMenuItem onClick={() => openSettings('recycle-bin')}>
            <MenuGlyph icon={Delete02Icon} />
            {t('project.menu.showBin')}
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
    </>
  )
}
