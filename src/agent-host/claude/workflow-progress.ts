// Huli: a Claude Code workflow's agents, from the rows its run reports. While a workflow runs,
// Claude Code's `task_progress` for its task carries `workflow_progress`: the run's whole list of
// rows, one `workflow_phase` row per phase and one `workflow_agent` row per agent() call, each
// replaced in place as it changes (`workflow_log` rows are left out of what the SDK gets). The
// list comes again whenever an agent is queued, starts or ends, and at most every ten seconds
// while agents only make progress. An ended task's `task_notification` may carry the list too,
// cut down to fit, with `workflow_progress_omitted` counting the rows left out.

import {
  WORKFLOW_AGENTS_MAX,
  WORKFLOW_PHASES_MAX,
  type WorkflowAgentDetail,
  type WorkflowAgentView,
  type WorkflowPhaseView,
  type WorkflowView,
} from '@shared/thread'
import type { StoredMessage } from './sdk'

const LABEL_LIMIT = 120
const LINE_LIMIT = 300
const PREVIEW_LIMIT = 2_000
const ROWS_READ = 1_000
const PARAGRAPH = '\n\n'

interface AgentRow extends WorkflowAgentView {
  phaseTitle: string | null
  agentId: string | null
  prompt: string | null
  result: string | null
  fullError: string | null
  model: string | null
  tokens: number | null
  toolCalls: number | null
  lastTool: string | null
  attempt: number | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const index = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}\u2026` : text
}

/** A string field in one line, clipped; null when empty or absent. */
function line(value: unknown, limit = LINE_LIMIT): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text === '' ? null : clip(text, limit)
}

/** A string field as written, clipped; null when empty or absent. */
function block(value: unknown, limit = PREVIEW_LIMIT): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\r\n?/g, '\n').trim()
  return text === '' ? null : clip(text, limit)
}

/** Claude Code's errors for an agent the run itself ended, or the user skipped: no failures. */
const STOPPED = /^(Stopped because the workflow |skipped by user$)/

function agentState(row: Record<string, unknown>, error: string | null): AgentRow['state'] {
  switch (row.state) {
    case 'done':
      return 'done'
    case 'error':
      return row.skipped === true ||
        row.endedWithRun !== undefined ||
        (error !== null && STOPPED.test(error))
        ? 'stopped'
        : 'failed'
    case 'progress':
      return 'running'
    default:
      // `start` names both an agent queued for its turn and one that began; only the latter has
      // a start time.
      return count(row.startedAt) === null ? 'queued' : 'running'
  }
}

function agentRow(row: Record<string, unknown>, before: AgentRow | undefined): AgentRow | null {
  const at = index(row.index)
  if (at === null) return null
  const fullError = block(row.error)
  const state = agentState(row, fullError)
  const ended = state === 'done' || state === 'failed' || state === 'stopped'
  // A run's list cut down to fit leaves out what an agent was asked and gave back.
  const kept = <K extends keyof AgentRow>(key: K, value: AgentRow[K] | null): AgentRow[K] | null =>
    value ?? before?.[key] ?? null
  return {
    index: at,
    label: line(row.label, LABEL_LIMIT) ?? before?.label ?? `#${at}`,
    phase: index(row.phaseIndex) ?? before?.phase ?? null,
    phaseTitle: line(row.phaseTitle, LABEL_LIMIT) ?? before?.phaseTitle ?? null,
    state,
    startedAt: count(row.startedAt),
    durationMs: ended ? count(row.durationMs) : null,
    progress: ended ? null : (line(row.lastToolSummary) ?? line(row.lastToolName)),
    error: state === 'done' ? null : line(fullError),
    ...(row.cached === true ? { cached: true } : {}),
    agentId: kept('agentId', line(row.agentId, 64)),
    prompt: kept('prompt', block(row.promptPreview)),
    result: kept('result', block(row.resultPreview)),
    fullError: state === 'done' ? null : fullError,
    model: kept('model', line(row.model, 80)),
    tokens: count(row.tokens) ?? before?.tokens ?? null,
    toolCalls: count(row.toolCalls) ?? before?.toolCalls ?? null,
    lastTool: line(row.lastToolName, 80) ?? before?.lastTool ?? null,
    attempt: index(row.attempt) ?? before?.attempt ?? null,
  }
}

function sameAgent(a: WorkflowAgentView, b: WorkflowAgentView): boolean {
  return (
    a.index === b.index &&
    a.label === b.label &&
    a.phase === b.phase &&
    a.state === b.state &&
    a.startedAt === b.startedAt &&
    a.durationMs === b.durationMs &&
    a.progress === b.progress &&
    a.error === b.error &&
    a.cached === b.cached
  )
}

