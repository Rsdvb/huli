// The way from a session to its folder's changes: how many files differ and the branch it is on,
// for the status line, and the screen that lists them. A session without a project has none.

import { router } from 'expo-router'
import { sessionFolder, useChanges } from '../git'
import { useHost, useLink } from '../host'

export interface SessionChanges {
  /** The folder the session works in; null without a project. */
  folder: string | null
  /** Whether the folder is a repository, once known. */
  repo: boolean | null
  count: number
  /** The branch for the status line: undefined without a folder, `loading`, null outside git. */
  branch: string | null | 'loading' | undefined
  /** The session works in a worktree of its own. */
  worktree: boolean
  open(): void
}

export function useSessionChanges(sessionId: string): SessionChanges {
  const host = useHost()
  const link = useLink()
  const summary = host.sessions.get(sessionId)
  const folder = summary && !summary.scratch ? sessionFolder(summary) : null
  const { status, files, error } = useChanges(link, folder)
  const branch =
    folder === null
      ? undefined
      : status
        ? status.repo
          ? (status.head.branch ?? status.head.oid?.slice(0, 7) ?? null)
          : null
        : error
          ? null
          : 'loading'
  return {
    folder,
    repo: status ? status.repo !== null : null,
    count: files?.length ?? 0,
    branch,
    worktree: !!summary?.worktree,
    open: () => router.push({ pathname: '/changes/[id]', params: { id: sessionId } }),
  }
}
