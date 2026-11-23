// Huli: main runs a session's move to another computer (shared/session-move.ts) over the hosts'
// existing channels: this computer's agent host through main's own messages, another host as this
// computer's desktop device of it. It checks both sides, has the target prepare the project, the
// source pack, carries the pack across in parts, has the target apply it, then the source mark
// the session moved. A failure at any step has the target undo all it did and the source drop
// its pack, so the session stays where it was, working.

import { randomBytes } from 'node:crypto'
import { PortRequestError } from '@shared/port-rpc'
import {
  MOVE_STEPS,
  type MoveHost,
  type MovePack,
  type MovePreview,
  type MovePrepared,
  type MoveProblem,
  type MoveProgress,
  type MoveSource,
  type MoveStep,
  type MoveTarget,
} from '@shared/session-move'

export interface SessionMoverDeps {
  /** A host method on a host: this computer's for null. */
  call(host: MoveHost, method: string, params: unknown): Promise<unknown>
  /** The name the user knows the host by. */
  hostName(host: MoveHost): string
  /** Whether the host is connected now. */
  online(host: MoveHost): boolean
  /** A move's progress changed. */
  changed(progress: MoveProgress): void
  log(level: 'info' | 'warn' | 'error', message: string): void
  now?(): number
  newId?(): string
}

/** Moves kept for the windows to show once over, newest last. */
const KEPT = 20

const KNOWN_REASONS: ReadonlySet<string> = new Set<MoveProblem>([
  'busy',
  'subagent',
  'manager',
  'worker',
  'prepared',
  'noProject',
  'noGit',
  'noCommits',
  'operation',
  'tooLarge',
  'noRemote',
  'gitMissing',
  'agentMissing',
  'agentOff',
  'agentNotInstalled',
  'signedOut',
  'sameHost',
  'offline',
  'olderHost',
  'sameProject',
  'worktree',
])

/** Huli: what only a move of the code needs, which the conversation alone does without. */
const CODE_ONLY: ReadonlySet<MoveProblem> = new Set<MoveProblem>([
  'noGit',
  'noCommits',
  'operation',
  'noRemote',
  'gitMissing',
])

/** Huli: a project's name from its path, as either platform writes it. */
const nameOf = (folder: string): string => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder

function reasonOf(error: unknown): MoveProblem | null {
  if (error instanceof PortRequestError) {
    if (error.code === 'unknown_method') return 'olderHost'
    if (error.code === 'host_offline') return 'offline'
    const reason = (error.data as { reason?: unknown } | undefined)?.reason
    if (typeof reason === 'string' && KNOWN_REASONS.has(reason)) return reason as MoveProblem
  }
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new Error('The source sent no bytes')
}

class MoveFailed extends Error {
  constructor(
    message: string,
    readonly reason: MoveProblem | null,
    readonly problems: MoveProblem[] = [],
  ) {
    super(message)
  }
}

export class SessionMover {
  private readonly moves = new Map<string, MoveProgress>()

  constructor(private readonly deps: SessionMoverDeps) {}

