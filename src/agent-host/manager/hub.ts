// Huli: manager mode's coordinator in the agent host. It keeps which workers belong to which
// manager, hears when their turns start and end, reports a worker to its manager once it settles
// (merging what settles while the manager waits into one digest), runs the review loop, holds the
// guardrails and answers the manager's tools. The session manager owns the sessions; it reaches
// them only through the port, so everything here follows events and nothing polls.

import { randomUUID } from 'node:crypto'
import {
  addUsage,
  ANSWERS_KEPT,
  budgetSpent,
  canDispatch,
  canSend,
  cut,
  findWorker,
  firstLine,
  HELD_MAX,
  isSettled,
  LOOPS_KEPT,
  managerMayAnswer,
  mergeDigest,
  newTask,
  restartPlan,
  reviewNext,
  SUMMARY_CHARS,
  verdictIn,
  writes,
  type ChangedFile,
  type DigestItem,
  type DigestStatus,
  type DispatchState,
  type Finding,
  type HeldStart,
  type LoopAction,
  type ManagerSettings,
  type ManagerSummary,
  type ReportStatus,
  type ReviewLoop,
  type RosterWorker,
  type StoredManager,
  type StoredWorker,
  type Verdict,
  type WorkerReport,
  type WorkerRole,
  type WorkerSummary,
} from '@shared/manager'
import type { RiskLevel } from '@shared/risk'
import type { AgentId, FromSession, SessionStatus, StopReason } from '@shared/thread'
import type { SessionRecord } from '../storage'
import {
  digestText,
  fixPrompt,
  managerBlock,
  reportReminder,
  resumePrompt,
  reviewPrompt,
  reviewReminder,
  taskPrompt,
  workerBlock,
  type DigestEntry,
} from './texts'

export type Lang = 'zh' | 'en'

/** A live session's state as the coordinator reads it; null for one not in memory. */
export interface PortState {
  status: SessionStatus
  turn: boolean
  waiting: number
  queued: number
  queuePaused: boolean
  limitPaused: boolean
  turnStartedAt: number | null
}

export interface PendingInfo {
  requestId: string
  what: string
  level: RiskLevel | null
}

export interface AgentInfo {
  name: string
  /** Whether a session can start with it now. */
  ready: boolean
  /** Why it cannot, for the manager. */
  reason: string | null
}

/** What a new worker session is made with. */
export interface WorkerSpec {
  entry: RosterWorker
  kind: WorkerRole
  title: string
  prompt: string
  worker: StoredWorker
  /** A new worktree of its own; else the manager's folder, or `shareWith`'s. */
  ownWorktree: boolean
  /** A session whose folder it works in, as a reviewer works in its implementer's. */
  shareWith?: string
  /** The mode a read-only role starts in. */
  readOnlyMode: string | null
}

export interface ManagerPort {
  now(): number
  lang(): Lang
  log(level: 'info' | 'warn', message: string): void
  /** The project's manager settings, its own over the settings'. */
  settings(projectPath: string): ManagerSettings
  record(id: string): SessionRecord | null
  records(): Iterable<SessionRecord>
  save(id: string): void
  touch(id: string): void
  state(id: string): PortState | null
  /** The folder the session works in, and its key for comparing folders. */
  folder(id: string): string
  folderKey(folder: string): string
  branch(id: string): string | null
  lastReply(id: string): Promise<string | null>
  /** The error the session's last failed turn showed. */
  lastError(id: string): string | null
  /** The files the session's last turn changed, by its tool calls. */
  turnFiles(id: string): string[]
  head(folder: string): Promise<string | null>
  numstat(folder: string, base: string): Promise<ChangedFile[] | null>
  agent(agentId: AgentId): AgentInfo
  /** "Codex · gpt-5.5", as a roster entry runs. */
  runs(entry: Pick<RosterWorker, 'agentId' | 'model'>): string
  /** The mode a read-only session of the agent starts in; null when the agent has none. */
  readOnlyMode(agentId: AgentId): string | null
  createWorker(managerId: string, spec: WorkerSpec): Promise<string>
  /** Sends a prompt as from the manager: at once when the session is free, else queued. */
  send(id: string, text: string, from: FromSession): Promise<void>
  /**
   * Puts the digest in the manager's queue, in place of `itemId` while that waits there; sends
   * it at once when the manager is free. Returns its queue item id, or null once sent, and
   * whether it merged into the one waiting.
   */
  deliver(
    managerId: string,
    itemId: string | null,
    text: string,
    from: FromSession,
  ): Promise<{ itemId: string | null; merged: boolean }>
  /** The digest items of the queue item still waiting, or null when it went. */
  waitingDigest(managerId: string, itemId: string): DigestItem[] | null
  cancel(id: string): Promise<void>
  pauseQueue(id: string): void
  resumeQueue(id: string): Promise<void>
  notice(id: string, severity: 'info' | 'warning', title: string, description?: string): void
  attention(id: string, title: string, body: string): void
  pending(id: string): PendingInfo[]
  /** Answers a worker's request once: allow once or deny once. False when it no longer waits. */
  respond(id: string, requestId: string, allow: boolean): boolean
  /** The request's risk as Kite judges it now. */
  assess(id: string, requestId: string): RiskLevel | null
  /** Text for the user, in their language. */
  text(key: string, params?: Record<string, string | number>): string
}

/** The refusals the tools turn into errors the agent reads. */
export class ManagerError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_allowed' | 'busy' | 'limit' | 'invalid',
    message: string,
  ) {
    super(message)
    this.name = 'ManagerError'
  }
}

export interface StartInput {
  worker: string
  task: string
  title?: string
  kind?: WorkerRole
  acceptance: string[]
  files: string[]
  requestId?: string
}

export interface ReportInput {
  status: 'done' | 'blocked' | 'failed' | 'needs_user'
  summary: string
  changed: string[]
  verdict?: Verdict
  findings: Finding[]
  question?: string
}

export type StartResult =
  | { kind: 'started'; id: string; existing: boolean }
  | { kind: 'held'; position: number; reason: 'slots' | 'folder' }

/** The most workers a manager starts in a local day, a backstop past the task budget. */
export const DAILY_WORKERS = 60

const WORKING: ReadonlySet<SessionStatus> = new Set(['starting', 'running', 'awaiting_permission'])

export class ManagerHub {
  /** Each manager's workers, by session id. */
  private readonly byManager = new Map<string, Set<string>>()
  /** How each worker's latest turn ended. */
  private readonly ends = new Map<string, StopReason | null>()
  /** Reviewers reminded once to give a verdict. */
  private readonly reminded = new Set<string>()
  /** Workers whose plan-limit pause the manager was told of. */
  private readonly limitTold = new Set<string>()
  /** Items that wait for the manager's next wake rather than waking it. */
  private readonly quiet = new Map<string, DigestItem[]>()
  /** Workers a restart cut that wait for a slot to go on. */
  private readonly resumeWaiting = new Map<string, string[]>()
  /** Managers told their wakes were spent this task. */
  private readonly wakesTold = new Set<string>()
  private readonly chains = new Map<string, Promise<unknown>>()
  /** What done means for a held dispatch, which its start takes. */
  private readonly heldAcceptance = new Map<string, string[]>()

