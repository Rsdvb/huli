// What the rows of one session's conversation share: which session, the folder its paths are
// shown under, and whether a reply can be forked from or its turn undone.

import { createContext, useContext } from 'react'
import type { ConfigOption } from '@shared/thread'

export interface SessionRowsContext {
  sessionId: string
  /** The folder paths are shown relative to; null for a session without a project. */
  root: string | null
  /** Forks the session up to a reply, or whole; null when its agent cannot fork. */
  fork: ((entryId: string | null) => void) | null
  /** Whether a fork can stop at a reply rather than take the whole session. */
  forkAtMessage: boolean
  /**
   * Undo of the latest turn, under the footer of its end `end`, where the agent can take a turn out
   * of its history; `blocked` while the session is not between turns or an undo runs.
   */
  undo?: { end: string; blocked: boolean; run: () => void } | null
  /** The notice of a failed latest turn that Retry sends again, while the session is free. */
  retryNotice?: string | null
  /** The notice of a latest turn the agent's exit cut short, which Resume continues. */
  cutNotice?: string | null
  /**
   * The agent to go on with after a turn the plan limit stopped, with its share used, and how to
   * hand the session to it; null while none has room.
   */
  carryOn?: { name: string; usedPercent: number; go: () => Promise<void> } | null
  /** The session's options, which a task started from its suggestion carries on with. */
  config?: readonly ConfigOption[]
  /** The agent's command names, which a sent prompt's leading `/name` is one of. */
  commands?: readonly string[]
  /** Puts a command into the composer, as tapping a sent prompt's command does. */
  command?: (name: string) => void
}

export const SessionRows = createContext<SessionRowsContext>({
  sessionId: '',
  root: null,
  fork: null,
  forkAtMessage: false,
  retryNotice: null,
  cutNotice: null,
})

export function useSessionRows(): SessionRowsContext {
  return useContext(SessionRows)
}
