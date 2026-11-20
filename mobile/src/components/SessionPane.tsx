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

let paneListener: ((id: string) => void) | null = null

/**
 * Asks the 会话 tab's pane to show a session, as search does on a wide window rather than push it
 * over the split. False when no pane listens, as on a phone, for the caller to open it itself.
 */
export function openInPane(id: string): boolean {
  if (!paneListener) return false
  paneListener(id)
  return true
}

/** The 会话 tab's split, taking pane requests while it is wide. */
export function listenForPane(listener: ((id: string) => void) | null): void {
  paneListener = listener
}

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
