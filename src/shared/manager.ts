// Huli: manager mode (总管模式). A manager session's agent never changes files: it splits the
// user's task, hands each step to a worker from the roster, checks the results and goes on, while
// Kite runs the review loop and holds the guardrails. This file holds the settings and their
// checks, what records and summaries carry, and the pure decisions the agent host makes; the host
// does the rest.

import { isAgentId, START_MODE_CHARS, type AgentId } from './agents'
import type { RiskLevel } from './risk'

/** The harnesses whose sessions manager mode can hold to reading, so can be managers. */
export const MANAGER_HARNESSES = [
  'claude-code',
  'codex',
  'deepseek',
  'antigravity',
  'fake-agent',
] as const

export function canManage(agentId: AgentId): boolean {
  const harness = agentId.split('~')[0]!
  return (MANAGER_HARNESSES as readonly string[]).includes(harness)
}

// The roster.

/** 写代码 · 审阅 · 规划调研 · 杂活. */
export const WORKER_ROLES = ['implement', 'review', 'plan', 'other'] as const
export type WorkerRole = (typeof WORKER_ROLES)[number]

export function isWorkerRole(value: unknown): value is WorkerRole {
  return typeof value === 'string' && (WORKER_ROLES as readonly string[]).includes(value)
}

/** Whether a role's worker changes files; reviewers and planners only read. */
export function writes(role: WorkerRole): boolean {
  return role === 'implement' || role === 'other'
}

/**
 * Who answers the workers' permission requests: only the user, or also the manager's agent for
 * the requests Kite rates low.
 */
export const MANAGER_APPROVALS = ['user', 'low'] as const
export type ManagerApprovals = (typeof MANAGER_APPROVALS)[number]

export function isManagerApprovals(value: unknown): value is ManagerApprovals {
  return typeof value === 'string' && (MANAGER_APPROVALS as readonly string[]).includes(value)
}

/** What a restart does to a worker whose turn it cut: go on by itself, or only tell the manager. */
export const AFTER_RESTART = ['resume', 'tell'] as const
export type AfterRestart = (typeof AFTER_RESTART)[number]

export const ROSTER_MAX = 12
export const WORKER_NAME_CHARS = 20
export const PERSONA_CHARS = 4000
export const WORKER_MODEL_CHARS = 200
export const WORKER_EFFORT_CHARS = 64
export const WORKER_PROFILE_CHARS = 64
const WORKER_ID = /^w-[0-9a-f]{8}$/

export interface RosterWorker {
  /** Stable across renames: 'w-' and 8 hex digits. */
  id: string
  /** What the manager dispatches by: 1 to 20 characters, unique ignoring case. */
  name: string
  role: WorkerRole
  agentId: AgentId
  /** The agent's model option value; null for the agent's default. */
  model: string | null
  /** The agent's thought level option value; null for its default. */
  effort: string | null
  /** A provider profile of the agent, for an agent that takes one; null for its own sign-in. */
  profileId: string | null
  /** The mode it starts in, held to the started ceiling; null for its role's default. */
  mode: string | null
  /** A writer whose every dispatch gets a new worktree, so it can work beside other writers. */
  worktree: boolean
  /** Goes only into the worker session's first message, never into the agent's own files. */
  persona: string
}

export interface ManagerLimits {
  /** Workers working at once. */
  concurrent: number
  /** Worker turns since the user last wrote to the manager. */
  turnsPerTask: number
  /** Review rounds of one change before the user is asked. */
  reviewRounds: number
  /** Tokens of the manager and its workers per task; null for no budget. */
  tokenBudget: number | null
}

export const LIMIT_RANGES = {
  concurrent: { min: 1, max: 6 },
  turnsPerTask: { min: 5, max: 200 },
  reviewRounds: { min: 1, max: 10 },
  tokenBudget: { min: 10_000, max: 100_000_000 },
} as const

export const DEFAULT_MANAGER_LIMITS: ManagerLimits = {
  concurrent: 3,
  turnsPerTask: 30,
  reviewRounds: 3,
  tokenBudget: null,
}

/** The manager agent a new manager session suggests. */
export interface ManagerSuggestion {
  agentId: AgentId
  model: string | null
  profileId: string | null
}

export interface ManagerSettings {
  workers: RosterWorker[]
  /** A worker whose role is review; null for none, which leaves the review loop off. */
  reviewerId: string | null
  suggestion: ManagerSuggestion | null
  /** The review loop for new manager sessions. */
  autoReview: boolean
  /** Who answers workers' requests in new manager sessions. */
  approvals: ManagerApprovals
  limits: ManagerLimits
  afterRestart: AfterRestart
}

export const DEFAULT_MANAGER_SETTINGS: ManagerSettings = {
  workers: [],
  reviewerId: null,
  suggestion: null,
  autoReview: true,
  approvals: 'user',
  limits: DEFAULT_MANAGER_LIMITS,
  afterRestart: 'resume',
}

/**
 * A project's own choice, kept in its record: the roster with its reviewer replaces the settings'
 * as a pair; each other field present replaces the settings' one.
 */
export interface ProjectManagerSettings {
  workers: RosterWorker[]
  reviewerId: string | null
  autoReview?: boolean
  approvals?: ManagerApprovals
  limits?: ManagerLimits
}

