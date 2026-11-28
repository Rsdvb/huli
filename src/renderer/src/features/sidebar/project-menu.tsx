import {
  Archive01Icon,
  Delete02Icon,
  CommandLineIcon,
  ComputerTerminal01Icon,
  Download04Icon,
  FolderEditIcon,
  FolderMinusIcon,
  FolderOpenIcon,
  FoldersIcon,
  GitBranchIcon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  RadioButtonIcon,
} from '@hugeicons/core-free-icons'
import { Fragment, type ReactNode } from 'react'
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
import { openHostSettingsItem } from '@renderer/features/settings/host-sections'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { openWorktreeSettings } from '@renderer/features/worktrees/worktree-settings-model'
import { hostOfPath } from '@renderer/lib/host-paths'
import { fileManagerName, formatShortcut, isWeb } from '@renderer/lib/platform'
import { shortcutKeysOf } from '@renderer/lib/shortcut-keys'
import { agentsOn, isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useGitStore } from '@renderer/stores/git'
import { useHostsStore, useTerminalAllowed } from '@renderer/stores/hosts'
import { canArchiveProject } from '@renderer/stores/projects'
import { openIssues, openSettings } from '@renderer/stores/view'
import { useWebHostStore } from '@renderer/stores/web-host'
import { ProjectApprovalsMenu } from './project-approvals'
import { openProjectFolders } from './project-folders-model'
import { ProjectSandboxMenu } from './project-sandbox'
import {
  hostSupportsWorktreeSettings,
  isNoProjectMenuItemDisabled,
  isProjectMenuItemDisabled,
  noProjectMenuGroups,
  openProjectTerminal,
  projectMenuGroups,
  type NoProjectMenuItem,
  type ProjectMenuItem,
} from './project-menu-model'

/** The version reported by a remote host (or the web client's host); null on the local desktop host. */
function useProjectHostVersion(hostId: string | null): string | null {
  const other = useHostsStore((s) =>
    hostId === null ? null : (s.status?.hosts?.find((h) => h.id === hostId)?.version ?? null),
  )
  const web = useWebHostStore((s) => s.host?.version ?? null)
  if (hostId !== null) return other
  return isWeb ? web : null
}

/**
 * A project's actions. A context menu is a Base UI menu, so the same items serve the project
 * row's context menu and its More button. Both local and remote projects share the same menu
 * structure, filtered by per-action capabilities and permissions: local-only file manager actions
 * stay local, folder-dependent actions disable while `missing` or `away`, and host-level actions
 * disable while `away`. Huli: the order of its sessions follows the first group; its further
 * folders, approvals, sandbox, issues, agents in a terminal and the recycle bin are this
 * computer's projects' alone, as before.
 */
