// The computer's terminals as a paired phone may see them: only while the owner allows devices the
// terminal (the welcome says so, and a `terminal` message when it changes), through the terminal
// host's own `terminals.*` methods on the same link.

import { useEffect, useState } from 'react'
import type { HostLink, LinkState } from '@shared/remote/link'
import type { TerminalInfo } from '@shared/terminal-host'
import { plainTail } from '@shared/terminal-text'

export function useTerminalAllowed(link: HostLink, state: LinkState): boolean {
  const welcomed = state.kind === 'connected' ? state.welcome.terminal : false
  const [allowed, setAllowed] = useState(welcomed)
  useEffect(() => setAllowed(welcomed), [welcomed])
  useEffect(
    () =>
      link.onMessage((message) => {
        if (message.type === 'terminal' && typeof message.allowed === 'boolean') {
          setAllowed(message.allowed)
        }
      }),
    [link],
  )
  return allowed
}

/** A session's terminals, oldest first. */
export async function sessionTerminals(
  link: HostLink,
  projectPath: string,
  sessionId: string,
): Promise<TerminalInfo[]> {
  const list = (await link.request('terminals.list', { projectPath })) as TerminalInfo[]
  return list.filter((t) => t.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt)
}

/** The end of a terminal's output as its screen shows it, by attaching to read its replay. */
export async function terminalTail(link: HostLink, id: string): Promise<string> {
  const { replay } = (await link.request('terminals.attach', { id })) as { replay: string }
  return plainTail(replay, 60)
}