  constructor(private readonly port: ManagerPort) {}

  // The index.

  /** Takes the records the host loaded. */
  load(): void {
    this.byManager.clear()
    for (const record of this.port.records()) this.added(record)
  }

  added(record: SessionRecord): void {
    const managerId = record.worker?.managerId
    if (!managerId) return
    let set = this.byManager.get(managerId)
    if (!set) this.byManager.set(managerId, (set = new Set()))
    set.add(record.id)
  }

  removed(id: string): void {
    this.byManager.delete(id)
    for (const set of this.byManager.values()) set.delete(id)
    this.ends.delete(id)
    this.reminded.delete(id)
    this.limitTold.delete(id)
  }

  workerIds(managerId: string): string[] {
    return [...(this.byManager.get(managerId) ?? [])]
  }

  private manager(id: string): StoredManager | null {
    return this.port.record(id)?.manager ?? null
  }

  private worker(id: string): StoredWorker | null {
    return this.port.record(id)?.worker ?? null
  }

  /** The worker, while its manager is one and the user has not taken it over. */
  private attached(id: string): { worker: StoredWorker; manager: StoredManager } | null {
    const worker = this.worker(id)
    if (!worker || worker.detached !== undefined) return null
    const manager = this.manager(worker.managerId)
    return manager ? { worker, manager } : null
  }

  private locked<T>(managerId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.chains.get(managerId) ?? Promise.resolve()
    const run = before.then(fn, fn)
    const settled = run.catch(() => {})
    this.chains.set(managerId, settled)
    void settled.then(() => {
      if (this.chains.get(managerId) === settled) this.chains.delete(managerId)
    })
    return run
  }

  private settingsOf(managerId: string): ManagerSettings {
    const record = this.port.record(managerId)
    return this.port.settings(record?.projectPath ?? '')
  }

  /** Whether the session is a manager or a worker, for the tools it lists. */
  roleOf(id: string): 'manager' | 'worker' | null {
    const record = this.port.record(id)
    if (record?.manager) return 'manager'
    if (record?.worker) return 'worker'
    return null
  }

  /** Whether the session reads only: the manager, or a reviewer's or planner's worker. */
  readOnly(id: string): 'manager' | 'worker' | null {
    const record = this.port.record(id)
    if (!record) return null
    if (record.manager) return 'manager'
    if (record.worker && !writes(record.worker.kind)) return 'worker'
    return null
  }

  // Summaries.

  managerSummary(record: SessionRecord): ManagerSummary | null {
    const manager = record.manager
    if (!manager) return null
    const limits = this.port.settings(record.projectPath).limits
    let working = 0
    let waiting = 0
    for (const id of this.workerIds(record.id)) {
      if (!this.attached(id)) continue
      const state = this.port.state(id)
      if (state && (state.turn || WORKING.has(state.status))) working++
      if (state) waiting += state.waiting
    }
    return {
      autoReview: manager.autoReview,
      approvals: manager.approvals,
      paused: manager.paused === true,
      stopped: manager.stoppedAt !== undefined,
      working,
      waiting,
      held: manager.held.length,
      turns: manager.task.turns,
      maxTurns: limits.turnsPerTask + manager.task.extraTurns,
      tokens: manager.task.tokens,
      budget: limits.tokenBudget,
      cost: manager.task.cost,
      unpriced: manager.task.unpriced,
      pending:
        manager.digest !== undefined && this.port.waitingDigest(record.id, manager.digest) !== null,
      answers: manager.answers.slice(-5),
    }
  }

  workerSummary(record: SessionRecord): WorkerSummary | null {
    const worker = record.worker
    if (!worker) return null
    const loop = this.loopOf(worker.managerId, record.id)
    return {
      managerId: worker.managerId,
      workerId: worker.workerId,
      name: worker.name,
      role: worker.role,
      kind: worker.kind,
      round: loop ? loop.round : null,
      loop: loop ? loop.state : null,
      status: worker.report?.status ?? null,
      line: worker.report ? firstLine(worker.report.summary, 120) || null : null,
      detached: worker.detached !== undefined,
      tokens: worker.tokens,
      cost: worker.cost,
      reviewOf: loop && loop.reviewerId === record.id ? loop.implementerId : null,
    }
  }

  /** The loop a worker is in, as implementer or reviewer: the newest one. */
  private loopOf(managerId: string, id: string): ReviewLoop | null {
    const loops = this.manager(managerId)?.loops ?? []
    for (let i = loops.length - 1; i >= 0; i--) {
      const loop = loops[i]!
      if (loop.implementerId === id || loop.reviewerId === id) return loop
    }
    return null
  }

  private activeLoop(
    managerId: string,
    id: string,
    as: 'implementer' | 'reviewer',
  ): ReviewLoop | null {
    const loop = this.loopOf(managerId, id)
    if (!loop || (loop.state !== 'reviewing' && loop.state !== 'fixing')) return null
    const mine = as === 'implementer' ? loop.implementerId === id : loop.reviewerId === id
    return mine ? loop : null
  }

  // The blocks agents read ahead of a prompt.

  /** The block the session's next prompt carries and the mark that says it got it; null for none. */
  aheadFor(id: string, acpSessionId: string): { text: string; mark: string } | null {
    const record = this.port.record(id)
    if (!record) return null
    const lang = this.port.lang()
    if (record.manager) {
      const text = this.managerText(record, lang)
      const mark = `${acpSessionId}:${hash(text)}`
      return record.manager.sentTo === mark ? null : { text, mark }
    }
    const worker = record.worker
    if (worker) {
      const entry = this.settingsOf(worker.managerId).workers.find((w) => w.id === worker.workerId)
      const text = workerBlock(lang, {
        name: worker.name,
        kind: worker.kind,
        persona: entry?.persona ?? '',
        folder: this.port.folder(id),
        branch: this.port.branch(id),
        alone: writes(worker.kind),
      })
      const mark = `${acpSessionId}:${hash(text)}`
      return worker.sentTo === mark ? null : { text, mark }
    }
    return null
  }

  markSent(id: string, mark: string): void {
    const record = this.port.record(id)
    if (record?.manager) record.manager.sentTo = mark
    else if (record?.worker) record.worker.sentTo = mark
    else return
    this.port.save(id)
  }

  /** The block is sent again with the next prompt, as after a compaction. */
  forget(id: string): void {
    const record = this.port.record(id)
    if (record?.manager) delete record.manager.sentTo
    if (record?.worker) delete record.worker.sentTo
  }

