// Huli: other sessions in the composer's `@` list (@ a session): the user's own sessions of the
// box's host whose title has what is typed, the latest first, each with its agent and project.
// Choosing one writes `@session:<id>` as a chip; the message then carries only a reference, which
// the agent reads with read_session_history. A session row dragged onto the box does the same.

import { useMemo } from 'react'
import { useDroppable } from '@dnd-kit/react'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { useEntry } from '@renderer/lib/features'
import { useProjectsStore } from '@renderer/stores/projects'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import {
  useSessionDragStore,
  type SessionDragData,
} from '@renderer/features/split/session-drag-model'
import { mentionSessionsOf } from './mention-surfaces'
import { surfaceMention } from './chips'

/** Session rows the list shows at most, over the files. */
export const SESSION_ROWS = 5

export interface SessionMention {
  sessionId: string
  title: string
  agentId: AgentId
  hostId: string | null
  /** Its project's name, or null for No project. */
  project: string | null
  /** Where what was typed starts in the title, and its length, for the tint. */
  match: [number, number] | null
}

export const isSessionMention = (item: object): item is SessionMention => 'sessionId' in item

/** What the box writes for a session: `session:<short id>` after its `@`. */
export function sessionMentionName(sessionId: string): string {
  return surfaceMention('session', sessionId).slice(1)
}

/**
 * The sessions whose title holds the query, the ones that start with it first, then the latest;
 * none with nothing typed, so a bare `@` lists the files as before.
 */
export function matchSessions(
  sessions: readonly SessionSummary[],
  query: string,
  projectName: (s: SessionSummary) => string | null,
  limit = SESSION_ROWS,
): SessionMention[] {
  const typed = query.trim().toLowerCase()
  if (typed === '') return []
  return sessions
    .flatMap((s) => {
      const title = sessionTitle(s)
      const at = title.toLowerCase().indexOf(typed)
      return at < 0 ? [] : [{ s, title, at }]
    })
    .sort((a, b) => Number(a.at !== 0) - Number(b.at !== 0) || b.s.updatedAt - a.s.updatedAt)
    .slice(0, limit)
    .map(({ s, title, at }) => ({
      sessionId: s.id,
      title,
      agentId: s.agentId,
      hostId: hostOfSession(s),
      project: projectName(s),
      match: [at, typed.length],
    }))
}

/** The session rows for the `@` being typed in the box of `panel`, or none. */
export function useSessionMentions(query: string | null, panel: string | null): SessionMention[] {
  const on = useEntry('composer.sessionMention')
  const active = on && query !== null && query.trim() !== '' && !query.includes('/')
  const sessions = useSessionsStore(
    useShallow((s) => (active ? mentionSessionsOf(s.byId, panel) : NO_SESSIONS)),
  )
  const projects = useProjectsStore((s) => s.projects)
  return useMemo(() => {
    if (!active || !query) return NO_MENTIONS
    const names = new Map(projects.map((p) => [p.path, p.name]))
    return matchSessions(sessions, query, (s) =>
      s.scratch ? null : (names.get(s.projectPath) ?? s.projectPath),
    )
  }, [active, query, sessions, projects])
}

const NO_SESSIONS: SessionSummary[] = []
const NO_MENTIONS: SessionMention[] = []

// Dropping a session's row onto the box.

interface ComposerDropData {
  composerDrop: { draft: string; hostId: string | null; own: string | null }
}

/** Whether a dragged session can be mentioned in the box: the user's own, of its host, not itself. */
function mentionable(sessionId: string, drop: ComposerDropData['composerDrop']): boolean {
  const summary = useSessionsStore.getState().byId[sessionId]
  return (
    !!summary &&
    summary.id !== drop.own &&
    summary.origin !== 'subagent' &&
    hostOfSession(summary) === drop.hostId
  )
}

/**
 * The box as a drop target for a session's row while such a drag runs, which `attach` sets on
 * it; `over` while one it takes is over it.
 */
export function useComposerDrop(
  draft: string,
  hostId: string | null,
  own: string | null,
): { attach: (el: Element | null) => void; over: boolean } {
  const on = useEntry('composer.sessionMention')
  const data = useMemo<ComposerDropData>(
    () => ({ composerDrop: { draft, hostId, own } }),
    [draft, hostId, own],
  )
  const takes = useSessionDragStore((s) =>
    on && s.dragging && !s.dragging.paneId
      ? mentionable(s.dragging.sessionId, data.composerDrop)
      : false,
  )
  const target = useDroppable({ id: `huli-composer-drop:${draft}`, data, disabled: !takes })
  return { attach: target.ref, over: takes && target.isDropTarget }
}

/** Whether a drag is over the box, where it mentions rather than splits. */
export function overComposer(target: unknown): boolean {
  return !!(target as Partial<ComposerDropData> | null | undefined)?.composerDrop
}

/**
 * Ends a drag that let go over a composer, mentioning the session in it; false when the target is
 * none, which leaves the drop to the folders and the split.
 */
export function dropIntoComposer(source: unknown, target: unknown): boolean {
  const drop = (target as Partial<ComposerDropData> | null | undefined)?.composerDrop
  if (!drop) return false
  const sessionId = (source as Partial<SessionDragData> | null | undefined)?.sessionId
  if (sessionId && mentionable(sessionId, drop)) {
    emitAppEvent({
      kind: 'mention-into-composer',
      draft: drop.draft,
      mention: surfaceMention('session', sessionId),
    })
  }
  return true
}
