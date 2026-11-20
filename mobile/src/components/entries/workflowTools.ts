// The calls of the workflow tools of Kettu's MCP server, read as the desktop's cards read them
// (src/renderer/src/features/session/entries/workflow-tools.ts), and the answers the phone gave to
// suggestions, which the computer does not keep.

import { useSyncExternalStore } from 'react'
import * as SecureStore from 'expo-secure-store'
import { File, Paths } from 'expo-file-system'
import {
  isPace,
  type CheckLine,
  type CheckNext,
  type Pace,
  type PickCheck,
  type ReportCheck,
} from '@shared/workflow'
import type { ToolEntry } from '@shared/thread'

const WORKFLOW_TOOLS = {
  start: 'suggest_workflow',
  create: 'create_workflow',
  report: 'report_step',
  pick: 'pick_step_agents',
} as const

export type WorkflowTool = keyof typeof WORKFLOW_TOOLS

const BY_NAME = new Map(
  Object.entries(WORKFLOW_TOOLS).map(([tool, name]) => [name, tool as WorkflowTool]),
)
// Claude Code names a call `mcp__kettu__<tool>`, Codex `kettu: <tool>`, other agents their way.
const CALL_NAME = /^(?:mcp__kettu__|kettu\s*[:：]\s*|kettu[_./])?([a-z_]+)$/

function workflowToolOf(entry: Pick<ToolEntry, 'title'>): WorkflowTool | null {
  const name = CALL_NAME.exec(entry.title.trim())?.[1]
  return (name && BY_NAME.get(name as (typeof WORKFLOW_TOOLS)[WorkflowTool])) || null
}

type Fields = Record<string, unknown>

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

