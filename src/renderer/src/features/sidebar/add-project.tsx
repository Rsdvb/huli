import { useState } from 'react'
import { CloudDownloadIcon, FolderAddIcon, FolderOpenIcon } from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { newSession, openProjectDialog } from '@renderer/app/actions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { openNewProject } from '@renderer/features/new-project/store'
import { HostFolderDialog } from '@renderer/features/session/new-session/host-folder-dialog'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'

/**
 * Add project at the end of a group's title, a menu of three. Open folder: this computer's asks
 * for a folder in the system's dialog, as the menu does; another host's browses that host's
 * folders. Huli: Clone from Git and New empty project make a project on the host. The project
 * opens in a new session either way.
 */
export function AddProjectButton({ hostId = null }: { hostId?: string | null }) {
  const { t } = useTranslation('sidebar')
  // Null until the host's folders are first asked for, so the dialog mounts only then.
  const [browsing, setBrowsing] = useState<boolean | null>(null)
  const label = t('newProject.menu.label')
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              tabIndex={-1}
              aria-label={label}
              title={label}
              className="ui-as-chat-row__tool kettu-add-project"
            />
          }
        >
          <Glyph icon={FolderAddIcon} size={15} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <Item
            icon={FolderOpenIcon}
            label={t('newProject.menu.open')}
            onClick={() => (hostId === null ? void openProjectDialog() : setBrowsing(true))}
          />
          <Item
            icon={CloudDownloadIcon}
            label={t('newProject.menu.clone')}
            onClick={() => openNewProject({ kind: 'clone', hostId })}
          />
          <Item
            icon={FolderAddIcon}
            label={t('newProject.menu.empty')}
            onClick={() => openNewProject({ kind: 'empty', hostId })}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {hostId !== null && browsing !== null && (
        <HostFolderDialog
          hostId={hostId}
          open={browsing}
          onOpenChange={setBrowsing}
          onOpened={(path) => {
            setBrowsing(false)
            newSession(path)
          }}
        />
      )}
    </>
  )
}

function Item({
  icon,
  label,
  onClick,
}: {
  icon: IconSvgElement
  label: string
  onClick: () => void
}) {
  return (
    <DropdownMenuItem onClick={onClick}>
      <MenuGlyph icon={icon} />
      {label}
    </DropdownMenuItem>
  )
}
