// Huli: where a session works, as its agent host's calls name it: the folder its downloads and
// PDFs go into, and whether it is a worktree, which may have browser data of its own.

import { isAbsolute } from 'node:path'

/** Huli: where a session works: its folder, and whether that is a worktree of its project. */
export interface SessionPlace {
  folder: string
  worktree: boolean
}

/**
 * Huli: the place a local agent host's call names, checked: an absolute folder of at most 4096
 * characters; null for none or anything else.
 */
export function placeOf(request: { folder?: unknown; worktree?: unknown }): SessionPlace | null {
  const { folder, worktree } = request
  if (typeof folder !== 'string' || folder.length === 0 || folder.length > 4_096) return null
  if (!isAbsolute(folder) || folder.includes('\0')) return null
  return { folder, worktree: worktree === true }
}
