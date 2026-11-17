// The home-screen widget's snapshot (plugins/widgets/HuliSessionsWidget.swift reads it): how many
// sessions run and wait on the paired computer, and the latest of them with their state. Only
// titles and states, and no titles while the user hides what notifications say. The module writes
// it to the App Group and reloads the widget; it is written again only when it changed.

import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { HuliLive } from '../../modules/huli-live'
import { needsYou, sessionTitle } from '../sessions'

const MAX_ROWS = 6

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
  sessions: Map<string, SessionSummary>
  agents: Map<string, AgentStatus>
  hidden: boolean
}

let written: string | null = null

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
    running: input.paired ? running : 0,
    waiting: input.paired ? waiting : 0,
    sessions: input.paired ? latest : [],
  }
  const text = JSON.stringify(snapshot)
  if (text === written) return
  written = text
  try {
    HuliLive.setWidgetSnapshot(JSON.stringify({ ...snapshot, at: Date.now() }))
  } catch {
    written = null
  }
}
