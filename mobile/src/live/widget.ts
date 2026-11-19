// The home-screen widget's snapshot (plugins/widgets/HuliSessionsWidget.swift reads it): how many
// sessions run and wait on the paired computer, and the latest of them with their state. Only
// titles and states, and no titles while the user hides what notifications say. The module writes
// it to the App Group and reloads the widget; it is written again only when what it shows changed,
// at most every few seconds. Siri,
// Shortcuts and the Control Center controls read it too (plugins/widgets/HuliOpenIntents.swift):
// the sessions they offer to open, on the computer `hostId` names (SavedHost.id).

import { AppState } from 'react-native'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { HuliLive } from '../../modules/huli-live'
import { needsYou, sessionTitle } from '../sessions'

const MAX_ROWS = 12

type RowState = 'waiting' | 'running' | 'error' | 'done' | 'idle'

const RANK: Record<RowState, number> = { waiting: 0, running: 1, error: 2, done: 3, idle: 4 }

function stateOf(s: SessionSummary): RowState {
  if (needsYou(s)) return 'waiting'
  if (s.status === 'running' || s.status === 'starting') return 'running'
  if (s.status === 'failed' || s.attention === 'error') return 'error'
  if (s.attention === 'unread') return 'done'
  return 'idle'
}

export interface WidgetInput {
  paired: boolean
  hostName: string | null
  /** The computer's id in the app, which links name it by. */
  hostId?: string | null
  sessions: Map<string, SessionSummary>
  agents: Map<string, AgentStatus>
  hidden: boolean
}

/** The least time between two writes: each reloads the widget, and the system budgets reloads. */
const WRITE_EVERY = 5000

/** What the widget shows, as last written or waiting to be. */
let shown: string | null = null
let queued: object | null = null
let lastWrite = 0
let timer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const snapshot = queued
  queued = null
  if (!snapshot || !HuliLive) return
  lastWrite = Date.now()
  try {
    HuliLive.setWidgetSnapshot(JSON.stringify({ ...snapshot, at: lastWrite }))
  } catch {
    shown = null
  }
}

// A change still waiting goes out before the app may be suspended.
AppState.addEventListener('change', (next) => {
  if (next !== 'active' && queued) flush()
})

export function writeWidget(input: WidgetInput): void {
  if (!HuliLive) return
  const rows = [...input.sessions.values()]
    .filter((s) => s.parentId === null && s.archivedAt === null)
    .map((s) => ({ s, state: stateOf(s) }))
  const running = rows.filter((row) => row.state === 'running').length
  const waiting = rows.filter((row) => row.state === 'waiting').length
  const latest = rows
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.s.updatedAt - a.s.updatedAt)
    .slice(0, MAX_ROWS)
    .map(({ s, state }) => {
      const agent = input.agents.get(s.agentId)?.name
      return {
        id: s.id,
        ...(input.hidden ? {} : { title: sessionTitle(s) }),
        state,
        ...(agent ? { agent } : {}),
        at: s.updatedAt,
      }
    })
  const snapshot = {
    v: 1,
    paired: input.paired,
    ...(input.paired && input.hostName ? { host: input.hostName } : {}),
    ...(input.paired && input.hostId ? { hostId: input.hostId } : {}),
    running: input.paired ? running : 0,
    waiting: input.paired ? waiting : 0,
    sessions: input.paired ? latest : [],
  }
  // A row's time only orders the rows, and changes every second a session runs: it is written,
  // since the widget reads it, but a change of it alone is no change.
  const text = JSON.stringify({
    ...snapshot,
    sessions: snapshot.sessions.map(({ at, ...row }) => row),
  })
  if (text === shown) return
  shown = text
  queued = snapshot
  if (timer) return
  const wait = lastWrite + WRITE_EVERY - Date.now()
  if (wait <= 0) flush()
  else timer = setTimeout(flush, wait)
}
