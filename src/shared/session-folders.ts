// Huli: folders the user makes to organize sessions, kept by the agent host so every window and
// paired device shows the same ones. A folder only groups sessions: a session's project stays as
// it is, and deleting a folder puts its sessions back among the ungrouped ones. Huli's own; see
// tools/huli/README.md.

export interface SessionFolder {
  id: string
  name: string
  /** Pinned folders come before the others. */
  pinned: boolean
  /** Shown closed, with only its header. */
  collapsed: boolean
  createdAt: number
  /** The top-level sessions in it, the latest moved in first. A session is in one folder at most. */
  sessionIds: string[]
}

/** The longest name a folder may have. */
export const FOLDER_NAME_CHARS = 100

/** The most folders a host keeps. */
export const MAX_FOLDERS = 500

/** The most sessions one `folders.move` or `folders.create` takes, as a selection can. */
export const FOLDER_MOVE_SESSIONS = 10_000

/** The folder each session is in, by session id. */
export function folderOfSession(folders: readonly SessionFolder[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const folder of folders) {
    for (const id of folder.sessionIds) if (!out.has(id)) out.set(id, folder.id)
  }
  return out
}

/** The folders in the order a list shows them: pinned ones first, each part in the user's order. */
export function shownFolders(folders: readonly SessionFolder[]): SessionFolder[] {
  return [...folders.filter((f) => f.pinned), ...folders.filter((f) => !f.pinned)]
}
