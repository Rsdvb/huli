// Huli: dragging sessions into the sidebar's folders and out of them. A sidebar row or a pane's
// title carries the session, as for the split; a row of the picked ones carries all of them. A
// folder's header takes them in, a project's header or Ungrouped takes them out, and the Folders
// label puts them in a new folder. Huli's own; see tools/huli/README.md.

import { useMemo } from 'react'
import { useDroppable } from '@dnd-kit/react'
import {
  useSessionDragStore,
  type SessionDragData,
} from '@renderer/features/split/session-drag-model'
import {
  clearSelection,
  selectionFor,
  useSessionSelection,
} from '@renderer/stores/session-selection'
import { anyFoldered, askFolderDialog, folderable, folderIdOf, moveToFolder } from './store'

/** What a drop target does with the sessions: into a folder, out of theirs, or into a new one. */
export type FolderDrop =
  | { kind: 'folder'; hostId: string | null; folderId: string }
  | { kind: 'ungroup'; hostId: string | null }
  | { kind: 'new'; hostId: string | null }

interface FolderDropData {
  folderDrop: FolderDrop
}

/** The sessions a drag of this one moves: the picked ones when it is one of them. */
function draggedIds(sessionId: string): string[] {
  const picked = selectionFor(sessionId, useSessionSelection.getState().ids)
  return picked ? [...picked] : [sessionId]
}

/** The sessions the drop would move, none when it would change nothing. */
function moving(sessionId: string, drop: FolderDrop): string[] {
  const ids = folderable(draggedIds(sessionId), drop.hostId)
  if (drop.kind === 'new') return ids
  if (drop.kind === 'ungroup') return ids.filter((id) => folderIdOf(id, drop.hostId) !== null)
  return ids.some((id) => folderIdOf(id, drop.hostId) !== drop.folderId) ? ids : []
}

/**
 * A drop target for sessions, which `attach` sets on its element; `over` while a drag it would
 * take is over it. It takes part only while such a drag runs, so it never stands in the split's
 * way.
 */
export function useFolderDrop(
  id: string,
  drop: FolderDrop,
): { attach: (el: Element | null) => void; over: boolean } {
  const { kind, hostId } = drop
  const folderId = drop.kind === 'folder' ? drop.folderId : null
  const data = useMemo<FolderDropData>(
    () => ({
      folderDrop:
        kind === 'folder' && folderId !== null
          ? { kind, hostId, folderId }
          : kind === 'new'
            ? { kind, hostId }
            : { kind: 'ungroup', hostId },
    }),
    [kind, hostId, folderId],
  )
  const takes = useSessionDragStore((s) =>
    s.dragging ? moving(s.dragging.sessionId, data.folderDrop).length > 0 : false,
  )
  const target = useDroppable({ id: `huli-folder-drop:${id}`, data, disabled: !takes })
  return { attach: target.ref, over: takes && target.isDropTarget }
}

/** A project's header as a target that takes sessions out of their folders, for its group's key. */
export function useUngroupDrop(
  key: string,
  hostId: string | null,
): [attach: (el: Element | null) => void, over: boolean] {
  const { attach, over } = useFolderDrop(`ungroup:${key}`, { kind: 'ungroup', hostId })
  return [attach, over]
}

/** Whether a drag of a session that is in a folder runs, for Ungrouped to show. */
export function useDraggingFoldered(hostId: string | null): boolean {
  return useSessionDragStore((s) =>
    s.dragging ? moving(s.dragging.sessionId, { kind: 'ungroup', hostId }).length > 0 : false,
  )
}

/**
 * Ends a drag that let go over a folder's target; false when the target is none of them, which
 * leaves the drop to the split.
 */
export function dropIntoFolder(source: unknown, target: unknown): boolean {
  const drop = (target as Partial<FolderDropData> | null | undefined)?.folderDrop
  if (!drop) return false
  const sessionId = (source as Partial<SessionDragData> | null | undefined)?.sessionId
  const ids = sessionId ? moving(sessionId, drop) : []
  if (ids.length === 0) return true
  clearSelection()
  if (drop.kind === 'new') askFolderDialog({ kind: 'create', hostId: drop.hostId, sessionIds: ids })
  else void moveToFolder(drop.hostId, ids, drop.kind === 'folder' ? drop.folderId : null)
  return true
}

/**
 * The sidebar's rows in the order it shows them, for a Shift-click range: with sessions in
 * folders, the list's own order, which `visibleOrder` does not know; rows it does not show now
 * follow. Without, `order` as it is.
 */
export function withFolderOrder(order: readonly string[]): string[] {
  if (!anyFoldered()) return [...order]
  const shown = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.kettu-side-list :is([data-session-id], [data-task-id])',
    ),
    (row) => row.dataset.sessionId ?? row.dataset.taskId ?? '',
  ).filter((id) => id !== '')
  if (shown.length === 0) return [...order]
  const seen = new Set(shown)
  return [...seen, ...order.filter((id) => !seen.has(id))]
}
