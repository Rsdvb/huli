// What the rows of one session's conversation share: which session, the folder its paths are
// shown under, and whether a reply can be forked from.

import { createContext, useContext } from 'react'

export interface SessionRowsContext {
  sessionId: string
  /** The folder paths are shown relative to; null for a session without a project. */
  root: string | null
  /** Forks the session up to a reply, or whole; null when its agent cannot fork. */
  fork: ((entryId: string | null) => void) | null
  /** Whether a fork can stop at a reply rather than take the whole session. */
  forkAtMessage: boolean
  /** Shows text the user can select, as the message menu offers. */
  selectText(text: string): void
}

export const SessionRows = createContext<SessionRowsContext>({
  sessionId: '',
  root: null,
  fork: null,
  forkAtMessage: false,
  selectText: () => {},
})

export function useSessionRows(): SessionRowsContext {
  return useContext(SessionRows)
}