function inputOf(entry: ToolEntry): Fields {
  if (!entry.rawInput) return {}
  try {
    const parsed = JSON.parse(entry.rawInput) as unknown
    return isFields(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function resultText(entry: ToolEntry): string {
  return entry.content
    .flatMap((item) => (item.type === 'markdown' ? [item.markdown] : []))
    .join('\n')
    .trim()
}

export function listedLines(answer: string): string[] {
  return answer
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
}

export interface Suggestion {
  workflowId: string
  workflowName: string | null
  task: string
  title: string | null
  pace: Pace
  paceReason: string | null
}

export function suggestionOf(entry: ToolEntry): Suggestion | null {
  const input = inputOf(entry)
  const given = isFields(entry.structured?.suggestion) ? entry.structured.suggestion : {}
  const workflowId = text(given.workflow_id) ?? text(input.workflow_id)
  const task = text(given.task) ?? text(input.task)
  const pace = given.pace ?? input.pace
  if (!workflowId || !task || !isPace(pace)) return null
  return {
    workflowId,
    workflowName: text(given.workflow_name),
    task,
    title: text(given.title) ?? text(input.title),
    pace,
    paceReason: text(given.pace_reason) ?? text(input.pace_reason),
  }
}

export type SavedWorkflow =
  { saved: true; workflowId: string; name: string } | { saved: false; problems: string[] }

export function savedOf(entry: ToolEntry): SavedWorkflow | null {
  const result = entry.structured
  if (result?.saved === true && text(result.workflow_id) && text(result.name)) {
    return { saved: true, workflowId: result.workflow_id as string, name: result.name as string }
  }
  if (result?.saved === false && Array.isArray(result.problems)) {
    const problems = result.problems.flatMap((p: unknown) => {
      if (!isFields(p) || !text(p.message)) return []
      return [text(p.at) ? `${p.at as string}: ${p.message as string}` : (p.message as string)]
    })
    return { saved: false, problems }
  }
  if (entry.status === 'failed') return { saved: false, problems: listedLines(resultText(entry)) }
  return null
}

const isCheckLine = (value: unknown): value is CheckLine<string> =>
  isFields(value) &&
  typeof value.check === 'string' &&
  typeof value.ok === 'boolean' &&
  (value.detail === null || typeof value.detail === 'string')

const isNext = (value: unknown): value is CheckNext =>
  isFields(value) && typeof value.kind === 'string'

export interface ReportCall {
  outcome: string | null
  accepted: boolean
  checks: CheckLine<ReportCheck>[] | null
  next: CheckNext | null
  answer: string
}

export function reportOf(entry: ToolEntry): ReportCall {
  const input = inputOf(entry)
  const result = entry.structured
  const checks =
    Array.isArray(result?.checks) && result.checks.every(isCheckLine)
      ? (result.checks as CheckLine<ReportCheck>[])
      : null
  return {
    outcome: text(input.outcome),
    accepted: typeof result?.accepted === 'boolean' ? result.accepted : entry.status !== 'failed',
    checks,
    next: isNext(result?.next) ? result.next : null,
    answer: resultText(entry),
  }
}

export interface PickInput {
  step: string
  agent: string
  model: string | null
  effort: string | null
  reason: string | null
}

export interface PickCall {
  picks: PickInput[]
  accepted: boolean
  checks: { step: string; lines: CheckLine<PickCheck>[] }[] | null
  next: CheckNext | null
  answer: string
}

export function pickOf(entry: ToolEntry): PickCall {
  const input = inputOf(entry)
  const picks = (Array.isArray(input.picks) ? input.picks : []).flatMap((p: unknown) => {
    if (!isFields(p) || !text(p.step) || !text(p.agent)) return []
    return [
      {
        step: p.step as string,
        agent: p.agent as string,
        model: text(p.model),
        effort: text(p.effort),
        reason: text(p.reason),
      },
    ]
  })
  const result = entry.structured
  const checks = Array.isArray(result?.checks)
    ? (result.checks as unknown[]).flatMap((c) =>
        isFields(c) &&
        typeof c.step === 'string' &&
        Array.isArray(c.lines) &&
        c.lines.every(isCheckLine)
          ? [{ step: c.step, lines: c.lines as CheckLine<PickCheck>[] }]
          : [],
      )
    : null
  return {
    picks,
    accepted: typeof result?.accepted === 'boolean' ? result.accepted : entry.status !== 'failed',
    checks,
    next: isNext(result?.next) ? result.next : null,
    answer: resultText(entry),
  }
}

/** The call is drawn as its workflow card: once it ended, a suggestion only when it reads. */
export function workflowCardOf(entry: ToolEntry): WorkflowTool | null {
  const tool = workflowToolOf(entry)
  if (!tool || entry.permission) return null
  if (tool === 'start') {
    return entry.status === 'completed' && suggestionOf(entry) ? tool : null
  }
  return entry.status === 'completed' || entry.status === 'failed' ? tool : null
}

// What the user answered to a suggestion on this phone, kept in a file of the app's documents. The
// Keychain, where they were kept first, takes values of a couple of kilobytes, which held only 24;
// the desktop keeps 200, so a suggestion answered there and here reads the same for as long.

export type SuggestionAnswer = { kind: 'started'; taskId: string } | { kind: 'declined' }

const ITEM = 'huli.suggestions'
const KEPT = 200

let answers: Record<string, SuggestionAnswer> = {}
const listeners = new Set<() => void>()

function answersFile(): File {
  return new File(Paths.document, 'huli-suggestions.json')
}

async function writeAnswers(): Promise<void> {
  const file = answersFile()
  if (!file.exists) file.create()
  await file.write(JSON.stringify(answers))
}

function readAnswers(raw: string | null): Record<string, SuggestionAnswer> {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return isFields(parsed) ? (parsed as Record<string, SuggestionAnswer>) : {}
  } catch {
    return {}
  }
}

void (async () => {
  const file = answersFile()
  const kept = file.exists ? readAnswers(await file.text()) : {}
  // Those the Keychain held move to the file once.
  const old = readAnswers(await SecureStore.getItemAsync(ITEM).catch(() => null))
  answers = { ...old, ...kept, ...answers }
  if (Object.keys(old).length > 0) {
    await writeAnswers()
    await SecureStore.deleteItemAsync(ITEM).catch(() => {})
  }
})()
  .catch(() => {})
  .finally(() => {
    for (const listener of listeners) listener()
  })

const keyOf = (sessionId: string, entryId: string) => `${sessionId}/${entryId}`

export function answerSuggestion(sessionId: string, entryId: string, answer: SuggestionAnswer) {
  const entries = Object.entries({ ...answers, [keyOf(sessionId, entryId)]: answer })
  answers = Object.fromEntries(entries.slice(-KEPT))
  for (const listener of listeners) listener()
  void Promise.resolve()
    .then(writeAnswers)
    .catch(() => {})
}

export function useSuggestionAnswer(sessionId: string, entryId: string): SuggestionAnswer | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => answers[keyOf(sessionId, entryId)] ?? null,
  )
}
