// The paired computers' sessions in Spotlight (iOS): the active computer's top-level sessions, by
// title, project and agent, each opening its session on its computer. A computer's items are
// replaced only when what they say changed; an unpaired computer's go, and every item goes while
// the user hides what notifications say, since a title is just what that hides.

import type { AgentStatus, Project, SessionSummary } from '@shared/agent-host'
import { HuliSystem, type IndexedSession } from '../../modules/huli-system'
import { folder, sessionTitle } from '../sessions'

/** Spotlight is for finding a session, not an archive: the latest ones are enough. */
const MAX_ITEMS = 400

export interface SpotlightInput {
  /** Whether any computer is paired. */
  paired: boolean
  /** Every paired computer's id. */
  computers: string[]
  /** The active computer and its lists, once they hold something to show. */
  active: {
    id: string
    sessions: Map<string, SessionSummary>
    agents: Map<string, AgentStatus>
    projects: Project[]
  } | null
  hidden: boolean
}

/** What each computer's items say, as last handed to Spotlight in this run of the app. */
const indexed = new Map<string, string>()
let cleared = false

function itemsOf(active: NonNullable<SpotlightInput['active']>): IndexedSession[] {
  const names = new Map(active.projects.map((p) => [p.path, p.name]))
  return [...active.sessions.values()]
    .filter((s) => s.parentId === null && s.archivedAt === null && !s.prepared)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ITEMS)
    .map((s) => {
      const project = s.scratch ? undefined : (names.get(s.projectPath) ?? folder(s.projectPath))
      const agent = active.agents.get(s.agentId)?.name
      return {
        id: s.id,
        title: sessionTitle(s),
        ...(project ? { project } : {}),
        ...(agent ? { agent } : {}),
        at: s.updatedAt,
      }
    })
}

export function syncSpotlight(input: SpotlightInput): void {
  const native = HuliSystem
  if (!native) return
  if (!input.paired || input.hidden) {
    if (cleared) return
    cleared = true
    indexed.clear()
    void native.removeAllSessions().catch(() => {})
    return
  }
  cleared = false
  void native.keepSessions(input.computers).catch(() => {})
  for (const id of [...indexed.keys()]) {
    if (!input.computers.includes(id)) indexed.delete(id)
  }
  const active = input.active
  if (!active) return
  const items = itemsOf(active)
  // Recency orders the list but changes with every turn; only what the items say counts.
  const said = JSON.stringify(items.map(({ at: _at, ...rest }) => rest))
  if (indexed.get(active.id) === said) return
  indexed.set(active.id, said)
  void native.indexSessions(active.id, JSON.stringify(items)).catch(() => {
    indexed.delete(active.id)
  })
}
