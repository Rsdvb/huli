// Huli: Move to folder, in a session's menu and in the menu of the picked sessions: the host's
// folders, New folder… and, for sessions in one, Remove from folder. Huli's own; see
// tools/huli/README.md.

import {
  Folder01Icon,
  FolderAddIcon,
  FolderPinIcon,
  FolderRemoveIcon,
  FolderTransferIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { shownFolders } from '@shared/session-folders'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { clearSelection } from '@renderer/stores/session-selection'
import {
  askFolderDialog,
  folderable,
  folderIdOf,
  hostKey,
  hostOfAll,
  moveToFolder,
  useSessionFoldersStore,
} from './store'

/**
 * Move to folder › for the sessions of `ids`; nothing unless every one is a top-level session on
 * one host that keeps folders.
 */
export function MoveToFolderMenu({ ids }: { ids: readonly string[] }) {
  const { t } = useTranslation('sessionFolders')
  const hostId = hostOfAll(ids)
  const folders = useSessionFoldersStore((s) =>
    hostId === undefined ? undefined : s.byHost[hostKey(hostId)],
  )
  if (hostId === undefined || !folders) return null
  const sessions = folderable(ids, hostId)
  if (sessions.length === 0 || sessions.length !== ids.length) return null
  const current = new Set(sessions.map((id) => folderIdOf(id, hostId)))
  // The folder all of them are in already, if they share one.
  const shared = current.size === 1 ? current.values().next().value : undefined
  const done = () => {
    if (ids.length > 1) clearSelection()
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MenuGlyph icon={FolderTransferIcon} />
        {t('actions.moveTo')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
        {shownFolders(folders).map((folder) => (
          <DropdownMenuItem
            key={folder.id}
            disabled={shared === folder.id}
            onClick={() => {
              done()
              void moveToFolder(hostId, sessions, folder.id)
            }}
          >
            <MenuGlyph icon={folder.pinned ? FolderPinIcon : Folder01Icon} />
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            {shared === folder.id && (
              <Glyph icon={Tick02Icon} size={12} className="ml-auto size-3" />
            )}
          </DropdownMenuItem>
        ))}
        {folders.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem
          onClick={() => {
            done()
            askFolderDialog({ kind: 'create', hostId, sessionIds: sessions })
          }}
        >
          <MenuGlyph icon={FolderAddIcon} />
          {t('actions.newMore')}
        </DropdownMenuItem>
        {[...current].some((id) => id !== null) && (
          <DropdownMenuItem
            onClick={() => {
              done()
              void moveToFolder(hostId, sessions, null)
            }}
          >
            <MenuGlyph icon={FolderRemoveIcon} />
            {t('actions.removeFrom')}
          </DropdownMenuItem>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