  private managerText(record: SessionRecord, lang: Lang): string {
    const manager = record.manager!
    const settings = this.port.settings(record.projectPath)
    const reviewer = settings.workers.find((w) => w.id === settings.reviewerId)?.name ?? null
    return managerBlock(lang, {
      roster: settings.workers.map((entry) => ({
        name: entry.name,
        role: entry.role,
        runs: this.port.runs(entry),
        persona: entry.persona,
        available: this.port.agent(entry.agentId).ready,
      })),
      reviewer,
      autoReview: manager.autoReview && reviewer !== null,
      rounds: settings.limits.reviewRounds,
      concurrent: settings.limits.concurrent,
      turns: settings.limits.turnsPerTask + manager.task.extraTurns,
      tokenBudget: settings.limits.tokenBudget,
      approvals: manager.approvals,
    })
  }

  // Events from the session manager.

  /**
   * A turn started in the session. `typed` is the user's own message text when they wrote it,
   * null for one Kite or an agent sent and for a turn the agent started itself.
   */
  turnStarted(id: string, typed: string | null): void {
    const record = this.port.record(id)
    if (!record) return
    const now = this.port.now()
    if (record.manager && typed !== null) {
      // The user writing to the manager starts a new task: its counters, and it goes on after a stop.
      record.manager.task = newTask(now)
      delete record.manager.stoppedAt
      delete record.manager.paused
      this.wakesTold.delete(id)
      this.port.save(id)
      this.port.touch(id)
      return
    }
    const link = this.attached(id)
    if (!link) return
    const { worker, manager } = link
    if (worker.owed === undefined) worker.owed = now
    if (typed !== null && typed.trim() !== '') {
      worker.interjected = [...(worker.interjected ?? []), cut(typed.trim(), 500)].slice(-3)
    }
    manager.task.turns += 1
    this.port.save(id)
    this.port.save(worker.managerId)
    this.port.touch(worker.managerId)
  }

  /** A turn ended; the check after it runs once the session manager has drained its queue. */
  turnEnded(id: string, stopReason: StopReason | null): void {
    const record = this.port.record(id)
    if (!record?.worker && !record?.manager) return
    this.ends.set(id, stopReason)
    queueMicrotask(() => void this.check(id))
  }

  /** A turn's tokens and their cost, null where its model has no price. */
  used(id: string, tokens: number, cost: number | null): void {
    const record = this.port.record(id)
    if (!record) return
    if (record.manager) {
      record.manager.task = addUsage(record.manager.task, tokens, cost)
      this.port.save(id)
      this.port.touch(id)
      return
    }
    const link = this.attached(id)
    if (!link) return
    const { worker, manager } = link
    const next = addUsage({ tokens: worker.tokens, cost: worker.cost }, tokens, cost)
    worker.tokens = next.tokens
    worker.cost = next.cost
    manager.task = addUsage(manager.task, tokens, cost)
    this.port.save(id)
    this.port.save(worker.managerId)
    this.port.touch(worker.managerId)
  }

  /** A worker asks for permission; a low request wakes a manager that may answer it. */
  requested(id: string, requestId: string, level: RiskLevel | null, what: string): void {
    const link = this.attached(id)
    this.port.touch(this.worker(id)?.managerId ?? id)
    if (!link || !managerMayAnswer(link.manager.approvals, level)) return
    const { worker } = link
    void this.locked(worker.managerId, async () => {
      await this.wake(worker.managerId, [
        {
          sessionId: id,
          name: worker.name,
          status: 'asks',
          line: cut(what, 200),
          request: { id: requestId, what: cut(what, 200) },
        },
      ])
    })
  }

  /** Checks a session once its state changed: a settled worker reports, a free slot starts one. */
  check(id: string): Promise<void> {
    const record = this.port.record(id)
    if (!record) return Promise.resolve()
    if (record.manager) {
      const ended = this.ends.has(id)
      this.ends.delete(id)
      // The guard keeps a manager from writing; should a write still get through, the user hears
      // of it and the manager pauses until they resume it.
      const files = ended ? this.port.turnFiles(id) : []
      if (files.length > 0 && !record.manager.paused) {
        this.port.notice(
          id,
          'warning',
          this.port.text('manager.editedFiles', { files: files.slice(0, 3).join(', ') }),
        )
        return this.setPaused(id, true)
      }
      return this.locked(id, async () => this.pump(id))
    }
    const worker = record.worker
    if (!worker) return Promise.resolve()
    return this.locked(worker.managerId, async () => {
      await this.checkWorker(id)
      this.pump(worker.managerId)
    }).catch((error: unknown) => {
      this.port.log(
        'warn',
        `Manager mode could not check worker ${id}: ${(error as Error).message}`,
      )
    })
  }

  private settled(id: string): boolean {
    const state = this.port.state(id)
    return state === null || isSettled(state)
  }

  private async checkWorker(id: string): Promise<void> {
    const link = this.attached(id)
    if (!link) return
    const { worker, manager } = link
    if (worker.owed === undefined) return
    const state = this.port.state(id)
    if (state && !isSettled(state)) {
      if (state.limitPaused && !this.limitTold.has(id)) {
        this.limitTold.add(id)
        await this.wake(worker.managerId, [
          { sessionId: id, name: worker.name, status: 'limit_paused', line: '' },
        ])
      }
      return
    }
    this.limitTold.delete(id)
    if (manager.stoppedAt !== undefined && manager.stoppedAt >= worker.owed) {
      delete worker.owed
      delete worker.interjected
      this.port.save(id)
      return
    }
    // A paused manager hears of it on Resume, which checks again.
    if (manager.paused) return
    const stopReason = this.ends.has(id) ? (this.ends.get(id) ?? null) : 'end_turn'
    const end = { stopReason, error: stopReason === null ? this.port.lastError(id) : null }
    const reported =
      worker.report?.by === 'tool' && worker.owed !== undefined && worker.report.at >= worker.owed
    // A turn that ended well without report_work is reminded once, as a workflow step is.
    if (!reported && end.stopReason === 'end_turn' && !this.reminded.has(id)) {
      this.reminded.add(id)
      const lang = this.port.lang()
      await this.port.send(
        id,
        worker.kind === 'review' ? reviewReminder(lang) : reportReminder(lang),
        this.fromManager(worker.managerId),
      )
      return
    }
    this.reminded.delete(id)
    const report = await this.reportOf(id, worker, end)
    // The worker may have been taken over or its manager stopped while that read.
    const again = this.attached(id)
    if (!again || again.worker.owed === undefined) return
    const said = again.worker.interjected ?? []
    again.worker.report = report
    delete again.worker.owed
    delete again.worker.interjected
    this.port.save(id)
    this.port.touch(id)
    if (await this.loopStep(id, report)) return
    await this.wake(again.worker.managerId, [
      {
        sessionId: id,
        name: again.worker.name,
        status: report.status,
        line: firstLine(report.summary, 200),
        ...(said.length > 0 ? { said } : {}),
      },
    ])
  }