  /**
   * What a move would do: both hosts' facts, and what stops it. Huli: `project`, one of the
   * host's projects as it writes it, moves the session within its own computer.
   */
  async preview(
    source: MoveHost,
    sessionId: string,
    target: MoveHost,
    project: string | null = null,
  ): Promise<MovePreview> {
    const fail = (problem: MoveProblem): never => {
      throw new MoveFailed(problem, problem, [problem])
    }
    const local = source === target
    if (local && project === null) fail('sameHost')
    if (!this.deps.online(source) || !this.deps.online(target)) fail('offline')
    const facts = (await this.ask(source, 'moves.inspect', { sessionId })) as MoveSource
    const there = (await this.ask(target, 'moves.check', {
      agentId: facts.agentId,
      remotes: facts.git?.remotes ?? [],
      remote: facts.git?.remote ?? null,
      ...(local && project !== null ? { project } : {}),
    })) as MoveTarget
    // Without Git at the source nothing is there to match or clone.
    const targetProblems = facts.git
      ? there.problems
      : there.problems.filter((p) => p !== 'noRemote')
    let problems = [...new Set([...facts.problems, ...targetProblems])]
    let notes = [...facts.notes]
    if (there.agent?.state === 'signInUnknown') notes.push('signInUnknown')
    if (local) {
      // The conversation alone needs no repository, and leaves no worktree behind with work in it.
      if (there.conversationOnly) {
        problems = problems.filter((p) => !CODE_ONLY.has(p))
        notes = notes.filter((note) => note === 'carry' || note === 'signInUnknown')
        if (facts.worktree) problems.push('worktree')
      }
      const into = there.project?.path ?? ''
      const same =
        facts.platform === 'win32'
          ? into.toLowerCase() === facts.projectPath.toLowerCase()
          : into === facts.projectPath
      if (same) problems.push('sameProject')
    }
    const targetName = local ? nameOf(there.project?.path ?? '') : this.deps.hostName(target)
    return { source: facts, target: there, problems, notes, targetName }
  }

  /**
   * Starts the move; the windows hear its progress. Refused while the session moves already.
   * Huli: `project` moves it within its own computer, as for `preview`.
   */
  start(
    source: MoveHost,
    sessionId: string,
    target: MoveHost,
    project: string | null = null,
  ): string {
    for (const move of this.moves.values()) {
      if (move.sessionId === sessionId && move.sourceHost === source && move.state === 'running') {
        throw new MoveFailed('busy', 'busy')
      }
    }
    const moveId = this.deps.newId?.() ?? randomBytes(16).toString('hex')
    const progress: MoveProgress = {
      moveId,
      sessionId,
      sourceHost: source,
      targetHost: target,
      targetName:
        source === target && project !== null ? nameOf(project) : this.deps.hostName(target),
      steps: MOVE_STEPS.map((step) => ({ step, state: 'pending' })),
      state: 'running',
      transfer: null,
      result: null,
      error: null,
      reason: null,
      undone: true,
      problems: [],
      ...(source === target && project !== null ? { project } : {}),
    }
    this.moves.set(moveId, progress)
    while (this.moves.size > KEPT) this.moves.delete(this.moves.keys().next().value!)
    this.deps.changed(structuredClone(progress))
    void this.run(progress)
    return moveId
  }

  list(): MoveProgress[] {
    return [...this.moves.values()].map((move) => structuredClone(move))
  }

  private async ask(host: MoveHost, method: string, params: unknown): Promise<unknown> {
    try {
      return await this.deps.call(host, method, params)
    } catch (error) {
      throw new MoveFailed(messageOf(error), reasonOf(error))
    }
  }

  private set(
    progress: MoveProgress,
    step: MoveStep,
    state: MoveProgress['steps'][number]['state'],
  ) {
    const item = progress.steps.find((s) => s.step === step)
    if (item) item.state = state
    this.deps.changed(structuredClone(progress))
  }