export function ProjectMenuItems({
  project,
  away,
  onEdit,
  onPin,
  onImport,
  onArchive,
  onRemove,
  orderItems,
}: {
  project: Project
  away: boolean
  onEdit: () => void
  onPin: (pinned: boolean) => Promise<void>
  onImport: () => void
  onArchive: () => void
  onRemove: () => void
  /** Huli: how its sessions go, after the pin (group-order-menu.tsx). */
  orderItems?: ReactNode
}) {
  const { t } = useTranslation('sidebar')
  const hostId = hostOfPath(project.path)
  const local = hostId === null
  const terminal = useTerminalAllowed(project.path)
  const gone = project.missing
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
  const hostVersion = useProjectHostVersion(hostId)
  const worktreeSettings = hostSupportsWorktreeSettings(hostVersion)
  const pinned = project.pinnedAt != null

  const groups = projectMenuGroups({
    revealable,
    terminal,
    git,
    worktreeSettings,
    canPin: project.pinnedAt !== undefined,
    canArchive: canArchiveProject(project),
    gone,
    away,
    startAgent: local,
    folders: local && project.folders !== undefined,
    approvals: local,
    sandbox: local,
    issues: local && github && issues,
    bin: local,
  })

  const renderItem = (item: ProjectMenuItem) => {
    const disabled = isProjectMenuItemDisabled(item, { gone, away })
    switch (item) {
      case 'newSession':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={() => newSession(project.path)}>
            <MenuGlyph icon={PencilEdit02Icon} />
            {t('project.menu.newSession')}
            <DropdownMenuShortcut>
              {formatShortcut(shortcutKeysOf('newSession'))}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        )
      case 'edit':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={onEdit}>
            <MenuGlyph icon={FolderEditIcon} />
            {t('project.menu.edit')}
          </DropdownMenuItem>
        )
      case 'pin':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={() => void onPin(!pinned)}>
            <MenuGlyph icon={pinned ? PinOffIcon : PinIcon} />
            {t(pinned ? 'project.menu.unpin' : 'project.menu.pin')}
          </DropdownMenuItem>
        )
      case 'importSessions':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={onImport}>
            <MenuGlyph icon={Download04Icon} />
            {t('project.importSessions')}
          </DropdownMenuItem>
        )
      case 'openInTerminal':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => void openProjectTerminal(project.path)}
          >
            <MenuGlyph icon={ComputerTerminal01Icon} />
            {t('project.menu.openInTerminal')}
          </DropdownMenuItem>
        )
      case 'startAgent':
        return <StartAgentMenu key={item} projectPath={project.path} disabled={disabled} />
      case 'showInFileManager':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => void window.kettu.shell.showItem(project.path)}
          >
            <MenuGlyph icon={FolderOpenIcon} />
            {t('project.menu.showIn', { name: fileManagerName() })}
          </DropdownMenuItem>
        )
      case 'folders':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => openProjectFolders(project.path)}
          >
            <MenuGlyph icon={FoldersIcon} />
            {t('project.menu.folders')}
          </DropdownMenuItem>
        )
      case 'approvals':
        return <ProjectApprovalsMenu key={item} project={project} disabled={disabled} />
      case 'sandbox':
        return <ProjectSandboxMenu key={item} project={project} disabled={disabled} />
      case 'issues':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={() => openIssues(project.path)}>
            <MenuGlyph icon={RadioButtonIcon} />
            {t('project.menu.issues')}
          </DropdownMenuItem>
        )
      case 'worktreeSettings':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => openWorktreeSettings(project)}
          >
            <MenuGlyph icon={GitBranchIcon} />
            {t('project.menu.worktreeSettings')}
          </DropdownMenuItem>
        )
      case 'showArchived':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => openHostSettingsItem(hostId, 'archived', null)}
          >
            <MenuGlyph icon={Archive01Icon} />
            {t('project.menu.showArchived')}
          </DropdownMenuItem>
        )
      // Huli: Settings shows this computer's recycle bin, so only its projects lead there.
      case 'showBin':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => openSettings('recycle-bin')}
          >
            <MenuGlyph icon={Delete02Icon} />
            {t('project.menu.showBin')}
          </DropdownMenuItem>
        )
      case 'archive':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={onArchive}>
            <MenuGlyph icon={Archive01Icon} />
            {t('project.menu.archive')}
          </DropdownMenuItem>
        )
      case 'remove':
        return (
          <DropdownMenuItem key={item} variant="destructive" disabled={disabled} onClick={onRemove}>
            <Glyph icon={FolderMinusIcon} size={15} />
            {t('project.menu.remove')}
          </DropdownMenuItem>
        )
    }
  }

  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={group[0]}>
          <DropdownMenuGroup>
            {index > 0 && <DropdownMenuSeparator />}
            {group.map(renderItem)}
          </DropdownMenuGroup>
          {index === 0 && orderItems}
        </Fragment>
      ))}
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
  hostId,
  pinned,
  away,
  onPin,
  orderItems,
}: {
  hostId: string | null
  pinned: boolean | undefined
  away: boolean
  onPin: (pinned: boolean) => Promise<void>
  /** Huli: how its sessions go, after the pin (group-order-menu.tsx). */
  orderItems?: ReactNode
}) {
  const { t } = useTranslation('sidebar')
  const groups = noProjectMenuGroups({
    local: hostId === null,
    canPin: pinned !== undefined,
    away,
    bin: hostId === null,
  })

  const renderItem = (item: NoProjectMenuItem) => {
    const disabled = isNoProjectMenuItemDisabled(item, { away })
    switch (item) {
      case 'newSession':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={() => newSession(null, true)}>
            <MenuGlyph icon={PencilEdit02Icon} />
            {t('project.menu.newSession')}
            <DropdownMenuShortcut>
              {formatShortcut(shortcutKeysOf('newSession'))}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        )
      case 'pin':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={() => void onPin(!pinned)}>
            <MenuGlyph icon={pinned ? PinOffIcon : PinIcon} />
            {t(pinned ? 'project.menu.unpinNoProject' : 'project.menu.pinNoProject')}
          </DropdownMenuItem>
        )
      case 'showArchived':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => openHostSettingsItem(hostId, 'archived', null)}
          >
            <MenuGlyph icon={Archive01Icon} />
            {t('project.menu.showArchived')}
          </DropdownMenuItem>
        )
      case 'showBin':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => openSettings('recycle-bin')}
          >
            <MenuGlyph icon={Delete02Icon} />
            {t('project.menu.showBin')}
          </DropdownMenuItem>
        )
    }
  }

  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={group[0]}>
          <DropdownMenuGroup>
            {index > 0 && <DropdownMenuSeparator />}
            {group.map(renderItem)}
          </DropdownMenuGroup>
          {index === 0 && orderItems}
        </Fragment>
      ))}
    </>
  )
}
