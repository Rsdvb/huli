// The session screen shown as a pane beside the session list on a wide window (iPad), rather than
// as a screen of its own: the same component, told which session to show and how to close.

import { createContext, useContext, useMemo, type ReactNode } from 'react'

export interface SessionPaneValue {
  id: string
  /** Shows another session in the pane, as a fork does. */
  open(id: string): void
  /** Empties the pane, as leaving the session would. */
  close(): void
}

const SessionPane = createContext<SessionPaneValue | null>(null)

/** The pane the session screen is in; null when it is a screen of its own. */
export function useSessionPane(): SessionPaneValue | null {
  return useContext(SessionPane)
}

export function SessionPaneProvider(props: {
  id: string
  open(id: string): void
  close(): void
  children: ReactNode
}) {
  const { id, open, close } = props
  const value = useMemo(() => ({ id, open, close }), [id, open, close])
  return <SessionPane.Provider value={value}>{props.children}</SessionPane.Provider>
}
