// Huli: another session in the composer's `@` list (@ a session), as the desktop's composer has it
// (src/renderer/src/features/session/composer/session-mentions.ts). The box shows `@<title>`; what
// is sent writes it `@session:<short id>`, as the desktop does, with a reference to the session,
// which the agent reads with read_session_history.

import type { SessionSummary } from '@shared/agent-host'
import type { UserContent } from '@shared/thread'
import type { Mention } from './composerText'
import { sessionTitle } from './sessions'

/** The key of a mention that stands for a session, by the session's id. */
const KEY = 'session:'

export const sessionKey = (sessionId: string): string => `${KEY}${sessionId}`

export function sessionOfKey(key: string): string | null {
  return key.startsWith(KEY) ? key.slice(KEY.length) : null
}

/** The desktop's short id of a mention: the id's first eight letters and digits. */
export function shortSessionId(sessionId: string): string {
  return sessionId
    .slice(sessionId.lastIndexOf(':') + 1)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 8)
}

/** Session rows the list shows at most. */
const LIMIT = 5

/**
 * The sessions whose title holds the query, the ones that start with it first, then the latest:
 * the user's own of the computer, but not `own`, nor a subagent, which the tool cannot read.
 */
export function matchSessions(
  sessions: Iterable<SessionSummary>,
  query: string,
  own: string | null,
): SessionSummary[] {
  const typed = query.trim().toLowerCase()
  if (typed === '' || typed.includes('/')) return []
  const found: { s: SessionSummary; at: number }[] = []
  for (const s of sessions) {
    if (s.id === own || s.origin === 'subagent' || s.origin === 'routine' || s.origin === 'task') {
      continue
    }
    const at = sessionTitle(s).toLowerCase().indexOf(typed)
    if (at >= 0) found.push({ s, at })
  }
  return found
    .sort((a, b) => Number(a.at !== 0) - Number(b.at !== 0) || b.s.updatedAt - a.s.updatedAt)
    .slice(0, LIMIT)
    .map(({ s }) => s)
}

/**
 * The text as it is sent, each session's `@<title>` written `@session:<short id>`, and a reference
 * to each session it still mentions.
 */
export function withSessionRefs(
  text: string,
  mentions: readonly Mention[],
  titles: ReadonlyMap<string, string>,
): { text: string; refs: UserContent[] } {
  let out = text
  const refs = new Map<string, UserContent>()
  for (const m of [...mentions].sort((a, b) => b.from - a.from)) {
    const sessionId = sessionOfKey(m.key)
    if (!sessionId) continue
    out = `${out.slice(0, m.from)}@session:${shortSessionId(sessionId)}${out.slice(m.to)}`
    refs.set(sessionId, {
      type: 'ref',
      ref: { kind: 'session', sessionId, name: titles.get(sessionId) ?? sessionId },
    })
  }
  return { text: out, refs: [...refs.values()].reverse() }
}