/** The settings a project's sessions use: its own fields over the settings'. */
export function effectiveManager(
  settings: ManagerSettings,
  project: ProjectManagerSettings | null | undefined,
): ManagerSettings {
  if (!project) return settings
  return {
    ...settings,
    workers: project.workers,
    reviewerId: project.reviewerId,
    ...(project.autoReview === undefined ? {} : { autoReview: project.autoReview }),
    ...(project.approvals === undefined ? {} : { approvals: project.approvals }),
    ...(project.limits === undefined ? {} : { limits: project.limits }),
  }
}

/** The roster entry a manager names, ignoring case and surrounding spaces. */
export function findWorker(
  workers: readonly RosterWorker[],
  name: string,
): RosterWorker | undefined {
  const key = nameKey(name)
  return workers.find((worker) => nameKey(worker.name) === key)
}

const nameKey = (name: string): string => name.trim().toLocaleLowerCase()

// Checks. `check*` refuses a value from a client with the first problem; `read*` keeps what is
// valid of a stored value and reports the rest.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isWholeIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

// Control characters and line breaks never belong in a name.
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u

function optionalText(value: unknown, max: number): boolean {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= max)
}

/** Why a roster entry is not valid, or null. */
export function workerProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'must be an object'
  const keys: (keyof RosterWorker)[] = [
    'id',
    'name',
    'role',
    'agentId',
    'model',
    'effort',
    'profileId',
    'mode',
    'worktree',
    'persona',
  ]
  const extra = Object.keys(value).find((key) => !(keys as string[]).includes(key))
  if (extra !== undefined) return `has an unknown field "${extra}"`
  if (typeof value.id !== 'string' || !WORKER_ID.test(value.id))
    return 'needs an id like w-0a1b2c3d'
  const name = value.name
  if (
    typeof name !== 'string' ||
    name.trim() === '' ||
    name !== name.trim() ||
    [...name].length > WORKER_NAME_CHARS ||
    CONTROL.test(name)
  ) {
    return `needs a name of 1 to ${WORKER_NAME_CHARS} characters`
  }
  if (!isWorkerRole(value.role)) return `role must be one of ${WORKER_ROLES.join(', ')}`
  if (!isAgentId(value.agentId)) return 'agentId must be an agent id'
  if (!optionalText(value.model, WORKER_MODEL_CHARS)) return 'model must be a model id or null'
  if (!optionalText(value.effort, WORKER_EFFORT_CHARS)) return 'effort must be a level or null'
  if (!optionalText(value.profileId, WORKER_PROFILE_CHARS)) {
    return 'profileId must be a profile id or null'
  }
  if (!optionalText(value.mode, START_MODE_CHARS)) return 'mode must be a mode id or null'
  if (typeof value.worktree !== 'boolean') return 'worktree must be true or false'
  if (value.worktree && !writes(value.role)) return 'only a writing role can have worktrees'
  if (typeof value.persona !== 'string' || value.persona.length > PERSONA_CHARS) {
    return `persona must be text of at most ${PERSONA_CHARS} characters`
  }
  return null
}

function limitsProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'must be an object'
  const extra = Object.keys(value).find((key) => !Object.hasOwn(LIMIT_RANGES, key))
  if (extra !== undefined) return `has an unknown field "${extra}"`
  for (const key of ['concurrent', 'turnsPerTask', 'reviewRounds'] as const) {
    const { min, max } = LIMIT_RANGES[key]
    if (!isWholeIn(value[key], min, max))
      return `${key} must be a whole number from ${min} to ${max}`
  }
  const { min, max } = LIMIT_RANGES.tokenBudget
  if (value.tokenBudget !== null && !isWholeIn(value.tokenBudget, min, max)) {
    return `tokenBudget must be null or a whole number from ${min} to ${max}`
  }
  return null
}

function suggestionProblem(value: unknown): string | null {
  if (value === null) return null
  if (!isRecord(value)) return 'must be an object or null'
  const extra = Object.keys(value).find((key) => !['agentId', 'model', 'profileId'].includes(key))
  if (extra !== undefined) return `has an unknown field "${extra}"`
  if (!isAgentId(value.agentId)) return 'agentId must be an agent id'
  if (!optionalText(value.model, WORKER_MODEL_CHARS)) return 'model must be a model id or null'
  if (!optionalText(value.profileId, WORKER_PROFILE_CHARS)) {
    return 'profileId must be a profile id or null'
  }
  return null
}

/** Why a roster with its reviewer is not valid, or null: entries, unique names and ids, reviewer. */
export function rosterProblem(workers: unknown, reviewerId: unknown): string | null {
  if (!Array.isArray(workers)) return 'workers must be an array'
  if (workers.length > ROSTER_MAX) return `workers holds at most ${ROSTER_MAX} entries`
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const [index, worker] of workers.entries()) {
    const problem = workerProblem(worker)
    if (problem) return `workers[${index}] ${problem}`
    const entry = worker as RosterWorker
    if (names.has(nameKey(entry.name))) return `workers[${index}] repeats the name "${entry.name}"`
    if (ids.has(entry.id)) return `workers[${index}] repeats the id ${entry.id}`
    names.add(nameKey(entry.name))
    ids.add(entry.id)
  }
  if (reviewerId !== null) {
    const reviewer = (workers as RosterWorker[]).find((worker) => worker.id === reviewerId)
    if (!reviewer) return 'reviewerId must name a worker of the roster or be null'
    if (reviewer.role !== 'review') return 'the default reviewer must have the review role'
  }
  return null
}