  /** The report a settled worker gives: its own report_work of this turn, else Kite's reading. */
  private async reportOf(
    id: string,
    worker: StoredWorker,
    end: { stopReason: StopReason | null; error: string | null },
  ): Promise<WorkerReport> {
    const now = this.port.now()
    const own = worker.report && worker.owed !== undefined && worker.report.at >= worker.owed
    const changed = await this.changedOf(id, worker)
    if (own && worker.report?.by === 'tool') {
      const report = worker.report
      return {
        ...report,
        at: now,
        changed: report.changed.length > 0 ? mergeChanged(report.changed, changed) : changed,
      }
    }
    const reply = (await this.port.lastReply(id)) ?? ''
    const status: ReportStatus =
      end.stopReason === 'end_turn'
        ? 'done'
        : end.stopReason === 'cancelled'
          ? 'stopped'
          : end.stopReason === null || end.stopReason === 'refusal'
            ? 'failed'
            : 'blocked'
    const summary =
      status === 'failed' && end.error
        ? cut(`${end.error}${reply ? `\n${reply}` : ''}`, SUMMARY_CHARS)
        : cut(reply.trim(), SUMMARY_CHARS)
    const verdict = worker.kind === 'review' ? verdictIn(reply) : null
    return {
      at: now,
      status,
      by: 'derived',
      summary,
      changed,
      ...(verdict ? { verdict } : {}),
    }
  }

  private async changedOf(id: string, worker: StoredWorker): Promise<ChangedFile[]> {
    if (!writes(worker.kind)) return []
    if (worker.base) {
      const counted = await this.port.numstat(this.port.folder(id), worker.base).catch(() => null)
      if (counted) return counted.slice(0, 50)
    }
    return this.port
      .turnFiles(id)
      .slice(0, 50)
      .map((path) => ({ path, added: null, removed: null }))
  }

  // The review loop.

  /** Moves the worker's review loop on after it settled; false when no loop takes the report. */
  private async loopStep(id: string, report: WorkerReport): Promise<boolean> {
    const link = this.attached(id)
    if (!link) return false
    const { worker, manager } = link
    const managerId = worker.managerId
    const settings = this.settingsOf(managerId)
    const as = worker.kind === 'review' ? 'reviewer' : 'implementer'
    const loop = this.activeLoop(managerId, id, as)
    if (worker.kind !== 'implement' && !loop) return false
    const reviewerEntry = settings.workers.find((w) => w.id === settings.reviewerId)
    const reviewerReady =
      (loop?.reviewerId != null && this.attached(loop.reviewerId) !== null) ||
      (reviewerEntry !== undefined && this.port.agent(reviewerEntry.agentId).ready)
    const action: LoopAction = reviewNext(
      loop,
      { who: as, status: report.status, verdict: report.verdict ?? null },
      {
        enabled: manager.autoReview,
        reviewer: reviewerReady,
        rounds: settings.limits.reviewRounds,
        budget: budgetSpent(manager.task, settings.limits) === null,
        paused: manager.paused === true,
        stopped: manager.stoppedAt !== undefined,
        detached: false,
      },
    )
    switch (action.kind) {
      case 'none':
      case 'wait':
        return false
      case 'review':
        return this.review(managerId, loop, loop ? loop.implementerId : id, action.round)
      case 'fix': {
        const current = loop!
        current.state = 'fixing'
        current.round = action.round
        this.port.save(managerId)
        const reviewer = this.worker(id)
        await this.port.send(
          current.implementerId,
          fixPrompt(this.port.lang(), {
            reviewer: reviewer?.name ?? '',
            round: action.round,
            rounds: settings.limits.reviewRounds,
            findings: report.findings ?? [],
            summary: report.summary,
          }),
          this.fromManager(managerId),
        )
        this.port.touch(current.implementerId)
        this.port.touch(id)
        return true
      }
      case 'finish': {
        const current = loop
        if (!current) return false
        current.state = action.state
        current.endedAt = this.port.now()
        this.port.save(managerId)
        this.port.touch(current.implementerId)
        if (current.reviewerId) this.port.touch(current.reviewerId)
        if (action.state === 'stopped' && manager.stoppedAt !== undefined) return true
        const implementer = this.worker(current.implementerId)
        const status: DigestStatus =
          action.state === 'approved'
            ? 'approved'
            : action.state === 'out_of_rounds'
              ? 'out_of_rounds'
              : action.state === 'failed'
                ? 'review_failed'
                : 'stopped'
        const line =
          action.state === 'approved'
            ? firstLine(implementer?.report?.summary ?? '', 200)
            : firstLine(report.summary, 200)
        if (action.state === 'out_of_rounds') {
          this.port.attention(
            managerId,
            this.port.text('manager.outOfRounds.title'),
            this.port.text('manager.outOfRounds.body', { name: implementer?.name ?? '' }),
          )
        }
        await this.wake(managerId, [
          {
            sessionId: current.implementerId,
            name: implementer?.name ?? worker.name,
            status,
            line,
            round: current.round,
          },
        ])
        return true
      }
    }
  }

  /** Starts round `round`: the reviewer of the loop gets the review prompt, started if it has none. */
  private async review(
    managerId: string,
    loop: ReviewLoop | null,
    implementerId: string,
    round: number,
  ): Promise<boolean> {
    const manager = this.manager(managerId)
    const implementer = this.worker(implementerId)
    if (!manager || !implementer) return false
    const settings = this.settingsOf(managerId)
    const lang = this.port.lang()
    const text = reviewPrompt(lang, {
      implementer: implementer.name,
      title: implementer.title,
      summary: implementer.report?.summary ?? '',
      acceptance: implementer.acceptance ?? [],
      changed: implementer.report?.changed ?? [],
      base: implementer.base ?? null,
      round,
      rounds: settings.limits.reviewRounds,
      answer: round > 1 ? (implementer.report?.summary ?? null) : null,
    })
    let current = loop
    if (!current) {
      current = {
        id: randomUUID(),
        implementerId,
        reviewerId: null,
        round,
        state: 'reviewing',
        startedAt: this.port.now(),
      }
      manager.loops = [...manager.loops, current].slice(-LOOPS_KEPT)
    }
    current.state = 'reviewing'
    current.round = round
    this.port.save(managerId)
    const reviewerId = current.reviewerId
    if (reviewerId && this.attached(reviewerId)) {
      await this.port.send(reviewerId, text, this.fromManager(managerId))
    } else {
      const entry = settings.workers.find((w) => w.id === settings.reviewerId)
      if (!entry) {
        current.state = 'failed'
        this.port.save(managerId)
        return false
      }
      const lang2 = lang === 'zh' ? `审阅：${implementer.title}` : `Review: ${implementer.title}`
      current.reviewerId = await this.launch(managerId, entry, {
        kind: 'review',
        title: cut(lang2, 120),
        prompt: text,
        acceptance: [],
        shareWith: implementerId,
      })
      this.port.save(managerId)
    }
    this.port.touch(implementerId)
    return true
  }

  // Waking the manager.

  private fromManager(managerId: string): FromSession {
    const record = this.port.record(managerId)
    return {
      sessionId: managerId,
      title: record?.customTitle ?? record?.title ?? this.port.text('manager.untitled'),
    }
  }

