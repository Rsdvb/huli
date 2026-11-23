// The terminals, browser tabs and devices of a session's side panel that a message can mention,
// from the stores that hold each; Huli: and the other sessions of its host (@ a session).

import { useMemo } from 'react'
import { useBrowserStore } from '@renderer/stores/browser'
import { useDevicesStore } from '@renderer/stores/devices'
import { mentionTerminalsOf, useTerminalsStore } from '@renderer/stores/terminals'
import type { SessionSummary } from '@shared/agent-host'
import { entryShown, useEntry } from '@renderer/lib/features'
import { hostOfPath } from '@renderer/lib/host-paths'
import {
  hostOfSession,
  listedOrigin,
  sessionTitle,
  useSessionsStore,
} from '@renderer/stores/sessions'
import { panelSession } from '@renderer/stores/view'
import type { MentionItem, MentionSurfaces } from './chips'

function pagesOf(sessionId: string | null): MentionItem[] {
  if (!sessionId) return []
  const tabs = useBrowserStore.getState().bySession[sessionId]?.tabs ?? []
  return tabs.map((tab) => ({ id: tab.id, name: tab.title || tab.url || tab.id }))
}

function devicesOf(sessionId: string | null): MentionItem[] {
  if (!sessionId) return []
  return useDevicesStore
    .getState()
    .devices.filter((device) => device.sessionId === sessionId)
    .map((device) => ({ id: device.id, name: device.name }))
}

/** Huli: the host a panel's sessions are on: its session's, or New session's project's. */
function panelHost(byId: Record<string, SessionSummary>, panel: string): string | null {
  const sessionId = panelSession(panel)
  if (sessionId) return byId[sessionId] ? hostOfSession(byId[sessionId]) : null
  return hostOfPath(panel.slice(panel.indexOf(':') + 1))
}

/**
 * Huli: the sessions a message of the panel's can mention: the user's own on its host, in the
 * list or archived, but not its own session nor a subagent, which the history tool cannot read.
 */
export function mentionSessionsOf(
  byId: Record<string, SessionSummary>,
  panel: string | null,
): SessionSummary[] {
  if (!panel) return []
  const own = panelSession(panel)
  const hostId = panelHost(byId, panel)
  return Object.values(byId).filter(
    (s) =>
      s.id !== own &&
      s.origin !== 'subagent' &&
      listedOrigin(s) &&
      !s.prepared &&
      hostOfSession(s) === hostId,
  )
}

/** What a panel's session can mention now: its session's, or New session's terminals alone. */
export function mentionSurfacesOf(panel: string | null): MentionSurfaces {
  const sessionId = panel ? panelSession(panel) : null
  const sessions = entryShown('composer.sessionMention')
    ? mentionSessionsOf(useSessionsStore.getState().byId, panel)
    : []
  return {
    terminal: mentionTerminalsOf(useTerminalsStore.getState().byId, panel),
    page: pagesOf(sessionId),
    device: devicesOf(sessionId),
    session: sessions.map((s) => ({ id: s.id, name: sessionTitle(s) })),
  }
}

/** `mentionSurfacesOf` as a hook, which changes only when what it lists changes. */
export function useMentionSurfaces(panel: string | null): MentionSurfaces {
  const sessionId = panel ? panelSession(panel) : null
  const terminals = useTerminalsStore((s) => JSON.stringify(mentionTerminalsOf(s.byId, panel)))
  const pages = useBrowserStore((s) =>
    JSON.stringify(
      sessionId
        ? (s.bySession[sessionId]?.tabs ?? []).map((tab) => [
            tab.id,
            tab.title || tab.url || tab.id,
          ])
        : [],
    ),
  )
  const devices = useDevicesStore((s) =>
    JSON.stringify(
      sessionId
        ? s.devices.filter((d) => d.sessionId === sessionId).map((d) => [d.id, d.name])
        : [],
    ),
  )
  // Huli: as their ids and titles, so the box resolves a session's chip with its title now.
  const mentionOn = useEntry('composer.sessionMention')
  const sessions = useSessionsStore((s) =>
    mentionOn
      ? JSON.stringify(mentionSessionsOf(s.byId, panel).map((x) => [x.id, sessionTitle(x)]))
      : '[]',
  )
  return useMemo(() => {
    const items = (json: string) =>
      (JSON.parse(json) as [string, string][]).map(([id, name]) => ({ id, name }))
    return {
      terminal: JSON.parse(terminals) as MentionItem[],
      page: items(pages),
      device: items(devices),
      session: items(sessions),
    }
  }, [terminals, pages, devices, sessions])
}