/** Why settings from a client are not valid, or null. */
export function managerSettingsProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'must be an object'
  const keys = Object.keys(DEFAULT_MANAGER_SETTINGS)
  const extra = Object.keys(value).find((key) => !keys.includes(key))
  if (extra !== undefined) return `has an unknown field "${extra}"`
  const missing = keys.find((key) => !Object.hasOwn(value, key))
  if (missing !== undefined) return `needs "${missing}"`
  const roster = rosterProblem(value.workers, value.reviewerId)
  if (roster) return roster
  const suggestion = suggestionProblem(value.suggestion)
  if (suggestion) return `suggestion ${suggestion}`
  if (typeof value.autoReview !== 'boolean') return 'autoReview must be true or false'
  if (!isManagerApprovals(value.approvals)) {
    return `approvals must be one of ${MANAGER_APPROVALS.join(', ')}`
  }
  const limits = limitsProblem(value.limits)
  if (limits) return `limits ${limits}`
  if (!(AFTER_RESTART as readonly unknown[]).includes(value.afterRestart)) {
    return `afterRestart must be one of ${AFTER_RESTART.join(', ')}`
  }
  return null
}

/** Why a project's own settings are not valid, or null. */
export function projectManagerProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'must be an object'
  const allowed = ['workers', 'reviewerId', 'autoReview', 'approvals', 'limits']
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra !== undefined) return `has an unknown field "${extra}"`
  if (!Object.hasOwn(value, 'workers') || !Object.hasOwn(value, 'reviewerId')) {
    return 'needs "workers" and "reviewerId"'
  }
  const roster = rosterProblem(value.workers, value.reviewerId)
  if (roster) return roster
  if (value.autoReview !== undefined && typeof value.autoReview !== 'boolean') {
    return 'autoReview must be true or false'
  }
  if (value.approvals !== undefined && !isManagerApprovals(value.approvals)) {
    return `approvals must be one of ${MANAGER_APPROVALS.join(', ')}`
  }
  if (value.limits !== undefined) {
    const limits = limitsProblem(value.limits)
    if (limits) return `limits ${limits}`
  }
  return null
}

/** The valid entries of a stored roster: a bad or repeated entry is dropped with its problem. */
function readWorkers(raw: unknown, problems: string[], path: string): RosterWorker[] {
  if (!Array.isArray(raw)) {
    problems.push(`"${path}" must be an array`)
    return []
  }
  const out: RosterWorker[] = []
  for (const [index, worker] of raw.entries()) {
    if (out.length >= ROSTER_MAX) {
      problems.push(`"${path}" holds at most ${ROSTER_MAX} entries; the rest were dropped`)
      break
    }
    const problem = workerProblem(worker)
    const entry = worker as RosterWorker
    if (problem) problems.push(`"${path}[${index}]" ${problem}`)
    else if (
      out.some((kept) => kept.id === entry.id || nameKey(kept.name) === nameKey(entry.name))
    ) {
      problems.push(`"${path}[${index}]" repeats an id or a name`)
    } else out.push({ ...entry })
  }
  return out
}

function readReviewer(raw: unknown, workers: readonly RosterWorker[]): string | null {
  const reviewer = workers.find((worker) => worker.id === raw)
  return reviewer?.role === 'review' ? reviewer.id : null
}

function readLimits(raw: unknown, problems: string[], path: string): ManagerLimits {
  const problem = limitsProblem(raw)
  if (!problem) return { ...(raw as unknown as ManagerLimits) }
  problems.push(`"${path}" ${problem}`)
  return { ...DEFAULT_MANAGER_LIMITS }
}

/** The stored settings, each valid part kept and the rest at its default. */
export function readManagerSettings(raw: unknown, problems: string[]): ManagerSettings {
  const settings = structuredClone(DEFAULT_MANAGER_SETTINGS)
  if (!isRecord(raw)) {
    problems.push('"manager" must be an object')
    return settings
  }
  if (raw.workers !== undefined)
    settings.workers = readWorkers(raw.workers, problems, 'manager.workers')
  settings.reviewerId = readReviewer(raw.reviewerId, settings.workers)
  if (raw.suggestion !== undefined) {
    const problem = suggestionProblem(raw.suggestion)
    if (problem) problems.push(`"manager.suggestion" ${problem}`)
    else
      settings.suggestion =
        raw.suggestion === null ? null : { ...(raw.suggestion as ManagerSuggestion) }
  }
  if (typeof raw.autoReview === 'boolean') settings.autoReview = raw.autoReview
  if (isManagerApprovals(raw.approvals)) settings.approvals = raw.approvals
  if (raw.limits !== undefined) settings.limits = readLimits(raw.limits, problems, 'manager.limits')
  if ((AFTER_RESTART as readonly unknown[]).includes(raw.afterRestart)) {
    settings.afterRestart = raw.afterRestart as AfterRestart
  }
  return settings
}

/** A project's stored choice, its valid parts kept; null when it has none worth keeping. */
export function readProjectManager(raw: unknown): ProjectManagerSettings | null {
  if (!isRecord(raw)) return null
  const problems: string[] = []
  const workers = readWorkers(raw.workers, problems, 'manager.workers')
  const out: ProjectManagerSettings = { workers, reviewerId: readReviewer(raw.reviewerId, workers) }
  if (typeof raw.autoReview === 'boolean') out.autoReview = raw.autoReview
  if (isManagerApprovals(raw.approvals)) out.approvals = raw.approvals
  if (raw.limits !== undefined && limitsProblem(raw.limits) === null) {
    out.limits = { ...(raw.limits as unknown as ManagerLimits) }
  }
  return out
}