  /** Puts items in the manager's digest: merged into the one waiting, else a new wake. */
  private async wake(managerId: string, items: DigestItem[]): Promise<void> {
    const record = this.port.record(managerId)
    const manager = record?.manager
    if (!record || !manager) return
    if (manager.stoppedAt !== undefined) {
      let held = this.quiet.get(managerId) ?? []
      for (const item of items) held = mergeDigest(held, item)
      this.quiet.set(managerId, held)
      return
    }
    const settings = this.port.settings(record.projectPath)
    const lang = this.port.lang()
    const waiting = manager.digest ? this.port.waitingDigest(managerId, manager.digest) : null
    let merged = [...(waiting ?? []), ...(this.quiet.get(managerId) ?? [])]
    for (const item of items) merged = mergeDigest(merged, item)
    if (
      waiting === null &&
      manager.task.wakes >= settings.limits.turnsPerTask + manager.task.extraTurns
    ) {
      if (!this.wakesTold.has(managerId)) {
        this.wakesTold.add(managerId)
        this.port.notice(managerId, 'warning', this.port.text('manager.wakesSpent'))
      }
      this.quiet.set(managerId, merged)
      return
    }
    this.quiet.delete(managerId)
    const text = digestText(
      lang,
      merged.map((item) => this.entryOf(item)),
      this.counters(managerId),
    )
    const first = merged[0]!
    const delivered = await this.port.deliver(
      managerId,
      waiting === null ? null : manager.digest!,
      text,
      {
        sessionId: first.sessionId,
        title: first.name,
        digest: merged,
      },
    )
    if (!delivered.merged) manager.task.wakes += 1
    if (delivered.itemId === null) delete manager.digest
    else manager.digest = delivered.itemId
    this.port.save(managerId)
    this.port.touch(managerId)
  }

  /** An item the manager hears of with its next wake, not waking it. */
  private async quietly(managerId: string, item: DigestItem): Promise<void> {
    const manager = this.manager(managerId)
    if (!manager) return
    const waiting = manager.digest ? this.port.waitingDigest(managerId, manager.digest) : null
    if (waiting !== null) {
      await this.wake(managerId, [item])
      return
    }
    this.quiet.set(managerId, mergeDigest(this.quiet.get(managerId) ?? [], item))
  }

  private entryOf(item: DigestItem): DigestEntry {
    const record = this.port.record(item.sessionId)
    const worker = record?.worker
    const entry = worker
      ? this.settingsOf(worker.managerId).workers.find((w) => w.id === worker.workerId)
      : undefined
    const report = worker?.report
    const withFindings = item.status === 'out_of_rounds' || item.status === 'review_failed'
    const reviewer =
      withFindings && worker ? this.loopOf(worker.managerId, item.sessionId)?.reviewerId : null
    const findings = reviewer ? (this.worker(reviewer)?.report?.findings ?? []) : []
    return {
      ...item,
      runs: entry ? this.port.runs(entry) : (record?.agentId ?? ''),
      summary:
        item.status === 'asks' || item.status === 'limit_paused' ? '' : (report?.summary ?? ''),
      changed: item.status === 'asks' ? [] : (report?.changed ?? []),
      findings,
      question: report?.status === 'needs_user' ? (report.question ?? null) : null,
    }
  }

  private counters(managerId: string): Parameters<typeof digestText>[2] {
    const record = this.port.record(managerId)!
    const manager = record.manager!
    const settings = this.port.settings(record.projectPath)
    const now = this.port.now()
    const working: { name: string; sessionId: string; minutes: number }[] = []
    const waiting: { name: string; sessionId: string; what: string }[] = []
    for (const id of this.workerIds(managerId)) {
      const link = this.attached(id)
      const state = this.port.state(id)
      if (!link || !state) continue
      if (state.waiting > 0) {
        const pending = this.port.pending(id)
        waiting.push({ name: link.worker.name, sessionId: id, what: pending[0]?.what ?? '' })
      } else if (state.turn) {
        const minutes =
          state.turnStartedAt === null ? 0 : Math.round((now - state.turnStartedAt) / 60_000)
        working.push({ name: link.worker.name, sessionId: id, minutes })
      }
    }
    return {
      turns: manager.task.turns,
      maxTurns: settings.limits.turnsPerTask + manager.task.extraTurns,
      tokens: manager.task.tokens,
      budget: settings.limits.tokenBudget,
      working,
      waiting,
      spent: budgetSpent(manager.task, settings.limits),
    }
  }

  // Dispatching.

  private dispatchState(managerId: string): DispatchState {
    const record = this.port.record(managerId)!
    const manager = record.manager!
    const working: DispatchState['working'][number][] = []
    for (const id of this.workerIds(managerId)) {
      const link = this.attached(id)
      const state = this.port.state(id)
      if (!link || !state || !(state.turn || WORKING.has(state.status))) continue
      working.push({
        id,
        folder: this.port.folderKey(this.port.folder(id)),
        writes: writes(link.worker.kind),
      })
    }
    return {
      paused: manager.paused === true,
      stopped: manager.stoppedAt !== undefined,
      task: manager.task,
      limits: this.port.settings(record.projectPath).limits,
      working,
      held: manager.held.length,
    }
  }

  /** start_worker: starts a worker from the roster now, or holds it for a slot or its folder. */
  startWorker(managerId: string, input: StartInput): Promise<StartResult> {
    return this.locked(managerId, () => this.startNow(managerId, input))
  }

  private async startNow(managerId: string, input: StartInput): Promise<StartResult> {
    const record = this.port.record(managerId)
    const manager = record?.manager
    if (!record || !manager) {
      throw new ManagerError('not_allowed', 'Only a manager session can start workers.')
    }
    const settings = this.port.settings(record.projectPath)
    const entry = findWorker(settings.workers, input.worker)
    if (!entry) {
      const names = settings.workers.map((w) => w.name).join(', ') || '(none)'
      throw new ManagerError(
        'not_found',
        `No worker "${input.worker}" on the roster. The roster has: ${names}.`,
      )
    }
    const kind = input.kind ?? entry.role
    if (writes(kind) && !writes(entry.role)) {
      throw new ManagerError(
        'not_allowed',
        `${entry.name} only reads (${entry.role}); give a task that changes files to a writing worker.`,
      )
    }
    if (input.requestId !== undefined) {
      const same = this.workerIds(managerId).find((id) => {
        const other = this.port.record(id)
        return (
          other !== null &&
          other.worker?.requestId === input.requestId &&
          other.createdAt >= manager.task.since
        )
      })
      if (same) return { kind: 'started', id: same, existing: true }
      const held = manager.held.findIndex((item) => item.requestId === input.requestId)
      if (held >= 0) return { kind: 'held', position: held + 1, reason: 'slots' }
    }
    const agent = this.port.agent(entry.agentId)
    if (!agent.ready) {
      throw new ManagerError(
        'not_allowed',
        `${entry.name} cannot start now: ${agent.reason ?? 'its agent is not ready'}. Pick another worker or ask the user.`,
      )
    }
    if (this.startedToday(managerId) >= DAILY_WORKERS) {
      throw new ManagerError(
        'limit',
        `You started ${DAILY_WORKERS} workers today, the most in a local day. Ask the user.`,
      )
    }
    const lang = this.port.lang()
    const title = cut(input.title?.trim() || firstLine(input.task, 60) || entry.name, 120)
    const prompt = taskPrompt(lang, {
      title,
      task: input.task,
      acceptance: input.acceptance,
      files: input.files,
    })
    const ownWorktree = entry.worktree && writes(kind)
    const decision = canDispatch(this.dispatchState(managerId), {
      writes: writes(kind),
      folder: this.port.folderKey(this.port.folder(managerId)),
      ownWorktree,
    })
    if (decision.kind === 'refuse') throw refusal(decision.code)
    if (decision.kind === 'hold') {
      const held: HeldStart = {
        id: randomUUID(),
        workerId: entry.id,
        name: entry.name,
        title,
        kind,
        prompt,
        at: this.port.now(),
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      }
      manager.held = [...manager.held, held].slice(0, HELD_MAX)
      this.heldAcceptance.set(held.id, input.acceptance)
      this.port.save(managerId)
      this.port.touch(managerId)
      return { kind: 'held', position: manager.held.length, reason: decision.reason }
    }
    const id = await this.launch(managerId, entry, {
      kind,
      title,
      prompt,
      acceptance: input.acceptance,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    })
    return { kind: 'started', id, existing: false }
  }

