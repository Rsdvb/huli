// Huli: the folders the user keeps sessions in, as each host keeps them, and where the sidebar
// shows them. Huli's own; see tools/huli/README.md.

import { useMemo } from 'react'
import { create } from 'zustand'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionFolder } from '@shared/session-folders'
import { toast } from '@renderer/components/ui/toast'
import { errorCode, errorMessage, hostAt } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { readJson, writeJson } from '@renderer/lib/storage'
import { hostOfSession, listedOrigin, useSessionsStore } from '@renderer/stores/sessions'

/** Where the folders show: above the projects or below them. */
export type FolderPlace = 'above' | 'below'

/** The dialog a folder action opened, for the host the folder is on. */
export type FolderDialog =
  | { kind: 'create'; hostId: string | null; sessionIds: string[] }
  | { kind: 'rename'; hostId: string | null; folder: SessionFolder }
  | { kind: 'delete'; hostId: string | null; folder: SessionFolder }

interface SessionFoldersState {
  /**
   * Each host's folders by `hostKey`, in the user's order. A host not read yet, or one without
   * folders (an older host, or Kettu's), has none here, and the sidebar shows no folders for it.
   */
  byHost: Record<string, SessionFolder[]>
  place: FolderPlace
  dialog: FolderDialog | null
}

const PLACE_KEY = 'huli.sessionFolders.place'

export const useSessionFoldersStore = create<SessionFoldersState>()(() => ({
  byHost: {},
  place: readJson<unknown>(PLACE_KEY, 'above') === 'below' ? 'below' : 'above',
  dialog: null,
}))

/** A host's key in `byHost`; this computer's (null) is the empty string, which no id takes. */
export function hostKey(hostId: string | null): string {
  return hostId ?? ''
}

const NONE: readonly SessionFolder[] = []

/** A host's folders in the user's order, or undefined while the host has none to show. */
export function useHostFolders(hostId: string | null): SessionFolder[] | undefined {
  return useSessionFoldersStore((s) => s.byHost[hostKey(hostId)])
}

/** The ids of the sessions in a folder on the host, which their projects' groups leave out. */
export function useFolderedIds(hostId: string | null): ReadonlySet<string> {
  const folders = useSessionFoldersStore((s) => s.byHost[hostKey(hostId)] ?? NONE)
  return useMemo(() => new Set(folders.flatMap((folder) => folder.sessionIds)), [folders])
}

/**
 * `summaries` without the sessions in a folder on the host and their sub-sessions, which the
 * folder lists, for a project's group.
 */
export function useUnfoldered(
  summaries: SessionSummary[],
  hostId: string | null,
): SessionSummary[] {
  const foldered = useFolderedIds(hostId)
  return useMemo(() => {
    if (foldered.size === 0) return summaries
    const byId = new Map(summaries.map((s) => [s.id, s]))
    const inFolder = (summary: SessionSummary): boolean => {
      const seen = new Set<string>()
      for (let at: SessionSummary | undefined = summary; at && !seen.has(at.id);) {
        if (foldered.has(at.id)) return true
        seen.add(at.id)
        at = at.parentId ? byId.get(at.parentId) : undefined
      }
      return false
    }
    return summaries.filter((summary) => !inFolder(summary))
  }, [summaries, foldered])
}

/** The folder a session is in on its host, if any. */
export function folderIdOf(sessionId: string, hostId: string | null): string | null {
  const folders = useSessionFoldersStore.getState().byHost[hostKey(hostId)] ?? NONE
  return folders.find((folder) => folder.sessionIds.includes(sessionId))?.id ?? null
}

/** Whether any host has a session in a folder. */
export function anyFoldered(): boolean {
  return Object.values(useSessionFoldersStore.getState().byHost).some((folders) =>
    folders.some((folder) => folder.sessionIds.length > 0),
  )
}

/**
 * The sessions of `ids` a folder can hold on the host: listed top-level sessions on it, not
 * sub-agents or sub-sessions, which go where their parent goes.
 */
export function folderable(ids: readonly string[], hostId: string | null): string[] {
  const { byId } = useSessionsStore.getState()
  return ids.filter((id) => {
    const summary: SessionSummary | undefined = byId[id]
    return (
      !!summary &&
      summary.parentId === null &&
      summary.origin !== 'subagent' &&
      listedOrigin(summary) &&
      hostOfSession(summary) === hostId
    )
  })
}

/** The one host every session of `ids` is on, or undefined when they are on several or none. */
export function hostOfAll(ids: readonly string[]): string | null | undefined {
  const { byId } = useSessionsStore.getState()
  const hosts = new Set(ids.flatMap((id) => (byId[id] ? [hostOfSession(byId[id])] : [])))
  return hosts.size === 1 ? hosts.values().next().value : undefined
}

