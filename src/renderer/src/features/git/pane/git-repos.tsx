// Huli: the Git pane of a project with further folders shows one repository at a time: the
// project's own folder first, or the one picked at the pane's top, or the further folder whose
// branch link on the composer's tray opened it (`openGitPane` with that folder's path).

import { GitBranchIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ProjectFolder } from '@shared/agent-host'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { basename } from '@renderer/lib/format'
import { useFurtherFolders } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { chooseGitRoot, panelSession, useViewStore } from '@renderer/stores/view'
import GitPane from './git-pane'

export default function GitReposPane({
  panel,
  projectPath,
}: {
  panel: string
  projectPath: string
}) {
  const owner = useSessionsStore((s) => {
    const id = panelSession(panel)
    return id === null ? null : (s.byId[id]?.projectPath ?? null)
  })
  const folders = useFurtherFolders(owner ?? projectPath)
  const chosen = useViewStore((s) => s.gitRoot[panel] ?? null)
  const live = folders.filter((folder) => !folder.missing)
  const root =
    chosen !== null && live.some((folder) => folder.path === chosen) ? chosen : projectPath
  return (
    <GitPane
      key={root}
      panel={panel}
      projectPath={root}
      repos={
        live.length > 0 ? (
          <RepoPicker panel={panel} home={projectPath} folders={live} root={root} />
        ) : null
      }
    />
  )
}

/** Which of the project's repositories the pane shows, its own folder and each further one. */
function RepoPicker({
  panel,
  home,
  folders,
  root,
}: {
  panel: string
  home: string
  folders: ProjectFolder[]
  root: string
}) {
  const { t } = useTranslation('git')
  const items = [
    { value: home, label: basename(home) },
    ...folders.map((folder) => ({ value: folder.path, label: folder.name })),
  ]
  return (
    <div className="flex h-9 shrink-0 items-center px-1.5">
      <Select
        value={root}
        items={items}
        onValueChange={(next) =>
          next && chooseGitRoot(panel, next === home ? null : (next as string))
        }
      >
        <SelectTrigger
          aria-label={t('pane.repository')}
          variant="quiet"
          size="sm"
          className="max-w-full min-w-0 gap-1.5 rounded-lg px-2 text-control font-medium text-primary [&>svg:last-child]:size-3.25 [&>svg:last-child]:text-tertiary"
        >
          <PaneIcon icon={GitBranchIcon} size={14} />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value} title={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}
