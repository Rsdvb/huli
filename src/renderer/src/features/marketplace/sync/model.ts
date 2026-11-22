// Marketplace › Sync's rows and the changes the page holds until a preview: the servers and skills
// across every place, which places have each, and the changes as the host takes them.

import type {
  AgentSyncState,
  SyncChange,
  SyncInstructionsPlace,
  SyncMcpPlace,
  SyncServerView,
  SyncSkillPlace,
  SyncSkillView,
} from '@shared/agent-sync'

export type SyncSection = 'mcp' | 'skills' | 'instructions'

/** What the page changes before the preview, by row and place. */
export interface Pending {
  /** `server\0place` to add or remove. */
  mcp: ReadonlyMap<string, 'add' | 'remove'>
  /** `skill\0place` to copy into. */
  skills: ReadonlySet<string>
  /** The snippets chosen anew for an instructions file, by place. */
  instructions: ReadonlyMap<string, readonly string[]>
}

export const NO_PENDING: Pending = { mcp: new Map(), skills: new Set(), instructions: new Map() }

export const cellKey = (row: string, place: string): string => `${row}\0${place}`

export interface ServerRow {
  name: string
  /** The first place's copy, which a copy to another place takes. */
  source: { place: SyncMcpPlace; server: SyncServerView }
  /** The place ids that have it. */
  in: ReadonlySet<string>
  /** Some places' copies are not the same server. */
  differs: boolean
}

export function serverRows(places: readonly SyncMcpPlace[], query: string): ServerRow[] {
  const rows = new Map<string, ServerRow & { prints: Set<string>; in: Set<string> }>()
  for (const place of places) {
    for (const server of place.servers) {
      let row = rows.get(server.name)
      if (!row) {
        row = {
          name: server.name,
          source: { place, server },
          in: new Set(),
          differs: false,
          prints: new Set(),
        }
        rows.set(server.name, row)
      }
      row.in.add(place.id)
      row.prints.add(server.fingerprint)
      row.differs = row.prints.size > 1
    }
  }
  const q = query.trim().toLowerCase()
  return [...rows.values()]
    .filter((row) => q === '' || row.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface SkillRow {
  name: string
  skill: SyncSkillView
  /** The place a copy is taken from: the first that has it. */
  from: SyncSkillPlace
  in: ReadonlySet<string>
}

export function skillRows(places: readonly SyncSkillPlace[], query: string): SkillRow[] {
  const rows = new Map<string, SkillRow & { in: Set<string> }>()
  for (const place of places) {
    for (const skill of place.skills) {
      let row = rows.get(skill.name)
      if (!row) {
        row = { name: skill.name, skill, from: place, in: new Set() }
        rows.set(skill.name, row)
      }
      row.in.add(place.id)
    }
  }
  const q = query.trim().toLowerCase()
  return [...rows.values()]
    .filter(
      (row) =>
        q === '' || row.name.toLowerCase().includes(q) || row.skill.title.toLowerCase().includes(q),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Whether every agent whose own folder `place` is reads the skill already from another folder,
 * so a copy there would change nothing for them.
 */
export function reachable(
  row: SkillRow,
  place: SyncSkillPlace,
  places: readonly SyncSkillPlace[],
): boolean {
  if (place.owners.length === 0) return false
  return place.owners.every((agent) =>
    places.some(
      (other) =>
        other.id !== place.id &&
        (other.owners.includes(agent) || other.readers.includes(agent)) &&
        row.in.has(other.id),
    ),
  )
}

/** The snippets an instructions file is to hold: as changed on the page, else as written. */
export function chosenFor(place: SyncInstructionsPlace, pending: Pending): readonly string[] {
  return pending.instructions.get(place.id) ?? place.snippetIds
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, index) => item === b[index])

/**
 * An instructions file the preview takes: one changed here, or whose block Kite wrote before a
 * snippet changed. A block edited in the file goes only when asked, as it would be replaced.
 */
export function instructionsChanged(place: SyncInstructionsPlace, pending: Pending): boolean {
  if (place.problem) return false
  const chosen = pending.instructions.get(place.id)
  if (chosen !== undefined) {
    return (
      !sameList(chosen, place.snippetIds) || place.block === 'edited' || place.block === 'outdated'
    )
  }
  return place.block === 'outdated'
}

/** The pending changes as the host takes them, in the page's order. */
export function changesOf(state: AgentSyncState, pending: Pending): SyncChange[] {
  const out: SyncChange[] = []
  const rows = new Map(serverRows(state.mcp, '').map((row) => [row.name, row]))
  for (const [key, action] of pending.mcp) {
    const [server, place] = key.split('\0') as [string, string]
    if (action === 'remove') out.push({ kind: 'mcp-remove', server, place })
    else {
      const row = rows.get(server)
      if (row) out.push({ kind: 'mcp-add', server, from: row.source.place.id, to: place })
    }
  }
  const skills = new Map(skillRows(state.skills, '').map((row) => [row.name, row]))
  for (const key of pending.skills) {
    const [skill, place] = key.split('\0') as [string, string]
    const row = skills.get(skill)
    if (row) out.push({ kind: 'skill-copy', skill, from: row.from.id, to: place })
  }
  for (const place of state.instructions) {
    if (instructionsChanged(place, pending)) {
      out.push({
        kind: 'instructions',
        place: place.id,
        snippetIds: [...chosenFor(place, pending)],
      })
    }
  }
  return out
}

/** The count of pending changes in each section. */
export function pendingCounts(
  state: AgentSyncState,
  pending: Pending,
): Record<SyncSection, number> {
  return {
    mcp: pending.mcp.size,
    skills: pending.skills.size,
    instructions: state.instructions.filter((place) => instructionsChanged(place, pending)).length,
  }
}

/** A short path, with the home folder as ~. */
export function shortPath(path: string, home: string | null): string {
  if (home && path.toLowerCase().startsWith(home.toLowerCase())) {
    return `~${path.slice(home.length)}`
  }
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, '~')
}