  private startedToday(managerId: string): number {
    const start = new Date(this.port.now())
    start.setHours(0, 0, 0, 0)
    return this.workerIds(managerId).filter(
      (id) => (this.port.record(id)?.createdAt ?? 0) >= start.getTime(),
    ).length
  }

  private async launch(
    managerId: string,
    entry: RosterWorker,
    params: {
      kind: WorkerRole
      title: string
      prompt: string
      acceptance: string[]
      requestId?: string
      shareWith?: string
    },
  ): Promise<string> {
    const folder = params.shareWith
      ? this.port.folder(params.shareWith)
      : this.port.folder(managerId)
    const base =
      params.kind === 'implement' && !entry.worktree ? await this.port.head(folder) : null
    const worker: StoredWorker = {
      managerId,
      workerId: entry.id,
      name: entry.name,
      role: entry.role,
      kind: params.kind,
      title: params.title,
      tokens: 0,
      cost: 0,
      owed: this.port.now(),
      ...(params.acceptance.length > 0 ? { acceptance: params.acceptance.slice(0, 10) } : {}),
      ...(base ? { base } : {}),
      ...(params.requestId === undefined ? {} : { requestId: params.requestId }),
    }
    const id = await this.port.createWorker(managerId, {
      entry,
      kind: params.kind,
      title: params.title,
      prompt: params.prompt,
      worker,
      ownWorktree: entry.worktree && writes(params.kind) && !params.shareWith,
      ...(params.shareWith ? { shareWith: params.shareWith } : {}),
      readOnlyMode: writes(params.kind) ? null : this.port.readOnlyMode(entry.agentId),
    })
    const created = this.port.record(id)
    if (created) this.added(created)
    // A worktree's base is known once the worktree is made.
    if (created?.worker && params.kind === 'implement' && entry.worktree && !created.worker.base) {
      const head = await this.port.head(this.port.folder(id))
      if (head) {
        created.worker.base = head
        this.port.save(id)
      }
    }
    this.port.touch(managerId)
    return id
  }

  /** Starts held workers and restart resumes while slots and folders let them, oldest first. */
  private pump(managerId: string): void {
    const manager = this.manager(managerId)
    if (!manager || manager.paused || manager.stoppedAt !== undefined) return
    const resumes = this.resumeWaiting.get(managerId) ?? []
    while (resumes.length > 0) {
      const state = this.dispatchState(managerId)
      if (state.working.length >= state.limits.concurrent) break
      const id = resumes.shift()!
      void this.resume(id)
    }
    if (resumes.length === 0) this.resumeWaiting.delete(managerId)
    const settings = this.settingsOf(managerId)
    for (const held of [...manager.held]) {
      const entry = settings.workers.find((w) => w.id === held.workerId)
      if (!entry) {
        manager.held = manager.held.filter((item) => item.id !== held.id)
        continue
      }
      const ownWorktree = entry.worktree && writes(held.kind)
      const decision = canDispatch(
        { ...this.dispatchState(managerId), held: 0 },
        {
          writes: writes(held.kind),
          folder: this.port.folderKey(this.port.folder(managerId)),
          ownWorktree,
        },
      )
      if (decision.kind === 'hold') continue
      manager.held = manager.held.filter((item) => item.id !== held.id)
      this.port.save(managerId)
      if (decision.kind === 'refuse') continue
      const acceptance = this.heldAcceptance.get(held.id) ?? []
      this.heldAcceptance.delete(held.id)
      void this.launch(managerId, entry, {
        kind: held.kind,
        title: held.title,
        prompt: held.prompt,
        acceptance,
        ...(held.requestId === undefined ? {} : { requestId: held.requestId }),
      }).catch((error: unknown) => {
        this.port.log(
          'warn',
          `Manager mode could not start a held worker: ${(error as Error).message}`,
        )
        void this.quietly(managerId, {
          sessionId: managerId,
          name: held.name,
          status: 'failed',
          line: cut((error as Error).message, 200),
        })
      })
    }
    this.port.touch(managerId)
  }

  // The manager's other tools.

  /** send_message to a worker: refused past the budget or a free slot, or while stopped. */
  sendRefusal(managerId: string, workerId: string): string | null {
    const manager = this.manager(managerId)
    const link = this.attached(workerId)
    if (!manager || !link || link.worker.managerId !== managerId) return null
    const state = this.port.state(workerId)
    const decision = canSend(this.dispatchState(managerId), {
      writes: writes(link.worker.kind),
      folder: this.port.folderKey(this.port.folder(workerId)),
      ownWorktree: false,
      workerId,
      working: state !== null && (state.turn || WORKING.has(state.status)),
    })
    return decision.kind === 'send' ? null : refusal(decision.code).message
  }

