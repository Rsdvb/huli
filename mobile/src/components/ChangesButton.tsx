// The way from a session to its folder's changes: how many files differ, for the folder chip of
// the status line, and the screen that lists them. A session without a project has none.

import { router } from 'expo-router'
import { sessionFolder, useChanges } from '../git'
import { useHost, useLink } from '../host'

export interface SessionChanges {
  /** The folder the session works in; null without a project. */
  folder: string | null
  /** Whether the folder is a repository, once known. */
  repo: boolean | null
  count: number
  open(): void
}

export function useSessionChanges(sessionId: string): SessionChanges {
  const host = useHost()
  const link = useLink()
  const summary = host.sessions.get(sessionId)
  const folder = summary && !summary.scratch ? sessionFolder(summary) : null
  const { status, files } = useChanges(link, folder)
  return {
    folder,
    repo: status ? status.repo !== null : null,
    count: files?.length ?? 0,
    open: () => router.push({ pathname: '/changes/[id]', params: { id: sessionId } }),
  }
}