  private async run(progress: MoveProgress): Promise<void> {
    const { moveId, sessionId, sourceHost: source, targetHost: target } = progress
    const local = source === target
    // Huli: within one computer its host takes both sides, each under an id of its own.
    const packId = local ? (this.deps.newId?.() ?? randomBytes(16).toString('hex')) : moveId
    let targetTouched = false
    let sourceTouched = false
    let current: MoveStep = 'check'
    const begin = (step: MoveStep): void => {
      current = step
      this.set(progress, step, 'running')
    }
    try {
      begin('check')
      const preview = await this.preview(source, sessionId, target, progress.project ?? null).catch(
        (error: unknown) => {
          if (error instanceof MoveFailed) throw error
          throw new MoveFailed(messageOf(error), reasonOf(error))
        },
      )
      if (preview.problems.length > 0) {
        throw new MoveFailed(preview.problems[0]!, preview.problems[0]!, preview.problems)
      }
      const agent = preview.target.agent
      const git = preview.source.git
      const remote = git?.remotes.find((item) => item.name === git.remote) ?? null
      const only = local && preview.target.conversationOnly === true
      if (!agent || (!only && (!git || !remote))) throw new MoveFailed('noRemote', 'noRemote')
      this.set(progress, 'check', 'done')

      begin('project')
      targetTouched = true
      const into = preview.target.project
      const prepared = (await this.ask(target, 'moves.prepare', {
        moveId,
        project: !into
          ? { clone: true }
          : only
            ? { path: into.path, conversationOnly: true }
            : { path: into.path },
        url: only ? null : remote!.url,
      })) as MovePrepared
      this.set(progress, 'project', 'done')

      begin('pack')
      sourceTouched = true
      const pack = (await this.ask(source, 'moves.pack', {
        sessionId,
        moveId: packId,
        haves: prepared.haves,
        ...(only ? { conversationOnly: true } : {}),
      })) as MovePack
      this.set(progress, 'pack', 'done')

      begin('transfer')
      const total = pack.files.reduce((sum, file) => sum + file.size, 0)
      progress.transfer = { sent: 0, total }
      for (const file of pack.files) {
        let offset = 0
        while (offset < file.size) {
          const part = (await this.ask(source, 'moves.part', {
            moveId: packId,
            name: file.name,
            offset,
          })) as { bytes: unknown }
          const bytes = bytesOf(part.bytes)
          if (bytes.byteLength === 0) throw new MoveFailed('The pack ended early', null)
          await this.ask(target, 'moves.receive', {
            moveId,
            name: file.name,
            offset,
            size: file.size,
            bytes,
          })
          offset += bytes.byteLength
          progress.transfer.sent += bytes.byteLength
          this.deps.changed(structuredClone(progress))
        }
      }
      this.set(progress, 'transfer', 'done')

      begin('apply')
      const result = (await this.ask(target, 'moves.apply', {
        moveId,
        files: pack.files,
        git: pack.git,
        conversation: pack.conversation,
        agentId: agent.agentId,
        title: preview.source.title,
        createdAt: preview.source.createdAt,
        worktree: only ? null : preview.source.worktree,
      })) as { sessionId: string; projectPath: string }
      progress.result = result
      this.set(progress, 'apply', 'done')

      begin('finish')
      await this.ask(source, 'moves.finish', {
        moveId: packId,
        sessionId,
        to: {
          hostId: target,
          name: progress.targetName,
          sessionId: result.sessionId,
          projectPath: result.projectPath,
          at: this.deps.now?.() ?? Date.now(),
          ...(local ? { sameComputer: true } : {}),
        },
      })
      sourceTouched = false
      targetTouched = false
      await this.ask(target, 'moves.commit', { moveId }).catch((error: unknown) =>
        this.deps.log('warn', `The target did not drop a move's staging: ${messageOf(error)}`),
      )
      this.set(progress, 'finish', 'done')
      progress.state = 'done'
      this.deps.changed(structuredClone(progress))
      this.deps.log('info', `Moved a session to ${progress.targetName}`)
    } catch (error) {
      const failed = error instanceof MoveFailed ? error : new MoveFailed(messageOf(error), null)
      progress.result = null
      progress.error = failed.message
      progress.reason = failed.reason
      progress.problems = failed.problems
      let undone = true
      if (targetTouched) {
        undone = await this.deps
          .call(target, 'moves.undo', { moveId })
          .then((answer) => (answer as { undone?: unknown }).undone === true)
          .catch((undoError: unknown) => {
            this.deps.log('error', `A move could not be undone: ${messageOf(undoError)}`)
            return false
          })
      }
      if (sourceTouched) {
        await this.deps
          .call(source, 'moves.abort', { moveId: packId })
          .catch((abortError: unknown) =>
            this.deps.log('warn', `The source kept a move's pack: ${messageOf(abortError)}`),
          )
      }
      progress.undone = undone
      progress.state = 'failed'
      this.set(progress, current, 'failed')
      this.deps.log('warn', `A move failed at ${current}: ${failed.reason ?? 'error'}`)
    }
  }
}

export { MoveFailed }