  /** What list_workers shows. */
  listWorkers(managerId: string): Record<string, unknown> {
    const record = this.port.record(managerId)
    const manager = record?.manager
    if (!record || !manager)
      throw new ManagerError('not_allowed', 'Only a manager session has workers.')
    const settings = this.port.settings(record.projectPath)
    const state = this.dispatchState(managerId)
    const roster = settings.workers.map((entry) => {
      const agent = this.port.agent(entry.agentId)
      return {
        name: entry.name,
        role: entry.role,
        runs: this.port.runs(entry),
        can_start: agent.ready,
        ...(agent.ready ? {} : { reason: agent.reason ?? 'not ready' }),
        reviewer: entry.id === settings.reviewerId,
        own_worktree: entry.worktree,
      }
    })
    const workers = this.workerIds(managerId).flatMap((id) => {
      const worker = this.worker(id)
      const other = this.port.record(id)
      if (!worker || !other) return []
      const live = this.port.state(id)
      const current = live !== null && (live.turn || live.waiting > 0 || WORKING.has(live.status))
      if (!current && other.createdAt < manager.task.since) return []
      const loop = this.loopOf(managerId, id)
      const pending = manager.approvals === 'low' ? this.port.pending(id) : []
      return [
        {
          id,
          name: worker.name,
          kind: worker.kind,
          title: worker.title,
          status: live ? (live.waiting > 0 ? 'awaiting_permission' : live.status) : 'closed',
          taken_over: worker.detached !== undefined,
          report: worker.report
            ? { status: worker.report.status, line: firstLine(worker.report.summary, 160) }
            : null,
          ...(loop ? { review: { round: loop.round, state: loop.state } } : {}),
          ...(pending.length > 0
            ? {
                requests: pending.map((item) => ({
                  request_id: item.requestId,
                  what: item.what,
                  risk: item.level,
                })),
              }
            : {}),
        },
      ]
    })
    return {
      roster,
      workers,
      limits: {
        working: state.working.length,
        concurrent: state.limits.concurrent,
        turns: manager.task.turns,
        max_turns: state.limits.turnsPerTask + manager.task.extraTurns,
        tokens: manager.task.tokens,
        token_budget: state.limits.tokenBudget,
      },
      held: manager.held.map((item) => ({ worker: item.name, title: item.title })),
      auto_review: manager.autoReview,
      approvals: manager.approvals,
    }
  }

  /** What get_worker shows. */
  getWorker(managerId: string, id: string): Record<string, unknown> {
    const worker = this.worker(id)
    if (!worker || worker.managerId !== managerId) {
      throw new ManagerError('not_found', `No worker ${id} of yours. list_workers shows them.`)
    }
    const live = this.port.state(id)
    const loop = this.loopOf(managerId, id)
    return {
      id,
      name: worker.name,
      kind: worker.kind,
      title: worker.title,
      status: live ? (live.waiting > 0 ? 'awaiting_permission' : live.status) : 'closed',
      taken_over: worker.detached !== undefined,
      tokens: worker.tokens,
      cost_usd: Math.round(worker.cost * 10_000) / 10_000,
      ...(worker.base ? { base: worker.base } : {}),
      report: worker.report ?? null,
      ...(loop ? { review: { round: loop.round, state: loop.state } } : {}),
    }
  }

  /** stop_worker: stops its turn; the manager asked, so no report follows. */
  async stopWorker(managerId: string, id: string): Promise<void> {
    const worker = this.worker(id)
    if (!worker || worker.managerId !== managerId) {
      throw new ManagerError('not_found', `No worker ${id} of yours. list_workers shows them.`)
    }
    delete worker.owed
    this.port.save(id)
    this.port.pauseQueue(id)
    await this.port.cancel(id)
  }

  /** report_work from a worker. */
  report(id: string, input: ReportInput): void {
    const record = this.port.record(id)
    const worker = record?.worker
    if (!record || !worker) {
      throw new ManagerError('not_allowed', 'Only a worker a manager started reports its work.')
    }
    if (worker.kind === 'review' && input.status === 'done' && !input.verdict) {
      throw new ManagerError('invalid', 'A review needs a verdict: approve or changes.')
    }
    worker.report = {
      at: this.port.now(),
      status: input.status,
      by: 'tool',
      summary: cut(input.summary, SUMMARY_CHARS),
      changed: input.changed.map((path) => ({ path, added: null, removed: null })),
      ...(input.verdict ? { verdict: input.verdict } : {}),
      ...(input.findings.length > 0 ? { findings: input.findings } : {}),
      ...(input.question ? { question: input.question } : {}),
    }
    this.port.save(id)
    this.port.touch(id)
  }

  /** answer_worker_request: the manager answers a worker's low request, rechecked now. */
  answer(managerId: string, id: string, requestId: string, allow: boolean): string {
    const manager = this.manager(managerId)
    if (!manager) throw new ManagerError('not_allowed', 'Only a manager session answers requests.')
    if (manager.approvals !== 'low') {
      throw new ManagerError(
        'not_allowed',
        "The user answers this session's worker requests. Leave them to the user.",
      )
    }
    const link = this.attached(id)
    if (!link || link.worker.managerId !== managerId) {
      throw new ManagerError('not_found', `No worker ${id} of yours. list_workers shows them.`)
    }
    const pending = this.port.pending(id).find((item) => item.requestId === requestId)
    if (!pending) {
      throw new ManagerError(
        'not_found',
        'That request no longer waits; it was answered or withdrawn.',
      )
    }
    const level = this.port.assess(id, requestId)
    if (!managerMayAnswer(manager.approvals, level)) {
      throw new ManagerError(
        'not_allowed',
        `Kite rates this request ${level ?? 'unknown'}: only the user can answer it. Leave it to the user.`,
      )
    }
    if (!this.port.respond(id, requestId, allow)) {
      throw new ManagerError(
        'not_found',
        'That request no longer waits; it was answered or withdrawn.',
      )
    }
    manager.answers = [
      ...manager.answers,
      {
        at: this.port.now(),
        workerId: id,
        name: link.worker.name,
        what: cut(pending.what, 300),
        allowed: allow,
      },
    ].slice(-ANSWERS_KEPT)
    this.port.save(managerId)
    this.port.notice(
      managerId,
      'info',
      this.port.text(allow ? 'manager.answered.allowed' : 'manager.answered.denied', {
        name: link.worker.name,
        what: cut(pending.what, 120),
      }),
    )
    this.port.touch(managerId)
    return allow ? 'Allowed once.' : 'Denied.'
  }

  // The user's controls.

  /** 全部停止: the manager and every worker of it stop, their queues pause, nothing wakes it. */
  async stopAll(managerId: string): Promise<void> {
    const record = this.port.record(managerId)
    const manager = record?.manager
    if (!record || !manager) throw new ManagerError('not_allowed', 'Not a manager session.')
    const now = this.port.now()
    manager.stoppedAt = now
    manager.held = []
    for (const loop of manager.loops) {
      if (loop.state === 'reviewing' || loop.state === 'fixing') {
        loop.state = 'stopped'
        loop.endedAt = now
      }
    }
    this.resumeWaiting.delete(managerId)
    this.quiet.delete(managerId)
    this.port.save(managerId)
    const stops: Promise<void>[] = []
    let count = 0
    for (const id of this.workerIds(managerId)) {
      const worker = this.worker(id)
      if (!worker || worker.detached !== undefined) continue
      delete worker.owed
      delete worker.interjected
      this.port.save(id)
      this.port.pauseQueue(id)
      const state = this.port.state(id)
      if (state && (state.turn || WORKING.has(state.status))) {
        count++
        stops.push(this.port.cancel(id).catch(() => {}))
      }
    }
    this.port.pauseQueue(managerId)
    const own = this.port.state(managerId)
    if (own?.turn) stops.push(this.port.cancel(managerId).catch(() => {}))
    await Promise.all(stops)
    this.port.notice(
      managerId,
      'info',
      this.port.text('manager.stoppedAll.title', { count }),
      this.port.text('manager.stoppedAll.description'),
    )
    this.port.touch(managerId)
  }

