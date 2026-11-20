// What the rows of one session's conversation share: which session, the folder its paths are
// shown under, and whether a reply can be forked from or its turn undone.
//
// It is a store rather than a context's value: every row reads the session's id from it, and a
// context whose value changed, as it did with each undo, notice or command list, drew every row
// on screen again. A row selects the fields it uses and redraws only when they change.

import {
  createContext,
  createElement,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react'
import type { ConfigOption } from '@shared/thread'
import { createStore, sameFields, useSelector, type Store } from '../../select'

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
   * of its history; `blocked` while the session is not between turns or an undo runs, `busy`
   * while it runs.
   */
  undo?: { end: string; blocked: boolean; busy?: boolean; run: () => void } | null
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

const EMPTY: SessionRowsContext = {
  sessionId: '',
  root: null,
  fork: null,
  forkAtMessage: false,
  retryNotice: null,
  cutNotice: null,
}

const Rows = createContext<Store<SessionRowsContext>>(createStore(EMPTY))

/** Gives the rows under it what they share; the store it keeps changes, never the context. */
function SessionRowsProvider(props: { value: SessionRowsContext; children?: ReactNode }) {
  const [store] = useState(() => createStore(props.value))
  useLayoutEffect(() => store.set(props.value), [store, props.value])
  return createElement(Rows.Provider, { value: store }, props.children)
}

export const SessionRows = { Provider: SessionRowsProvider }

const whole = (rows: SessionRowsContext) => rows

/** All that the rows share; a row that uses part of it selects that part instead. */
export function useSessionRows(): SessionRowsContext
/** Part of what the rows share, redrawn only when a field of it changes. */
export function useSessionRows<S extends object>(select: (rows: SessionRowsContext) => S): S
export function useSessionRows<S extends object>(
  select?: (rows: SessionRowsContext) => S,
): S | SessionRowsContext {
  const store = useContext(Rows)
  return useSelector<SessionRowsContext, S | SessionRowsContext>(
    store,
    select ?? whole,
    sameFields,
  )
}