/** A new roster entry's id from 4 random bytes. */
export function workerId(bytes: Uint8Array): string {
  return `w-${[...bytes.slice(0, 4)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

// A manager session's own choices, made when it starts and changed between turns.

export interface ManagerChoices {
  autoReview: boolean
  approvals: ManagerApprovals
}

export function isManagerChoices(value: unknown): value is ManagerChoices {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === 'autoReview' || key === 'approvals') &&
    typeof value.autoReview === 'boolean' &&
    isManagerApprovals(value.approvals)
  )
}

// What a session record keeps.

export const REPORT_STATUSES = [
  'done',
  'blocked',
  'failed',
  'needs_user',
  'stopped',
  'interrupted',
] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

/** What report_work may say; the others Kite writes itself. */
export const TOOL_REPORT_STATUSES = ['done', 'blocked', 'failed', 'needs_user'] as const

export const VERDICTS = ['approve', 'changes'] as const
export type Verdict = (typeof VERDICTS)[number]

export const FINDING_LEVELS = ['must', 'should', 'nit'] as const
export type FindingLevel = (typeof FINDING_LEVELS)[number]

export const SUMMARY_CHARS = 1500
export const DIGEST_SUMMARY_CHARS = 600
export const CHANGED_MAX = 50
export const FINDINGS_MAX = 20
export const FINDING_CHARS = 300
export const QUESTION_CHARS = 500
export const PATH_CHARS = 1024
export const INTERJECTION_CHARS = 500
export const INTERJECTIONS_MAX = 3
export const HELD_MAX = 5
export const LOOPS_KEPT = 20
export const TASK_CHARS = 20_000
export const TITLE_CHARS = 120
export const ACCEPTANCE_MAX = 10
export const ACCEPTANCE_CHARS = 300
export const FILES_MAX = 30
export const REQUEST_ID_CHARS = 64
/** A worker is resumed after a restart at most once in this long; later restarts tell the manager. */
export const RESUME_SPACING_MS = 10 * 60_000

export interface Finding {
  level: FindingLevel
  file?: string
  line?: number
  text: string
}

export interface ChangedFile {
  path: string
  added: number | null
  removed: number | null
}

export interface WorkerReport {
  at: number
  status: ReportStatus
  /** From report_work, or Kite's reading of the last reply. */
  by: 'tool' | 'derived'
  summary: string
  changed: ChangedFile[]
  verdict?: Verdict
  findings?: Finding[]
  question?: string
}

/** A start Kite holds until a slot or the folder is free. */
export interface HeldStart {
  id: string
  workerId: string
  name: string
  title: string
  kind: WorkerRole
  /** The first message as Kite wrote it. */
  prompt: string
  requestId?: string
  at: number
}

export const LOOP_STATES = [
  'reviewing',
  'fixing',
  'approved',
  'out_of_rounds',
  'failed',
  'stopped',
] as const
export type LoopState = (typeof LOOP_STATES)[number]

export interface ReviewLoop {
  id: string
  implementerId: string
  reviewerId: string | null
  round: number
  state: LoopState
  startedAt: number
  endedAt?: number
}

/** What a request the manager's agent answered for a worker was, which the pane lists. */
export interface ManagerAnswer {
  at: number
  workerId: string
  name: string
  /** What the request asked, as its card says it. */
  what: string
  allowed: boolean
}

export const ANSWERS_KEPT = 20

export interface ManagerTask {
  /** When the user last wrote to the manager, which starts a task. */
  since: number
  turns: number
  /** Turns the user gave on top of the limit. */
  extraTurns: number
  tokens: number
  /** USD, for the turns whose model has a price. */
  cost: number
  /** Turns whose model has no price. */
  unpriced: number
  wakes: number
}

export interface StoredManager {
  autoReview: boolean
  approvals: ManagerApprovals
  task: ManagerTask
  paused?: true
  stoppedAt?: number
  /** The agent's own session and the block's hash that has the current block. */
  sentTo?: string
  held: HeldStart[]
  loops: ReviewLoop[]
  answers: ManagerAnswer[]
  /** The queue item of the digest not sent yet, which later reports merge into. */
  digest?: string
}

export interface StoredWorker {
  managerId: string
  workerId: string
  /** Copied at dispatch, so a later roster edit does not rewrite what happened. */
  name: string
  role: WorkerRole
  kind: WorkerRole
  title: string
  /** What done means, as the manager wrote it, for the review. */
  acceptance?: string[]
  /** The commit an implementation started from, in a Git folder. */
  base?: string
  /** A turn started that the manager is owed a report for, and when. */
  owed?: number
  /** When a restart last resumed it. */
  resumedAt?: number
  interjected?: string[]
  /** When the user took it over. */
  detached?: number
  report?: WorkerReport
  /** The worker's tokens and USD so far. */
  tokens: number
  cost: number
  /** The agent's own session and block hash that has its persona. */
  sentTo?: string
  requestId?: string
}

export function newTask(now: number): ManagerTask {
  return { since: now, turns: 0, extraTurns: 0, tokens: 0, cost: 0, unpriced: 0, wakes: 0 }
}

export function newManager(choices: ManagerChoices, now: number): StoredManager {
  return { ...choices, task: newTask(now), held: [], loops: [], answers: [] }
}

const isWhole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max

function readTask(raw: unknown, now: number): ManagerTask {
  if (!isRecord(raw)) return newTask(now)
  return {
    since: isWhole(raw.since) ? raw.since : now,
    turns: isWhole(raw.turns) ? raw.turns : 0,
    extraTurns: isWhole(raw.extraTurns) ? raw.extraTurns : 0,
    tokens: isWhole(raw.tokens) ? raw.tokens : 0,
    cost: isAmount(raw.cost) ? raw.cost : 0,
    unpriced: isWhole(raw.unpriced) ? raw.unpriced : 0,
    wakes: isWhole(raw.wakes) ? raw.wakes : 0,
  }
}

function readHeld(raw: unknown): HeldStart | null {
  if (!isRecord(raw)) return null
  if (
    !isText(raw.id, 64) ||
    !isText(raw.workerId, 16) ||
    !isText(raw.name, WORKER_NAME_CHARS) ||
    !isText(raw.title, TITLE_CHARS) ||
    !isWorkerRole(raw.kind) ||
    !isText(raw.prompt, TASK_CHARS * 2) ||
    !isWhole(raw.at)
  ) {
    return null
  }
  return {
    id: raw.id,
    workerId: raw.workerId,
    name: raw.name,
    title: raw.title,
    kind: raw.kind,
    prompt: raw.prompt,
    at: raw.at,
    ...(isText(raw.requestId, REQUEST_ID_CHARS) ? { requestId: raw.requestId } : {}),
  }
}

function readLoop(raw: unknown): ReviewLoop | null {
  if (!isRecord(raw)) return null
  if (
    !isText(raw.id, 64) ||
    !isText(raw.implementerId, 200) ||
    !(raw.reviewerId === null || isText(raw.reviewerId, 200)) ||
    !isWhole(raw.round) ||
    !(LOOP_STATES as readonly unknown[]).includes(raw.state) ||
    !isWhole(raw.startedAt)
  ) {
    return null
  }
  return {
    id: raw.id,
    implementerId: raw.implementerId,
    reviewerId: raw.reviewerId,
    round: raw.round,
    state: raw.state as LoopState,
    startedAt: raw.startedAt,
    ...(isWhole(raw.endedAt) ? { endedAt: raw.endedAt } : {}),
  }
}

function readAnswer(raw: unknown): ManagerAnswer | null {
  if (!isRecord(raw)) return null
  if (
    !isWhole(raw.at) ||
    !isText(raw.workerId, 200) ||
    !isText(raw.name, WORKER_NAME_CHARS) ||
    !isText(raw.what, 300) ||
    typeof raw.allowed !== 'boolean'
  ) {
    return null
  }
  return {
    at: raw.at,
    workerId: raw.workerId,
    name: raw.name,
    what: raw.what,
    allowed: raw.allowed,
  }
}

function listOf<T>(raw: unknown, read: (item: unknown) => T | null, max: number): T[] {
  if (!Array.isArray(raw)) return []
  const out: T[] = []
  for (const item of raw) {
    const value = read(item)
    if (value !== null) out.push(value)
  }
  return out.slice(-max)
}

/** A stored manager field, its valid parts kept; null for one that is not a manager's at all. */
export function readStoredManager(raw: unknown, now: number): StoredManager | null {
  if (!isRecord(raw) || typeof raw.autoReview !== 'boolean') return null
  return {
    autoReview: raw.autoReview,
    approvals: isManagerApprovals(raw.approvals) ? raw.approvals : 'user',
    task: readTask(raw.task, now),
    ...(raw.paused === true ? { paused: true as const } : {}),
    ...(isWhole(raw.stoppedAt) ? { stoppedAt: raw.stoppedAt } : {}),
    ...(isText(raw.sentTo, 400) ? { sentTo: raw.sentTo } : {}),
    held: listOf(raw.held, readHeld, HELD_MAX),
    loops: listOf(raw.loops, readLoop, LOOPS_KEPT),
    answers: listOf(raw.answers, readAnswer, ANSWERS_KEPT),
    ...(isText(raw.digest, 64) ? { digest: raw.digest } : {}),
  }
}

function readFinding(raw: unknown): Finding | null {
  if (!isRecord(raw)) return null
  if (!(FINDING_LEVELS as readonly unknown[]).includes(raw.level)) return null
  if (typeof raw.text !== 'string' || raw.text.length === 0 || raw.text.length > FINDING_CHARS) {
    return null
  }
  return {
    level: raw.level as FindingLevel,
    text: raw.text,
    ...(isText(raw.file, PATH_CHARS) && raw.file !== '' ? { file: raw.file } : {}),
    ...(isWhole(raw.line) && raw.line > 0 ? { line: raw.line } : {}),
  }
}

function readChanged(raw: unknown): ChangedFile | null {
  if (!isRecord(raw) || !isText(raw.path, PATH_CHARS) || raw.path === '') return null
  return {
    path: raw.path,
    added: isWhole(raw.added) ? raw.added : null,
    removed: isWhole(raw.removed) ? raw.removed : null,
  }
}

export function readReport(raw: unknown): WorkerReport | null {
  if (!isRecord(raw)) return null
  if (
    !isWhole(raw.at) ||
    !(REPORT_STATUSES as readonly unknown[]).includes(raw.status) ||
    (raw.by !== 'tool' && raw.by !== 'derived') ||
    !isText(raw.summary, SUMMARY_CHARS)
  ) {
    return null
  }
  return {
    at: raw.at,
    status: raw.status as ReportStatus,
    by: raw.by,
    summary: raw.summary,
    changed: listOf(raw.changed, readChanged, CHANGED_MAX),
    ...((VERDICTS as readonly unknown[]).includes(raw.verdict)
      ? { verdict: raw.verdict as Verdict }
      : {}),
    ...(Array.isArray(raw.findings)
      ? { findings: listOf(raw.findings, readFinding, FINDINGS_MAX) }
      : {}),
    ...(isText(raw.question, QUESTION_CHARS) && raw.question !== ''
      ? { question: raw.question }
      : {}),
  }
}

/** A stored worker field, its valid parts kept; null for one that is not a worker's. */
export function readStoredWorker(raw: unknown): StoredWorker | null {
  if (!isRecord(raw)) return null
  if (
    !isText(raw.managerId, 200) ||
    raw.managerId === '' ||
    !isText(raw.workerId, 16) ||
    !isText(raw.name, WORKER_NAME_CHARS) ||
    !isWorkerRole(raw.role) ||
    !isWorkerRole(raw.kind) ||
    !isText(raw.title, TITLE_CHARS)
  ) {
    return null
  }
  const report = readReport(raw.report)
  const interjected = Array.isArray(raw.interjected)
    ? raw.interjected
        .filter((text): text is string => isText(text, INTERJECTION_CHARS))
        .slice(-INTERJECTIONS_MAX)
    : []
  const acceptance = Array.isArray(raw.acceptance)
    ? raw.acceptance
        .filter((line): line is string => isText(line, ACCEPTANCE_CHARS) && line !== '')
        .slice(0, ACCEPTANCE_MAX)
    : []
  return {
    managerId: raw.managerId,
    workerId: raw.workerId,
    name: raw.name,
    role: raw.role,
    kind: raw.kind,
    title: raw.title,
    tokens: isWhole(raw.tokens) ? raw.tokens : 0,
    cost: isAmount(raw.cost) ? raw.cost : 0,
    ...(acceptance.length > 0 ? { acceptance } : {}),
    ...(isText(raw.base, 64) && raw.base !== '' ? { base: raw.base } : {}),
    ...(isWhole(raw.owed) ? { owed: raw.owed } : {}),
    ...(isWhole(raw.resumedAt) ? { resumedAt: raw.resumedAt } : {}),
    ...(interjected.length > 0 ? { interjected } : {}),
    ...(isWhole(raw.detached) ? { detached: raw.detached } : {}),
    ...(report ? { report } : {}),
    ...(isText(raw.sentTo, 400) ? { sentTo: raw.sentTo } : {}),
    ...(isText(raw.requestId, REQUEST_ID_CHARS) ? { requestId: raw.requestId } : {}),
  }
}

// What summaries carry, so every client draws the tree without asking.

export interface ManagerSummary {
  autoReview: boolean
  approvals: ManagerApprovals
  paused: boolean
  stopped: boolean
  /** Attached workers working now. */
  working: number
  /** Permission requests its attached workers wait on. */
  waiting: number
  held: number
  turns: number
  maxTurns: number
  tokens: number
  budget: number | null
  /** USD for the priced turns; `unpriced` turns had no price. */
  cost: number
  unpriced: number
  /** A digest waits in its queue for its turn. */
  pending: boolean
  /** The latest requests its agent answered for its workers, newest last. */
  answers: ManagerAnswer[]
}

export interface WorkerSummary {
  managerId: string
  workerId: string
  name: string
  role: WorkerRole
  kind: WorkerRole
  /** Its review loop's round and state while it has one. */
  round: number | null
  loop: LoopState | null
  /** The latest report's status and first line. */
  status: ReportStatus | null
  line: string | null
  detached: boolean
  tokens: number
  cost: number
  /** For a reviewer the review loop started: the implementer it reviews. */
  reviewOf: string | null
  /** The task's title as the manager gave it. */
  title: string
}

// The decisions.

/** What a manager's dispatch or send needs to know about the state of things. */
export interface DispatchState {
  paused: boolean
  stopped: boolean
  task: Pick<ManagerTask, 'turns' | 'extraTurns' | 'tokens'>
  limits: ManagerLimits
  /** Attached workers working now: their folder (compared as given) and whether they write. */
  working: readonly { id: string; folder: string; writes: boolean }[]
  /** Folders a writer holds while its review loop goes on, though it waits between rounds. */
  reserved?: readonly { id: string; folder: string }[]
  held: number
}

export interface DispatchRequest {
  writes: boolean
  folder: string
  /** It gets a new worktree, so it shares no folder. */
  ownWorktree: boolean
  /** The worker it goes to, which a send names; it is no other worker. */
  workerId?: string
}

export type DispatchRefusal = 'stopped' | 'paused' | 'turns' | 'tokens' | 'held'
export type HoldReason = 'slots' | 'folder'

export type DispatchDecision =
  | { kind: 'start' }
  | { kind: 'hold'; reason: HoldReason }
  | { kind: 'refuse'; code: DispatchRefusal }

/** Whether the task's budget is spent: its worker turns or its tokens. */
export function budgetSpent(
  task: Pick<ManagerTask, 'turns' | 'extraTurns' | 'tokens'>,
  limits: ManagerLimits,
): 'turns' | 'tokens' | null {
  if (task.turns >= limits.turnsPerTask + task.extraTurns) return 'turns'
  if (limits.tokenBudget !== null && task.tokens >= limits.tokenBudget) return 'tokens'
  return null
}

/**
 * Whether a new worker starts now, waits for a slot or its folder, or is refused: stopped and
 * paused first, then the budget, then the slots and the one writer per folder, then the queue.
 */
export function canDispatch(state: DispatchState, request: DispatchRequest): DispatchDecision {
  if (state.stopped) return { kind: 'refuse', code: 'stopped' }
  if (state.paused) return { kind: 'refuse', code: 'paused' }
  const spent = budgetSpent(state.task, state.limits)
  if (spent) return { kind: 'refuse', code: spent }
  const hold = holdReason(state, request)
  if (hold === null) return { kind: 'start' }
  if (state.held >= HELD_MAX) return { kind: 'refuse', code: 'held' }
  return { kind: 'hold', reason: hold }
}

/** What keeps a turn from starting now, if anything: no free slot, or another writer's folder. */
export function holdReason(state: DispatchState, request: DispatchRequest): HoldReason | null {
  const others = state.working.filter((item) => item.id !== request.workerId)
  if (others.length >= state.limits.concurrent) return 'slots'
  const reserved = (state.reserved ?? []).filter((item) => item.id !== request.workerId)
  if (
    request.writes &&
    !request.ownWorktree &&
    (others.some((item) => item.writes && item.folder === request.folder) ||
      reserved.some((item) => item.folder === request.folder))
  ) {
    return 'folder'
  }
  return null
}

/**
 * Whether a message may start another turn in a worker that exists: the same checks as a dispatch,
 * except that nothing is held; a worker already working takes it into its queue.
 */
export function canSend(
  state: DispatchState,
  request: DispatchRequest & { workerId: string; working: boolean },
): { kind: 'send' } | { kind: 'refuse'; code: DispatchRefusal | HoldReason } {
  if (state.stopped) return { kind: 'refuse', code: 'stopped' }
  if (state.paused) return { kind: 'refuse', code: 'paused' }
  const spent = budgetSpent(state.task, state.limits)
  if (spent) return { kind: 'refuse', code: spent }
  if (request.working) return { kind: 'send' }
  const hold = holdReason(state, request)
  return hold === null ? { kind: 'send' } : { kind: 'refuse', code: hold }
}

/** Whether a worker has settled: nothing runs or waits in it, and nothing it holds will go on. */
export function isSettled(state: {
  turn: boolean
  waiting: number
  queued: number
  queuePaused: boolean
  limitPaused: boolean
}): boolean {
  return (
    !state.turn &&
    state.waiting === 0 &&
    (state.queued === 0 || state.queuePaused) &&
    !state.limitPaused
  )
}

/** How a settled worker's turn ended, for the review loop. */
export interface LoopEvent {
  who: 'implementer' | 'reviewer'
  status: ReportStatus
  verdict: Verdict | null
}

export interface LoopContext {
  /** The session's review loop is on and the task is a writing one. */
  enabled: boolean
  /** A reviewer can be started or continued. */
  reviewer: boolean
  rounds: number
  /** The budget has room for another turn. */
  budget: boolean
  paused: boolean
  stopped: boolean
  /** The implementer was taken over by the user. */
  detached: boolean
}

export type LoopAction =
  | { kind: 'none' }
  | { kind: 'review'; round: number }
  | { kind: 'fix'; round: number }
  | { kind: 'wait' }
  | { kind: 'finish'; state: 'approved' | 'out_of_rounds' | 'failed' | 'stopped' }

/**
 * The review loop's next step after a settle. Without a loop, a finished implementation starts
 * one at round 1; a loop goes reviewing → (approve: done | changes: fixing, round + 1 | at the
 * last round: out of rounds) and fixing → reviewing. Paused waits; stopped, out of budget or
 * taken over ends it.
 */
export function reviewNext(
  loop: Pick<ReviewLoop, 'round' | 'state'> | null,
  event: LoopEvent,
  ctx: LoopContext,
): LoopAction {
  if (loop === null) {
    if (!ctx.enabled || !ctx.reviewer || event.who !== 'implementer') return { kind: 'none' }
    if (event.status !== 'done' || ctx.stopped || ctx.detached) return { kind: 'none' }
    if (ctx.paused) return { kind: 'wait' }
    if (!ctx.budget) return { kind: 'none' }
    return { kind: 'review', round: 1 }
  }
  if (loop.state !== 'reviewing' && loop.state !== 'fixing') return { kind: 'none' }
  if (ctx.stopped || ctx.detached) return { kind: 'finish', state: 'stopped' }
  if (event.status !== 'done') return { kind: 'finish', state: 'failed' }
  if (loop.state === 'fixing') {
    if (event.who !== 'implementer') return { kind: 'none' }
    if (ctx.paused) return { kind: 'wait' }
    if (!ctx.budget) return { kind: 'finish', state: 'stopped' }
    return { kind: 'review', round: loop.round }
  }
  if (event.who !== 'reviewer') return { kind: 'none' }
  if (event.verdict === 'approve') return { kind: 'finish', state: 'approved' }
  if (event.verdict !== 'changes') return { kind: 'finish', state: 'failed' }
  if (loop.round >= ctx.rounds) return { kind: 'finish', state: 'out_of_rounds' }
  if (ctx.paused) return { kind: 'wait' }
  if (!ctx.budget) return { kind: 'finish', state: 'stopped' }
  return { kind: 'fix', round: loop.round + 1 }
}

/**
 * The risk reasons that only read, which the manager and read-only workers may run without
 * asking, and the ones that change things, which they are refused; the rest ask the user.
 */
const READ_REASONS: ReadonlySet<string> = new Set(['readProject', 'readCommand', 'projectCheck'])
const CHANGE_REASONS: ReadonlySet<string> = new Set([
  'editProject',
  'editConfig',
  'gitWrite',
  'delete',
  'writeOutside',
  'install',
  'globalInstall',
  'unsafe',
  'unparsed',
  'unknownCommand',
  'unknown',
  'gitDanger',
  'gitDir',
  'download',
  'projectScript',
])

/**
 * What Kite does with a read-only session's request: allow what only reads, refuse what changes
 * things, and ask the user about the rest. A request Kite cannot judge, such as a question, asks.
 */
export function readOnlyDecision(
  risk: { level: RiskLevel; reason: string } | null,
  toolKind: string | null,
): 'allow' | 'deny' | 'ask' {
  if (toolKind === 'edit' || toolKind === 'delete' || toolKind === 'move') return 'deny'
  if (!risk) return 'ask'
  if (READ_REASONS.has(risk.reason) && risk.level === 'low') return 'allow'
  if (CHANGE_REASONS.has(risk.reason)) return 'deny'
  return 'ask'
}

/** Whether the manager's agent may answer a worker's request: only a low one, when allowed. */
export function managerMayAnswer(approvals: ManagerApprovals, level: RiskLevel | null): boolean {
  return approvals === 'low' && level === 'low'
}

export interface RestartWorker {
  id: string
  managerId: string
  owed: boolean
  running: boolean
  detached: boolean
  resumedAt: number | null
}

export interface RestartManager {
  id: string
  stopped: boolean
  paused: boolean
  afterRestart: AfterRestart
  concurrent: number
}

/**
 * What the first pass after a restart does with each owed worker whose turn the restart cut:
 * resume it (at most `concurrent` per manager, at most once per spacing), hold it for a slot, or
 * tell the manager. A stopped or paused manager's workers are left alone.
 */
export function restartPlan(
  workers: readonly RestartWorker[],
  managers: readonly RestartManager[],
  now: number,
): { resume: string[]; hold: string[]; tell: string[] } {
  const out = { resume: [] as string[], hold: [] as string[], tell: [] as string[] }
  const byId = new Map(managers.map((manager) => [manager.id, manager]))
  const resumed = new Map<string, number>()
  for (const worker of workers) {
    if (!worker.owed || worker.running || worker.detached) continue
    const manager = byId.get(worker.managerId)
    if (!manager || manager.stopped || manager.paused) continue
    const recent = worker.resumedAt !== null && now - worker.resumedAt < RESUME_SPACING_MS
    if (manager.afterRestart === 'tell' || recent) {
      out.tell.push(worker.id)
      continue
    }
    const count = resumed.get(manager.id) ?? 0
    if (count >= manager.concurrent) {
      out.hold.push(worker.id)
      continue
    }
    resumed.set(manager.id, count + 1)
    out.resume.push(worker.id)
  }
  return out
}

// Digests: what wakes a manager, merged while it waits.

export const DIGEST_ITEMS_MAX = 12

export type DigestStatus =
  | ReportStatus
  | 'approved'
  | 'out_of_rounds'
  | 'review_failed'
  | 'limit_paused'
  | 'taken_over'
  | 'handed_back'
  | 'asks'

export interface DigestItem {
  sessionId: string
  name: string
  status: DigestStatus
  /** One line of what happened, at most 200 characters. */
  line: string
  round?: number
  /** What the user said to the worker since its last report. */
  said?: string[]
  /** A low request the manager may answer. */
  request?: { id: string; what: string }
}

export const DIGEST_LINE_CHARS = 200

/** Puts an item in a digest that may already hold that worker: the newest wins, in order. */
export function mergeDigest(items: readonly DigestItem[], item: DigestItem): DigestItem[] {
  const kept = items.filter((other) => other.sessionId !== item.sessionId)
  return [...kept, item].slice(-DIGEST_ITEMS_MAX)
}

export function isDigestItem(value: unknown): value is DigestItem {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.status === 'string' &&
    typeof value.line === 'string' &&
    (value.round === undefined || isWhole(value.round))
  )
}

/** Text cut to `max` characters at most, with an ellipsis when cut. */
export function cut(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** The first line of a text with content, cut to `max`. */
export function firstLine(text: string, max: number): string {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '')
  return cut(line ?? '', max)
}

/**
 * The verdict a reviewer's reply states when it did not call the tool: a line such as
 * `VERDICT: APPROVE` or `verdict: changes`, the last one winning.
 */
export function verdictIn(text: string): Verdict | null {
  let found: Verdict | null = null
  for (const match of text.matchAll(/\bverdict\s*[:：]\s*\**\s*(approve|changes)\b/gi)) {
    found = match[1]!.toLowerCase() as Verdict
  }
  return found
}

/** Adds a turn's tokens and cost to a total; a turn without a price is counted apart. */
export function addUsage<T extends { tokens: number; cost: number; unpriced?: number }>(
  total: T,
  tokens: number,
  cost: number | null,
): T {
  const next = { ...total, tokens: total.tokens + Math.max(0, Math.round(tokens)) }
  if (cost === null) {
    if (next.unpriced !== undefined) next.unpriced += 1
  } else next.cost = total.cost + Math.max(0, cost)
  return next
}
