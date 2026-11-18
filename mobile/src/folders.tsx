// The user's folders of sessions, as the phone manages them: make one (with sessions in it, as a
// selection's 新建文件夹 does), rename, pin, collapse and delete one, and move sessions in or out.
// The computer keeps the folders (folders.* on its host) and tells every phone and window when
// they change, so nothing here is kept on the phone. A session's project stays as it is, and a
// deleted folder's sessions go back to 未分组.

import { useState, type ReactNode } from 'react'
import { Alert } from 'react-native'
import type { HostLink } from '@shared/remote/link'
import { FOLDER_NAME_CHARS, type SessionFolder } from '@shared/session-folders'
import { RenameDialog } from './components/RenameDialog'
import { useMaybeLink } from './host'
import { errorText } from './sessions'
import { haptic } from './ui/haptics'
import type { MenuNode } from './ui/menu'
import { showNotice } from './ui/NoticeBar'

export interface FolderActions {
  /** Asks for a name, then makes the folder with these sessions in it. */
  create(sessionIds?: string[], link?: HostLink | null): void
  rename(folder: SessionFolder, link?: HostLink | null): void
  /** Asks first; the sessions stay and go back to 未分组. */
  remove(folder: SessionFolder, link?: HostLink | null): void
  togglePin(folder: SessionFolder, link?: HostLink | null): void
  toggleCollapsed(folder: SessionFolder, link?: HostLink | null): void
  /** Into the folder, or out of every folder with null. */
  move(sessionIds: string[], folderId: string | null, link?: HostLink | null): Promise<boolean>
  /** One place up (-1) or down (1) among `folders`, the computer's in their order. */
  shift(
    folders: readonly SessionFolder[],
    folder: SessionFolder,
    by: -1 | 1,
    link?: HostLink | null,
  ): void
  /** The dialog naming a folder; put it anywhere in the screen. */
  element: ReactNode
}

/** The folders' ids with one moved a place up or down; null when it cannot move that way. */
export function shiftedOrder(
  folders: readonly SessionFolder[],
  folderId: string,
  by: -1 | 1,
): string[] | null {
  const ids = folders.map((f) => f.id)
  const at = ids.indexOf(folderId)
  const to = at + by
  if (at < 0 || to < 0 || to >= ids.length) return null
  ids.splice(at, 1)
  ids.splice(to, 0, folderId)
  return ids
}

type Naming =
  | { kind: 'create'; sessionIds: string[]; link: HostLink }
  | { kind: 'rename'; folder: SessionFolder; link: HostLink }

export function useFolderActions(): FolderActions {
  const active = useMaybeLink()
  const [naming, setNaming] = useState<Naming | null>(null)

  // No link given: the active computer's. A null link is another computer's that is down.
  const linkOf = (link: HostLink | null | undefined) => (link === undefined ? active : link)

  const fail = (title: string) => (error: unknown) => {
    haptic.warning()
    Alert.alert(title, errorText(error))
  }

  /** The link to use, or null after saying the computer cannot be reached. */
  const reach = (link: HostLink | null | undefined): HostLink | null => {
    const to = linkOf(link)
    if (!to) {
      haptic.warning()
      Alert.alert('现在连不上这台电脑', '连上之后再整理它的文件夹。')
    }
    return to
  }

  const move = async (
    sessionIds: string[],
    folderId: string | null,
    link?: HostLink | null,
  ): Promise<boolean> => {
    if (sessionIds.length === 0) return false
    const to = reach(link)
    if (!to) return false
    try {
      await to.request('folders.move', { sessionIds, folderId })
      haptic.success()
      return true
    } catch (error) {
      fail('没能移动')(error)
      return false
    }
  }

  return {
    create: (sessionIds = [], link) => {
      const to = reach(link)
      if (to) setNaming({ kind: 'create', sessionIds, link: to })
    },
    rename: (folder, link) => {
      const to = reach(link)
      if (to) setNaming({ kind: 'rename', folder, link: to })
    },
    remove: (folder, link) => {
      const to = reach(link)
      if (!to) return
      haptic.warning()
      Alert.alert(`删除文件夹「${folder.name}」？`, '其中的会话会回到未分组，不会被删除。', [
        { text: '取消', style: 'cancel' },
        {
          text: '删除文件夹',
          style: 'destructive',
          onPress: () =>
            void to
              .request('folders.delete', { folderId: folder.id })
              .then(() => haptic.success(), fail('没能删除文件夹')),
        },
      ])
    },
    togglePin: (folder, link) =>
      void reach(link)
        ?.request('folders.update', { folderId: folder.id, pinned: !folder.pinned })
        .then(() => haptic.success(), fail(folder.pinned ? '没能取消置顶' : '没能置顶')),
    toggleCollapsed: (folder, link) => {
      haptic.select()
      void reach(link)
        ?.request('folders.update', { folderId: folder.id, collapsed: !folder.collapsed })
        .catch(fail('没能收起'))
    },
    move,
    shift: (folders, folder, by, link) => {
      const order = shiftedOrder(folders, folder.id, by)
      if (!order) return
      haptic.select()
      void reach(link)
        ?.request('folders.reorder', { folderIds: order })
        .catch(fail('没能移动文件夹'))
    },
    element: (
      <RenameDialog
        visible={naming !== null}
        heading={naming?.kind === 'rename' ? '重命名文件夹' : '新建文件夹'}
        placeholder="文件夹名称"
        noReset
        maxLength={FOLDER_NAME_CHARS}
        title={naming?.kind === 'rename' ? naming.folder.name : ''}
        onClose={() => setNaming(null)}
        onSave={async (name) => {
          if (!naming) return
          if (!name) throw new Error('给文件夹起个名字。')
          if (naming.kind === 'rename') {
            await naming.link.request('folders.rename', { folderId: naming.folder.id, name })
            return
          }
          await naming.link.request('folders.create', {
            name,
            ...(naming.sessionIds.length > 0 ? { sessionIds: naming.sessionIds } : {}),
          })
          if (naming.sessionIds.length > 0) {
            showNotice({ text: `已移到「${name}」`, tone: 'success' })
          }
        }}
      />
    ),
  }
}

/**
 * The 移到文件夹 submenu for sessions: every folder (the one they are all in checked), 新建文件夹…,
 * and 移出文件夹 when any of them is in one.
 */
export function moveToFolderNodes(
  folders: readonly SessionFolder[],
  current: readonly (string | null)[],
  onMove: (folderId: string | null) => void,
  onNew: () => void,
): MenuNode[] {
  const only = current.length > 0 && current.every((id) => id === current[0]) ? current[0] : null
  const inAny = current.some((id) => id !== null)
  return [
    ...folders.map((folder) => ({
      key: `folder:${folder.id}`,
      label: folder.name,
      icon: folder.id === only ? ('checkmark' as const) : ('folder' as const),
      disabled: folder.id === only,
      onPress: () => onMove(folder.id),
    })),
    { kind: 'divider' as const, key: 'folder-new' },
    { key: 'new-folder', label: '新建文件夹…', icon: 'folder.badge.plus' as const, onPress: onNew },
    ...(inAny
      ? [
          {
            key: 'out-of-folder',
            label: '移出文件夹',
            icon: 'folder.badge.minus' as const,
            onPress: () => onMove(null),
          },
        ]
      : []),
  ]
}