function setFolders(hostId: string | null, folders: SessionFolder[] | null): void {
  useSessionFoldersStore.setState((s) => {
    const byHost = { ...s.byHost }
    if (folders) byHost[hostKey(hostId)] = folders
    else delete byHost[hostKey(hostId)]
    return { byHost }
  })
}

/** Reads a host's folders; a host without the methods has none. */
export async function loadFolders(hostId: string | null = null): Promise<void> {
  try {
    setFolders(hostId, await hostAt(hostId, 'folders.list', undefined))
  } catch (error) {
    if (errorCode(error) === 'unknown_method') setFolders(hostId, null)
    else console.warn(`Could not read the folders: ${errorMessage(error)}`)
  }
}

/** A host's `folders.changed`. */
export function receiveFolders(folders: SessionFolder[], hostId: string | null): void {
  setFolders(hostId, folders)
}

/** A connection to another host opened: its folders are read again. */
export function foldersHostOpened(hostId: string): void {
  void loadFolders(hostId)
}

/** `folders` with `ids` taken out of every folder and, unless null, put first in `folderId`. */
function placed(
  folders: readonly SessionFolder[],
  ids: readonly string[],
  folderId: string | null,
): SessionFolder[] {
  const moving = new Set(ids)
  return folders.map((folder) => {
    const kept = folder.sessionIds.filter((id) => !moving.has(id))
    return {
      ...folder,
      sessionIds: folder.id === folderId ? [...moving, ...kept] : kept,
    }
  })
}

/**
 * Shows a change at once and asks the host for it; a failure says why and reads the host's
 * folders again, which its `folders.changed` replaces either way.
 */
async function change(
  hostId: string | null,
  local: ((folders: SessionFolder[]) => SessionFolder[]) | null,
  run: () => Promise<unknown>,
): Promise<boolean> {
  const before = useSessionFoldersStore.getState().byHost[hostKey(hostId)]
  if (local && before) setFolders(hostId, local(before))
  try {
    await run()
    return true
  } catch (error) {
    toast(i18n.t('sessionFolders:failed', { error: errorMessage(error) }))
    void loadFolders(hostId)
    return false
  }
}

/** A new folder, last in the order, holding `sessionIds`; throws for the dialog to show. */
export async function createFolder(
  hostId: string | null,
  name: string,
  sessionIds: readonly string[] = [],
): Promise<SessionFolder> {
  const ids = folderable(sessionIds, hostId)
  const folder = await hostAt(
    hostId,
    'folders.create',
    ids.length > 0 ? { name, sessionIds: ids } : { name },
  )
  const before = useSessionFoldersStore.getState().byHost[hostKey(hostId)]
  if (before && !before.some((f) => f.id === folder.id)) {
    setFolders(hostId, [...placed(before, folder.sessionIds, null), folder])
  }
  return folder
}

/** Renames a folder; throws for the dialog to show. */
export async function renameFolder(
  hostId: string | null,
  folderId: string,
  name: string,
): Promise<void> {
  await hostAt(hostId, 'folders.rename', { folderId, name })
  const before = useSessionFoldersStore.getState().byHost[hostKey(hostId)]
  if (before)
    setFolders(
      hostId,
      before.map((f) => (f.id === folderId ? { ...f, name } : f)),
    )
}

export function updateFolder(
  hostId: string | null,
  folderId: string,
  update: { pinned?: boolean; collapsed?: boolean },
): Promise<boolean> {
  return change(
    hostId,
    (folders) => folders.map((f) => (f.id === folderId ? { ...f, ...update } : f)),
    () => hostAt(hostId, 'folders.update', { folderId, ...update }),
  )
}

/** Removes a folder; its sessions go back among the ungrouped ones. */
export function deleteFolder(hostId: string | null, folderId: string): Promise<boolean> {
  return change(
    hostId,
    (folders) => folders.filter((f) => f.id !== folderId),
    () => hostAt(hostId, 'folders.delete', { folderId }),
  )
}

/** Moves sessions into a folder, or out of every folder with null. */
export function moveToFolder(
  hostId: string | null,
  sessionIds: readonly string[],
  folderId: string | null,
): Promise<boolean> {
  const ids = folderable(sessionIds, hostId)
  if (ids.length === 0) return Promise.resolve(false)
  return change(
    hostId,
    (folders) => placed(folders, ids, folderId),
    () => hostAt(hostId, 'folders.move', { sessionIds: ids, folderId }),
  )
}

export function setFolderPlace(place: FolderPlace): void {
  useSessionFoldersStore.setState({ place })
  writeJson(PLACE_KEY, place)
}

export function askFolderDialog(dialog: FolderDialog | null): void {
  useSessionFoldersStore.setState({ dialog })
}
