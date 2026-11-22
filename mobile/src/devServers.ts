// Huli: the computer's dev servers on the phone (开发服务器), and previews of them in a web view.
// The list is the computer's `ports.list`, read when the page opens and on a pull, never on a
// timer: the ports its user's programs listen on above 1024, each named by the project or the
// worktree session it runs in, and a worktree session's port block (KITE_PORT) named after the
// session. A preview asks the computer for a port of its own that proxies to one of them
// (@shared/dev-preview), which only a direct route reaches: the relay carries no web page.

import type { Project, SessionSummary } from '@shared/agent-host'
import {
  parsePreviewOpened,
  PREVIEW_CLOSE,
  PREVIEW_OPEN,
  type PreviewOpened,
} from '@shared/dev-preview'
import {
  devPorts,
  MAX_PORT_FOLDERS,
  parsePortList,
  type ListeningPort,
} from '@shared/port-forwards'
import type { HostLink } from '@shared/remote/link'
import type { DirectAddress } from '@shared/remote/protocol'
import { lastPort } from '@shared/worktree-ports'
import { currentRoute, routeKind } from './connection'
import { ROUTE_NAMES } from './linkInfo'
import { hasLiveWorktree } from './sessionMenu'
import { sessionTitle } from './sessions'

export interface DevServer {
  port: number
  /** The program's name, such as node or vite; null when the computer could not tell. */
  process: string | null
  /** The worktree session it belongs to, by its folder or its port block. */
  session: { id: string; title: string } | null
  /** The project it runs in, by name. */
  project: string | null
  /** The folder it runs in, as the computer writes it. */
  folder: string | null
}

/** The folders a listing asks about: every live worktree first, as they may lie in a project. */
export function serverFolders(
  projects: readonly Project[],
  sessions: ReadonlyMap<string, SessionSummary>,
): string[] {
  const folders: string[] = []
  for (const summary of sessions.values()) {
    if (summary.worktree && hasLiveWorktree(summary)) folders.push(summary.worktree.path)
  }
  for (const project of projects) if (!project.missing) folders.push(project.path)
  return [...new Set(folders)].slice(0, MAX_PORT_FOLDERS)
}

function labelled(
  entry: ListeningPort,
  projects: readonly Project[],
  sessions: ReadonlyMap<string, SessionSummary>,
): DevServer {
  let session: SessionSummary | null = null
  for (const summary of sessions.values()) {
    const worktree = summary.worktree
    if (!worktree || !hasLiveWorktree(summary)) continue
    const block = worktree.ports
    const inBlock = !!block && entry.port >= block.first && entry.port <= lastPort(block)
    if (inBlock || (entry.folder !== null && entry.folder === worktree.path)) {
      session = summary
      break
    }
  }
  const project =
    projects.find((p) => p.path === (session?.projectPath ?? entry.folder))?.name ?? null
  return {
    port: entry.port,
    process: entry.process,
    session: session ? { id: session.id, title: sessionTitle(session) } : null,
    project,
    folder: entry.folder,
  }
}

/**
 * The computer's dev servers, a session's first when `first` names one, then those of a session
 * or a project, each by port; null when the computer cannot list its ports.
 */
export async function listDevServers(
  link: HostLink,
  projects: readonly Project[],
  sessions: ReadonlyMap<string, SessionSummary>,
  first: string | null = null,
): Promise<DevServer[] | null> {
  const answer = parsePortList(
    await link.request('ports.list', { folders: serverFolders(projects, sessions) }),
  )
  if (!answer) throw new Error('The computer answered no list')
  if (answer.ports === null) return null
  const rank = (server: DevServer): number =>
    first !== null && server.session?.id === first
      ? 0
      : server.session
        ? 1
        : server.project || server.folder
          ? 2
          : 3
  return devPorts(answer.ports)
    .map((entry) => labelled(entry, projects, sessions))
    .sort((a, b) => rank(a) - rank(b) || a.port - b.port)
}

/** The route a preview goes over, in words: 局域网 192.168.1.5. */
export function previewRouteText(address: DirectAddress): string {
  return `${ROUTE_NAMES[routeKind(address)]} ${address.host}`
}

export type PreviewStart =
  | { ok: true; url: string; origin: string; address: DirectAddress; opened: PreviewOpened }
  | { ok: false; reason: 'relay' | 'offline' }
  | { ok: false; reason: 'failed'; error: unknown }

/**
 * Opens a preview of the computer's port over the route the link is on now: the address the
 * computer was last heard at, where it listens for this phone's preview.
 */
export async function openPreview(link: HostLink, port: number): Promise<PreviewStart> {
  const route = currentRoute()
  if (!route) return { ok: false, reason: 'offline' }
  if (route.kind === 'relay') return { ok: false, reason: 'relay' }
  let opened: PreviewOpened | null
  try {
    opened = parsePreviewOpened(await link.request(PREVIEW_OPEN, { port }))
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'needs_direct') return { ok: false, reason: 'relay' }
    return { ok: false, reason: 'failed', error }
  }
  if (!opened) return { ok: false, reason: 'failed', error: null }
  const host = route.address.host.includes(':') ? `[${route.address.host}]` : route.address.host
  const origin = `http://${host}:${opened.port}`
  return { ok: true, url: `${origin}${opened.path}`, origin, address: route.address, opened }
}

/** The preview is no longer shown: the computer closes its port, unasked for an answer. */
export function closePreview(link: HostLink, port: number): void {
  link.request(PREVIEW_CLOSE, { port }).catch(() => {})
}

/** What a preview that could not open says. */
export const NEEDS_DIRECT = '需要直连（同一 Wi-Fi 或 Tailscale）才能预览'