  /** 暂停 / 继续: no new dispatch or loop step while paused; Resume sends what waited. */
  async setPaused(managerId: string, paused: boolean): Promise<void> {
    const manager = this.manager(managerId)
    if (!manager) throw new ManagerError('not_allowed', 'Not a manager session.')
    if (paused) {
      manager.paused = true
      this.port.save(managerId)
      this.port.pauseQueue(managerId)
      this.port.touch(managerId)
      return
    }
    delete manager.paused
    delete manager.stoppedAt
    this.port.save(managerId)
    this.port.touch(managerId)
    for (const id of this.workerIds(managerId)) {
      if (this.attached(id)?.worker.owed !== undefined && this.settled(id)) void this.check(id)
    }
    const quiet = this.quiet.get(managerId)
    if (quiet && quiet.length > 0) {
      this.quiet.delete(managerId)
      await this.locked(managerId, () => this.wake(managerId, quiet))
    }
    await this.port.resumeQueue(managerId)
    await this.locked(managerId, async () => this.pump(managerId))
  }

  /** 接管 / 交还总管: a worker the user takes over reports to nobody until handed back. */
  setDetached(id: string, detached: boolean): void {
    const worker = this.worker(id)
    if (!worker) throw new ManagerError('not_allowed', 'Not a worker.')
    const managerId = worker.managerId
    if (detached === (worker.detached !== undefined)) return
    if (detached) {
      worker.detached = this.port.now()
      delete worker.owed
      delete worker.interjected
      const manager = this.manager(managerId)
      const loop = this.loopOf(managerId, id)
      if (manager && loop && (loop.state === 'reviewing' || loop.state === 'fixing')) {
        loop.state = 'stopped'
        loop.endedAt = this.port.now()
        this.port.save(managerId)
      }
    } else delete worker.detached
    this.port.save(id)
    this.port.touch(id)
    this.port.touch(managerId)
    void this.locked(managerId, () =>
      this.quietly(managerId, {
        sessionId: id,
        name: worker.name,
        status: detached ? 'taken_over' : 'handed_back',
        line: '',
      }),
    )
    void this.check(managerId)
  }

  /** 再给 10 回合. */
  moreTurns(managerId: string, turns = 10): void {
    const manager = this.manager(managerId)
    if (!manager) throw new ManagerError('not_allowed', 'Not a manager session.')
    manager.task.extraTurns += turns
    this.wakesTold.delete(managerId)
    this.port.save(managerId)
    this.port.touch(managerId)
    void this.check(managerId)
  }

  // After a restart.

  /** Workers a restart cut go on by themselves, at most a manager's slots at once, or are reported. */
  recover(): void {
    const workers = []
    const managers = []
    for (const record of this.port.records()) {
      if (record.manager) {
        const settings = this.port.settings(record.projectPath)
        managers.push({
          id: record.id,
          stopped: record.manager.stoppedAt !== undefined,
          paused: record.manager.paused === true,
          afterRestart: settings.afterRestart,
          concurrent: settings.limits.concurrent,
        })
        // A digest that waited when Kite quit goes on, as the queue comes back paused.
        if (
          record.manager.digest &&
          !record.manager.paused &&
          record.manager.stoppedAt === undefined &&
          this.port.waitingDigest(record.id, record.manager.digest) !== null
        ) {
          void this.port.resumeQueue(record.id).catch(() => {})
        }
      }
      if (record.worker) {
        const state = this.port.state(record.id)
        workers.push({
          id: record.id,
          managerId: record.worker.managerId,
          owed: record.worker.owed !== undefined,
          running: state !== null && state.turn,
          detached: record.worker.detached !== undefined,
          resumedAt: record.worker.resumedAt ?? null,
        })
      }
    }
    const plan = restartPlan(workers, managers, this.port.now())
    for (const id of plan.resume) void this.resume(id)
    for (const id of plan.hold) {
      const managerId = this.worker(id)!.managerId
      this.resumeWaiting.set(managerId, [...(this.resumeWaiting.get(managerId) ?? []), id])
    }
    for (const id of plan.tell) {
      const worker = this.worker(id)!
      const managerId = worker.managerId
      delete worker.owed
      worker.report = {
        at: this.port.now(),
        status: 'interrupted',
        by: 'derived',
        summary: '',
        changed: [],
      }
      this.port.save(id)
      void this.locked(managerId, () =>
        this.wake(managerId, [
          { sessionId: id, name: worker.name, status: 'interrupted', line: '' },
        ]),
      )
    }
  }

  private async resume(id: string): Promise<void> {
    const worker = this.worker(id)
    if (!worker) return
    worker.resumedAt = this.port.now()
    this.port.save(id)
    try {
      await this.port.send(id, resumePrompt(this.port.lang()), this.fromManager(worker.managerId))
    } catch (error) {
      this.port.log(
        'warn',
        `Manager mode could not resume worker ${id}: ${(error as Error).message}`,
      )
    }
  }
}

function refusal(code: string): ManagerError {
  switch (code) {
    case 'stopped':
      return new ManagerError(
        'not_allowed',
        'The user stopped everything. Wait for their next message.',
      )
    case 'paused':
      return new ManagerError(
        'not_allowed',
        'The user paused manager mode: dispatch nothing until they resume it. End your turn.',
      )
    case 'turns':
      return new ManagerError(
        'limit',
        "This task's worker turns are spent. Dispatch nothing more: sum up and ask the user whether to go on.",
      )
    case 'tokens':
      return new ManagerError(
        'limit',
        "This task's token budget is spent. Dispatch nothing more: sum up and ask the user whether to go on.",
      )
    case 'held':
      return new ManagerError(
        'limit',
        'Too many dispatches already wait for a slot. End your turn; Kite wakes you as workers finish.',
      )
    case 'slots':
      return new ManagerError(
        'busy',
        'Every worker slot is busy. End your turn; Kite wakes you when one finishes, then send it again.',
      )
    case 'folder':
      return new ManagerError(
        'busy',
        'Another worker is changing code in that folder. End your turn; Kite wakes you when it finishes.',
      )
    default:
      return new ManagerError('not_allowed', 'Refused.')
  }
}

/** The files a worker named, with the counts git gave where it gave them. */
function mergeChanged(
  named: readonly ChangedFile[],
  counted: readonly ChangedFile[],
): ChangedFile[] {
  const byPath = new Map(counted.map((file) => [file.path, file]))
  const out = named.map((file) => byPath.get(file.path) ?? file)
  for (const file of counted) if (!out.some((other) => other.path === file.path)) out.push(file)
  return out.slice(0, 50)
}

/** A short hash of a block's text, so a changed block goes again. */
function hash(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