function viewOf(row: AgentRow): WorkflowAgentView {
  return {
    index: row.index,
    label: row.label,
    phase: row.phase,
    state: row.state,
    startedAt: row.startedAt,
    durationMs: row.durationMs,
    progress: row.progress,
    error: row.error,
    ...(row.cached ? { cached: true } : {}),
  }
}

/** One workflow task's run: its agents' rows as last reported, and what the board shows of them. */
export class WorkflowRun {
  private readonly agents = new Map<number, AgentRow>()
  private readonly phases = new Map<number, string>()
  view: WorkflowView = { phases: [], agents: [] }

  /** Takes rows the run reported; true when what the board shows changed. */
  take(rows: readonly unknown[]): boolean {
    for (const row of rows.slice(0, ROWS_READ)) {
      if (!isRecord(row)) continue
      if (row.type === 'workflow_phase') {
        const at = index(row.index)
        const title = line(row.title, LABEL_LIMIT)
        if (at !== null && title !== null) this.phases.set(at, title)
      } else if (row.type === 'workflow_agent') {
        const at = index(row.index)
        const next = at === null ? null : agentRow(row, this.agents.get(at))
        if (next) this.agents.set(next.index, next)
      }
    }
    return this.refresh()
  }

  /** The run ended: an agent still waiting or at work stopped with it. */
  settle(): boolean {
    for (const [at, row] of this.agents) {
      if (row.state !== 'queued' && row.state !== 'running') continue
      this.agents.set(at, { ...row, state: 'stopped', progress: null })
    }
    return this.refresh()
  }

  /** What one agent was asked and returned, as the run reported it; null for one it never named. */
  detail(at: number): (Omit<WorkflowAgentDetail, 'reply'> & { agentId: string | null }) | null {
    const row = this.agents.get(at)
    if (!row) return null
    return {
      prompt: row.prompt,
      result: row.result,
      error: row.fullError,
      model: row.model,
      tokens: row.tokens,
      toolCalls: row.toolCalls,
      lastTool: row.lastTool,
      attempt: row.attempt,
      agentId: row.agentId,
    }
  }

  /** Whether one agent ended, so its transcript holds all it will say. */
  ended(at: number): boolean {
    const state = this.agents.get(at)?.state
    return state === 'done' || state === 'failed' || state === 'stopped'
  }

  private refresh(): boolean {
    const titles = new Map(this.phases)
    for (const row of this.agents.values()) {
      if (row.phase !== null && !titles.has(row.phase)) {
        titles.set(row.phase, row.phaseTitle ?? String(row.phase))
      }
    }
    const phases: WorkflowPhaseView[] = [...titles]
      .sort(([a], [b]) => a - b)
      .slice(0, WORKFLOW_PHASES_MAX)
      .map(([at, title]) => ({ index: at, title }))
    const rows = [...this.agents.values()]
      .sort((a, b) => a.index - b.index)
      .slice(0, WORKFLOW_AGENTS_MAX)
    const before = this.view
    const same =
      phases.length === before.phases.length &&
      phases.every(
        (phase, i) =>
          phase.index === before.phases[i]!.index && phase.title === before.phases[i]!.title,
      ) &&
      rows.length === before.agents.length &&
      rows.every((row, i) => sameAgent(row, before.agents[i]!))
    if (same) return false
    // Agents that did not change keep their objects, so a list that did shares them.
    const agents = rows.map((row, i) => {
      const old = before.agents[i]
      return old && sameAgent(row, old) ? old : viewOf(row)
    })
    this.view = { phases, agents }
    return true
  }
}

/** The most of a workflow agent's last message its board row shows. */
export const AGENT_REPLY_LIMIT = 16 * 1024

/**
 * A subagent's last message from its transcript: its text, else the structured result it gave as
 * a call of `StructuredOutput`; null when it has none yet.
 */
export function lastReply(messages: readonly StoredMessage[]): WorkflowAgentDetail['reply'] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'assistant') continue
    const content = (message.message as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) continue
    const texts: string[] = []
    let structured: unknown
    for (const item of content as unknown[]) {
      if (!isRecord(item)) continue
      if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
      if (item.type === 'tool_use' && item.name === 'StructuredOutput') structured = item.input
    }
    const text =
      texts.join(PARAGRAPH).trim() ||
      (structured !== undefined ? JSON.stringify(structured, null, 2) : '')
    if (text === '') continue
    const cut = text.length > AGENT_REPLY_LIMIT
    return { text: cut ? text.slice(0, AGENT_REPLY_LIMIT) : text, truncated: cut }
  }
  return null
}
