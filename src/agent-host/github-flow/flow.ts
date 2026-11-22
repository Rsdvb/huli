// Huli: the GitHub flow's reads and what they start. Only repositories that a session's pull
// request automation or an enabled routine trigger needs are read, each at most once a minute, at
// the pull request cadence the git service keeps, slower while no window shows, backing off after
// failures and not at all while the computer sleeps. With nothing turned on, no timer runs.

import { GITHUB_ISSUE_URL, githubReferenceOf, type GitTools } from '@shared/git'
import {
  isBranchName,
  type GithubEvent,
  type InboxFilter,
  type IssueInbox,
  type PrFlowState,
  type RunCause,
} from '@shared/github-flow'
import { HostError, invalidParams, notFound } from '../errors'
import { describeFailure, GH_TIMEOUT_MS, GIT_TIMEOUT_MS, type Exec } from '../git/exec'
import { t } from '../i18n'
import type { GithubFlowFile, JsonFile, LogFn, StoredPrFlow } from '../storage'
import {
  advanceCursor,
  mergeDecision,
  readyHead,
  remember,
  triggerFires,
  wakeMessage,
  watchEvents,
  type TriggerCursor,
  type TriggerSnapshot,
  type WatchEvent,
} from './decide'
import {
  checkRepo,
  flowViewArgs,
  inboxPath,
  issuePath,
  lineCommentsPath,
  mapFlowPullRequest,
  mapLineComments,
  mapPrChecks,
  mapRefOid,
  mapRepoInfo,
  mapRestIssue,
  mapRestIssues,
  mapRestPulls,
  mergePullRequest,
  prChecksArgs,
  pullsPath,
  readBehind,
  refPath,
  repoPath,
  restRead,
  type FlowPullRequest,
  type GhFailure,
  type LineComment,
  type Repo,
  type RepoInfo,
} from './gh-api'

/** No repository is read more often than this. */
export const MIN_INTERVAL_MS = 60_000
/** While checks run or GitHub works out mergeability, as the git service polls a branch's. */
export const FAST_MS = 60_000
/** Otherwise, as the git service polls a pull request that is not changing. */
export const SLOW_MS = 300_000
/** Reads slow down this much while no window of the app shows. */
export const HIDDEN_FACTOR = 3
const RETRY_MS = 60_000
const RETRY_MAX_MS = 30 * 60_000
/** After the computer wakes, the first reads wait a little for the network. */
const RESUME_MS = 15_000
const REPO_OF_MS = 10 * 60_000
const REST_CACHE = 60
const ISSUE_BODY_CHARS = 20_000

/** How long a repository waits before its next read. */
export function nextDelay(wanted: number, failures: number, visible: boolean): number {
  let delay = visible ? wanted : wanted * HIDDEN_FACTOR
  if (failures > 0) {
    delay = Math.max(delay, Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS))
  }
  return Math.max(delay, MIN_INTERVAL_MS)
}

export interface FlowSession {
  sessionId: string
  flow: StoredPrFlow
  folder: string
  busy: boolean
  worktree: boolean
}

export interface FlowTrigger {
  routineId: string
  projectPath: string
  event: GithubEvent
}

export interface GithubFlowDeps {
  exec: Exec
  /** Where gh runs for reads and the merge: outside any checkout, so it touches no branch. */
  home: string
  tools(): Promise<GitTools>
  /** The GitHub repository of a folder's remote; null when it has none on github.com. */
  repoOf(folder: string): Promise<Repo | null>
  sessions: {
    flows(): FlowSession[]
    update(sessionId: string, url: string, change: (flow: StoredPrFlow) => StoredPrFlow): void
    setState(sessionId: string, state: PrFlowState | null): void
    note(
      sessionId: string,
      severity: 'info' | 'warning' | 'error',
      title: string,
      description?: string,
    ): Promise<void>
    tell(sessionId: string, text: string): Promise<boolean>
    closeMerged(
      sessionId: string,
      headOid: string,
    ): Promise<{
      removing: { branch: string } | null
      kept: string | null
      finish(): Promise<void>
    }>
  }
  routines: {
    /** The enabled routines that run on a GitHub event, in a project. */
    triggers(): FlowTrigger[]
    /** Whether a run of the routine may start now. */
    idle(routineId: string): boolean
    fire(routineId: string, cause: RunCause, context: string): void
  }
  file: JsonFile<GithubFlowFile>
  log: LogFn
  now?: () => number
  timers?: {
    set(run: () => void, ms: number): unknown
    clear(handle: unknown): void
  }
}

interface RepoState {
  key: string
  repo: Repo
  /** Who needs it, to notice a new need. */
  signature: string
  lastAt: number
  failures: number
  wanted: number
  timer: unknown
  polling: boolean
  rest: Map<string, { etag: string | null; json: unknown }>
  /** Pull requests a read found ready but for their missing checks, by URL: their head. */
  readyHeads: Map<string, string>
  behind: Map<string, { oid: string; baseOid: string; behind: number | null }>
}

const SYSTEM_TIMERS = {
  set(run: () => void, ms: number): unknown {
    const timer = setTimeout(run, ms)
    timer.unref()
    return timer
  },
  clear(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

function repoKey(repo: Repo): string {
  return `${repo.owner}/${repo.repo}`.toLowerCase()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cut(value: string, chars: number): string {
  const list = Array.from(value)
  return list.length > chars ? `${list.slice(0, chars).join('')}…` : value
}

export class GithubFlow {
  private readonly repos = new Map<string, RepoState>()
  private readonly repoOfCache = new Map<string, { at: number; repo: Repo | null }>()
  private readonly inboxCache = new Map<
    string,
    { etag: string | null; json: unknown; next: boolean }
  >()
  private readonly now: () => number
  private readonly timers: NonNullable<GithubFlowDeps['timers']>
  private cursors: Record<string, TriggerCursor> | null = null
  private loading: Promise<void> | null = null
  private refreshing: Promise<void> | null = null
  private refreshAgain = false
  private asleep = false
  private visible = true
  private stopped = false

  constructor(private readonly deps: GithubFlowDeps) {
    this.now = deps.now ?? Date.now
    this.timers = deps.timers ?? SYSTEM_TIMERS
  }

  /** What needs reading changed: a switch, a routine, a session archived. Coalesced. */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.refreshing) {
      this.refreshAgain = true
      return this.refreshing
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false
        await this.plan().catch((error: unknown) =>
          this.deps.log('warn', `GitHub flow: could not plan its reads: ${messageOf(error)}`),
        )
      } while (this.refreshAgain && !this.stopped)
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /** The computer slept or woke: no reads while it sleeps, and the first ones soon after. */
  power(state: 'suspend' | 'resume'): void {
    if (state === 'suspend') {
      this.asleep = true
      for (const repo of this.repos.values()) this.unschedule(repo)
      return
    }
    if (!this.asleep) return
    this.asleep = false
    for (const repo of this.repos.values()) this.schedule(repo, RESUME_MS)
  }

  /** Whether a window of the app shows; reads slow down while none does. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    if (!visible) return
    for (const repo of this.repos.values()) {
      if (!repo.polling) this.schedule(repo, Math.max(0, repo.lastAt + repo.wanted - this.now()))
    }
  }

  stop(): void {
    this.stopped = true
    for (const repo of this.repos.values()) this.unschedule(repo)
    this.repos.clear()
  }

  /** How many repositories are read now, for the tests and the log. */
  watchedRepos(): string[] {
    return [...this.repos.keys()]
  }

  // The issue inbox: read when asked, never polled.

  async issues(projectPath: string, filter: InboxFilter): Promise<IssueInbox> {
    const repo = await this.projectRepo(projectPath)
    const tools = await this.readyTools()
    const viewer = tools.gh.account
    if (filter === 'mine' && !viewer) {
      return { ...repo, viewer: null, issues: [], truncated: false, readAt: this.now() }
    }
    const path = inboxPath(repo, filter === 'mine' ? viewer : null)
    const cached = this.inboxCache.get(path)
    const read = await restRead(this.deps.exec, this.deps.home, path, cached?.etag ?? null)
    if (!read.ok)
      throw new HostError('git_error', t('githubFlow.noRepoAccess', { error: read.message }))
    let answer: { etag: string | null; json: unknown; next: boolean }
    if (!read.unchanged) {
      answer = { etag: read.etag, json: read.json, next: read.next }
      this.inboxCache.set(path, answer)
      while (this.inboxCache.size > 20) {
        const oldest = this.inboxCache.keys().next().value
        if (oldest === undefined) break
        this.inboxCache.delete(oldest)
      }
    } else if (cached) {
      answer = cached
    } else {
      throw new HostError('git_error', t('githubFlow.noRepoAccess', { error: 'HTTP 304' }))
    }
    const issues = mapRestIssues(answer.json, repo).map((issue) => ({
      url: issue.url,
      number: issue.number,
      title: issue.title,
      labels: issue.labels.slice(0, 3),
      assignees: issue.assignees,
      author: issue.author,
      comments: issue.comments,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    }))
    return { ...repo, viewer, issues, truncated: answer.next, readAt: this.now() }
  }

  /** The first message of a session for the issue at `url`, in the project's own repository. */
  async issuePrompt(projectPath: string, url: string): Promise<string> {
    const ref = githubReferenceOf(url)
    if (ref?.kind !== 'issue' || !GITHUB_ISSUE_URL.test(url))
      throw invalidParams('Not an issue URL')
    const repo = await this.projectRepo(projectPath)
    if (repoKey(repo) !== repoKey(ref)) throw invalidParams(t('githubFlow.notOnGithub'))
    await this.readyTools()
    const read = await restRead(this.deps.exec, this.deps.home, issuePath(repo, ref.number), null)
    if (!read.ok || read.unchanged) {
      throw new HostError(
        'git_error',
        t('githubFlow.noRepoAccess', { error: read.ok ? 'HTTP 304' : read.message }),
      )
    }
    const issue = mapRestIssue(read.json, repo)
    if (!issue) throw notFound(t('githubFlow.notThisSession'))
    const body = issue.body.trim()
      ? cut(issue.body.trim(), ISSUE_BODY_CHARS)
      : t('githubFlow.issueNoBody')
    const head = t('githubFlow.issuePrompt', {
      repo: `${repo.owner}/${repo.repo}`,
      number: issue.number,
      title: issue.title,
      url: issue.url,
    })
    return `${head}\n\n${body}`
  }

  private async projectRepo(projectPath: string): Promise<Repo> {
    const repo = await this.deps.repoOf(projectPath)
    if (!repo) throw invalidParams(t('githubFlow.notOnGithub'))
    return checkRepo(repo)
  }

  private async readyTools(): Promise<GitTools> {
    const tools = await this.deps.tools()
    if (tools.gh.state === 'not-installed') throw new HostError('git_error', t('git.ghMissing'))
    if (tools.gh.state === 'signed-out') throw new HostError('git_error', t('git.ghSignedOut'))
    return tools
  }

  // Planning

  private async cachedRepoOf(projectPath: string): Promise<Repo | null> {
    const cached = this.repoOfCache.get(projectPath)
    if (cached && this.now() - cached.at < REPO_OF_MS) return cached.repo
    let repo: Repo | null = null
    try {
      repo = await this.deps.repoOf(projectPath)
    } catch (error) {
      this.deps.log('warn', `GitHub flow: no repository for ${projectPath}: ${messageOf(error)}`)
    }
    this.repoOfCache.set(projectPath, { at: this.now(), repo })
    return repo
  }

  private async plan(): Promise<void> {
    const needs = new Map<string, { repo: Repo; parts: string[] }>()
    const need = (repo: Repo, part: string): void => {
      const key = repoKey(repo)
      const entry = needs.get(key) ?? { repo, parts: [] }
      entry.parts.push(part)
      needs.set(key, entry)
    }
    for (const session of this.deps.sessions.flows()) {
      const ref = githubReferenceOf(session.flow.url)
      if (ref?.kind === 'pull') need(ref, `s:${session.sessionId}`)
    }
    for (const trigger of this.deps.routines.triggers()) {
      const repo = await this.cachedRepoOf(trigger.projectPath)
      if (repo) need(repo, `r:${trigger.routineId}:${JSON.stringify(trigger.event)}`)
    }
    if (this.stopped) return
    for (const [key, state] of this.repos) {
      if (needs.has(key)) continue
      this.unschedule(state)
      this.repos.delete(key)
    }
    for (const [key, { repo, parts }] of needs) {
      const signature = parts.sort().join('\n')
      const state = this.repos.get(key)
      if (!state) {
        const created: RepoState = {
          key,
          repo,
          signature,
          lastAt: Number.NEGATIVE_INFINITY,
          failures: 0,
          wanted: SLOW_MS,
          timer: null,
          polling: false,
          rest: new Map(),
          readyHeads: new Map(),
          behind: new Map(),
        }
        this.repos.set(key, created)
        this.schedule(created, 0)
        continue
      }
      const added = parts.some((part) => !state.signature.split('\n').includes(part))
      state.signature = signature
      // Something new reads soon, within the least interval of the last read.
      if (added && !state.polling) this.schedule(state, 0)
    }
  }

  private unschedule(state: RepoState): void {
    if (state.timer !== null) this.timers.clear(state.timer)
    state.timer = null
  }

  private schedule(state: RepoState, delay: number): void {
    this.unschedule(state)
    if (this.stopped || this.asleep) return
    const at = Math.max(this.now() + delay, state.lastAt + MIN_INTERVAL_MS)
    state.timer = this.timers.set(
      () => {
        state.timer = null
        void this.poll(state)
      },
      Math.max(0, at - this.now()),
    )
  }

  // Reading

  private async poll(state: RepoState): Promise<void> {
    if (this.stopped || this.asleep || state.polling) return
    if (this.repos.get(state.key) !== state) return
    state.polling = true
    state.lastAt = this.now()
    let failed = false
    let wanted = SLOW_MS
    try {
      const tools = await this.deps.tools()
      if (tools.gh.state !== 'ready') {
        failed = true
      } else {
        for (const session of this.deps.sessions.flows()) {
          const ref = githubReferenceOf(session.flow.url)
          if (ref?.kind !== 'pull' || repoKey(ref) !== state.key || this.stopped) continue
          const read = await this.pollSession(state, session)
          failed ||= read.failed
          wanted = Math.min(wanted, read.wanted)
        }
        for (const trigger of this.deps.routines.triggers()) {
          const repo = await this.cachedRepoOf(trigger.projectPath)
          if (!repo || repoKey(repo) !== state.key || this.stopped) continue
          const read = await this.pollTrigger(state, trigger)
          failed ||= read.failed
          wanted = Math.min(wanted, read.wanted)
        }
      }
    } catch (error) {
      failed = true
      this.deps.log('warn', `GitHub flow: reading ${state.key} failed: ${messageOf(error)}`)
    } finally {
      state.polling = false
    }
    state.failures = failed ? state.failures + 1 : 0
    state.wanted = wanted
    if (this.repos.get(state.key) !== state) return
    // An automation that ended here leaves nothing to read for it: plan again rather than wait.
    const left = this.deps.sessions.flows().some((session) => {
      const ref = githubReferenceOf(session.flow.url)
      return ref?.kind === 'pull' && repoKey(ref) === state.key
    })
    this.schedule(state, nextDelay(wanted, state.failures, this.visible))
    if (!left && state.signature.split('\n').some((part) => part.startsWith('s:'))) {
      void this.refresh()
    }
  }

  private async rest(
    state: RepoState,
    path: string,
  ): Promise<{ ok: true; json: unknown; changed: boolean } | GhFailure> {
    const cached = state.rest.get(path)
    const read = await restRead(this.deps.exec, this.deps.home, path, cached?.etag ?? null)
    if (!read.ok) return read
    if (read.unchanged) {
      if (cached) return { ok: true, json: cached.json, changed: false }
      return { ok: false, reason: 'failed', message: 'HTTP 304 without a cached answer' }
    }
    state.rest.delete(path)
    state.rest.set(path, { etag: read.etag, json: read.json })
    while (state.rest.size > REST_CACHE) {
      const oldest = state.rest.keys().next().value
      if (oldest === undefined) break
      state.rest.delete(oldest)
    }
    return { ok: true, json: read.json, changed: true }
  }

  private async repoInfo(state: RepoState): Promise<RepoInfo | null> {
    const read = await this.rest(state, repoPath(state.repo))
    if (!read.ok) return null
    try {
      return mapRepoInfo(read.json)
    } catch {
      return null
    }
  }

  private async pollSession(
    state: RepoState,
    session: FlowSession,
  ): Promise<{ failed: boolean; wanted: number }> {
    const { flow } = session
    const result = await this.deps.exec('gh', flowViewArgs(flow.url), {
      cwd: this.deps.home,
      timeoutMs: GH_TIMEOUT_MS,
    })
    if (result.failure !== null || result.code !== 0) {
      this.deps.log('warn', `GitHub flow: gh pr view failed: ${describeFailure(result)}`)
      return { failed: true, wanted: FAST_MS }
    }
    let pr: FlowPullRequest
    try {
      pr = mapFlowPullRequest(JSON.parse(result.stdout))
    } catch (error) {
      this.deps.log('warn', `GitHub flow: unexpected gh pr view output: ${messageOf(error)}`)
      return { failed: true, wanted: FAST_MS }
    }
    const wanted = pr.checks.state === 'pending' || pr.mergeable === 'unknown' ? FAST_MS : SLOW_MS
    let told = false
    if (flow.watch) told = await this.watch(state, session, pr)
    if (flow.autoMerge) {
      await this.merge(state, session, pr, told)
    } else if (pr.state === 'merged' || pr.state === 'closed') {
      // Nothing more can happen to watch, so the reads stop.
      const ended = { state: pr.state }
      this.deps.sessions.update(session.sessionId, flow.url, (current) => ({ ...current, ended }))
      this.deps.sessions.setState(session.sessionId, null)
    } else {
      this.deps.sessions.setState(session.sessionId, watchState(pr))
    }
    return { failed: false, wanted }
  }

  /** Tells the agent of what is new on its pull request; true when a message went. */
  private async watch(
    state: RepoState,
    session: FlowSession,
    pr: FlowPullRequest,
  ): Promise<boolean> {
    const { flow } = session
    const { events, quiet } = watchEvents(pr, new Set(flow.seen), flow.baselined === true)
    let told: string[] = []
    if (events.length > 0) {
      const conflicts = events.some((event) => event.kind === 'conflict')
        ? await this.conflictFiles(session.folder, pr)
        : null
      const reviewed = events.filter(
        (event): event is Extract<WatchEvent, { kind: 'review' }> => event.kind === 'review',
      )
      const lineComments =
        reviewed.length > 0
          ? await this.lineComments(state, pr, Math.min(...reviewed.map((e) => e.at)) - 60_000)
          : []
      const message = wakeMessage(pr, events, { conflicts, lineComments })
      if (await this.deps.sessions.tell(session.sessionId, message)) {
        told = events.map((event) => event.key)
        const what = [...new Set(events.map((event) => toldWord(event.kind)))].join(
          t('githubFlow.note.separator'),
        )
        await this.deps.sessions.note(
          session.sessionId,
          'info',
          t('githubFlow.note.told', { number: pr.number, what }),
        )
      }
    }
    this.deps.sessions.update(session.sessionId, flow.url, (current) => ({
      ...current,
      seen: remember(current.seen, [...quiet, ...told]),
      baselined: true,
    }))
    return told.length > 0
  }

  private async merge(
    state: RepoState,
    session: FlowSession,
    pr: FlowPullRequest,
    toldNow: boolean,
  ): Promise<void> {
    const { sessionId, flow } = session
    const info = pr.state === 'open' ? await this.repoInfo(state) : null
    const decision = mergeDecision(pr, {
      busy: session.busy || toldNow,
      readyBefore: state.readyHeads.get(pr.url) ?? null,
      methods: info?.methods ?? null,
    })
    const ready = readyHead(pr)
    if (ready) state.readyHeads.set(pr.url, ready)
    else state.readyHeads.delete(pr.url)
    const end = (ended: NonNullable<StoredPrFlow['ended']>): void => {
      this.deps.sessions.update(sessionId, flow.url, (current) => ({ ...current, ended }))
      this.deps.sessions.setState(sessionId, null)
    }
    if (decision.kind === 'wait') {
      this.deps.sessions.setState(sessionId, decision.state)
      return
    }
    if (decision.kind === 'stop') {
      end({ state: decision.state, ...(decision.message ? { message: decision.message } : {}) })
      if (decision.state === 'merged') {
        await this.deps.sessions.note(
          sessionId,
          'info',
          t('githubFlow.note.mergedElsewhere', { number: pr.number }),
        )
      } else if (decision.state === 'closed') {
        await this.deps.sessions.note(
          sessionId,
          'warning',
          t('githubFlow.note.closed', { number: pr.number }),
        )
      } else {
        await this.deps.sessions.note(
          sessionId,
          'error',
          t('githubFlow.note.mergeFailed', { number: pr.number }),
          decision.message,
        )
      }
      return
    }
    this.deps.sessions.setState(sessionId, 'merging')
    const merged = await mergePullRequest(
      this.deps.exec,
      this.deps.home,
      pr.url,
      decision.method,
      decision.headOid,
    )
    if (!merged.ok) {
      end({ state: 'failed', message: merged.message })
      this.deps.log('warn', `GitHub flow: merging ${pr.url} failed: ${merged.message}`)
      await this.deps.sessions.note(
        sessionId,
        'error',
        t('githubFlow.note.mergeFailed', { number: pr.number }),
        merged.message,
      )
      return
    }
    this.deps.log('info', `GitHub flow: merged ${pr.url} (${decision.method})`)
    end({ state: 'merged' })
    const close = await this.deps.sessions.closeMerged(sessionId, decision.headOid)
    const description = [
      t('githubFlow.note.archived'),
      close.removing
        ? t('githubFlow.note.worktreeRemoved', { branch: close.removing.branch })
        : close.kept
          ? t('githubFlow.note.worktreeKept', { reason: close.kept })
          : null,
    ]
      .filter(Boolean)
      .join(' ')
    await this.deps.sessions.note(
      sessionId,
      'info',
      t('githubFlow.note.merged', { number: pr.number, method: decision.method }),
      description,
    )
    await close.finish()
  }

  /** The files the pull request's head conflicts in with its base, as the folder's git sees them. */
  private async conflictFiles(folder: string, pr: FlowPullRequest): Promise<string[] | null> {
    if (!isBranchName(pr.base)) return null
    const git = (args: string[]) =>
      this.deps.exec('git', args, { cwd: folder, timeoutMs: GIT_TIMEOUT_MS })
    const refs = await git(['for-each-ref', '--format=%(refname)', `refs/remotes/*/${pr.base}`])
    const base = refs.code === 0 ? refs.stdout.split('\n').find((line) => line.trim()) : undefined
    if (!base?.startsWith('refs/remotes/')) return null
    const head =
      /^[0-9a-f]{40}$/.test(pr.headOid) &&
      (await git(['cat-file', '-e', `${pr.headOid}^{commit}`])).code === 0
        ? pr.headOid
        : 'HEAD'
    const merged = await git([
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      base.trim(),
      head,
    ])
    // 1 is a merge with conflicts; anything else is a git without merge-tree's --write-tree.
    if (merged.failure !== null || merged.code !== 1) return null
    const lines = merged.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    return [...new Set(lines.slice(1))]
  }

  private async lineComments(
    state: RepoState,
    pr: FlowPullRequest,
    since: number,
  ): Promise<LineComment[]> {
    const read = await this.rest(state, lineCommentsPath(pr, pr.number, Math.max(0, since)))
    if (!read.ok) return []
    try {
      return mapLineComments(read.json).filter((comment) => comment.author !== pr.author)
    } catch {
      return []
    }
  }

  // Routine triggers

  private async loadCursors(): Promise<Record<string, TriggerCursor>> {
    if (this.cursors) return this.cursors
    this.loading ??= this.deps.file.load().then(
      (file) => {
        this.cursors ??= { ...file.triggers }
      },
      (error: unknown) => {
        this.deps.log('warn', `GitHub flow: could not read its file: ${messageOf(error)}`)
        this.cursors ??= {}
      },
    )
    await this.loading
    return this.cursors ?? {}
  }

  private saveCursors(): void {
    if (!this.cursors) return
    const live = new Set(this.deps.routines.triggers().map((trigger) => trigger.routineId))
    const triggers: Record<string, TriggerCursor> = {}
    for (const [routineId, cursor] of Object.entries(this.cursors)) {
      if (live.has(routineId)) triggers[routineId] = cursor
    }
    this.cursors = triggers
    this.deps.file.save({ version: 1, triggers })
  }

  private async pollTrigger(
    state: RepoState,
    trigger: FlowTrigger,
  ): Promise<{ failed: boolean; wanted: number }> {
    const cursors = await this.loadCursors()
    const signature = JSON.stringify([trigger.projectPath, trigger.event])
    let cursor = cursors[trigger.routineId]
    if (!cursor || cursor.signature !== signature) {
      cursor = { signature, armedAt: this.now(), baselined: false, seen: [] }
      cursors[trigger.routineId] = cursor
    }
    const read = await this.snapshot(state, trigger.event)
    if (!read) {
      this.saveCursors()
      return { failed: true, wanted: SLOW_MS }
    }
    const { fires, quiet } = triggerFires(trigger.event, read.snapshot, cursor)
    const ran: string[] = []
    const first = fires[0]
    if (first && this.deps.routines.idle(trigger.routineId)) {
      this.deps.routines.fire(trigger.routineId, first.cause, first.context)
      ran.push(first.key)
    }
    const next = advanceCursor(cursor, trigger.event, quiet, ran)
    if (JSON.stringify(next) !== JSON.stringify(cursor)) {
      cursors[trigger.routineId] = next
      this.saveCursors()
    }
    return { failed: false, wanted: read.fast ? FAST_MS : SLOW_MS }
  }

  private async snapshot(
    state: RepoState,
    event: GithubEvent,
  ): Promise<{ snapshot: TriggerSnapshot; fast: boolean } | null> {
    const { repo } = state
    try {
      switch (event.kind) {
        case 'issue_opened': {
          const query = new URLSearchParams({
            state: 'open',
            sort: 'created',
            direction: 'desc',
            per_page: '30',
          })
          if (event.label) query.set('labels', event.label)
          const read = await this.rest(state, `${repoPath(repo, 'issues')}?${query}`)
          if (!read.ok) return null
          const issues = mapRestIssues(read.json, repo).map((issue) => ({
            url: issue.url,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            createdAt: issue.createdAt,
            labels: issue.labels.map((label) => label.name),
          }))
          return { snapshot: { kind: 'issue_opened', issues }, fast: false }
        }
        case 'pr_opened': {
          const read = await this.rest(state, pullsPath(repo))
          if (!read.ok) return null
          return {
            snapshot: { kind: 'pr_opened', pulls: mapRestPulls(read.json, repo) },
            fast: false,
          }
        }
        case 'checks_failed': {
          const result = await this.deps.exec('gh', prChecksArgs(repo), {
            cwd: this.deps.home,
            timeoutMs: GH_TIMEOUT_MS,
          })
          if (result.failure !== null || result.code !== 0) return null
          const prs = mapPrChecks(JSON.parse(result.stdout))
          const fast = prs.some((pr) => pr.checks.state === 'pending')
          return { snapshot: { kind: 'checks_failed', prs }, fast }
        }
        case 'pushed': {
          const read = await this.rest(state, refPath(repo, event.branch))
          if (!read.ok) return null
          return {
            snapshot: { kind: 'pushed', branch: event.branch, oid: mapRefOid(read.json) },
            fast: false,
          }
        }
        case 'behind': {
          const info = await this.repoInfo(state)
          const base = info?.defaultBranch
          if (!base || !isBranchName(base)) return null
          const [branchRead, baseRead] = [
            await this.rest(state, refPath(repo, event.branch)),
            await this.rest(state, refPath(repo, base)),
          ]
          if (!branchRead.ok || !baseRead.ok) return null
          const oid = mapRefOid(branchRead.json)
          const baseOid = mapRefOid(baseRead.json)
          if (!oid || !baseOid) {
            return {
              snapshot: { kind: 'behind', branch: event.branch, base, oid, behind: null },
              fast: false,
            }
          }
          let known = state.behind.get(event.branch)
          if (!known || known.oid !== oid || known.baseOid !== baseOid) {
            const compared = await readBehind(
              this.deps.exec,
              this.deps.home,
              repo,
              event.branch,
              base,
            )
            if (!compared.ok) return null
            known = { oid, baseOid, behind: compared.behind }
            state.behind.set(event.branch, known)
          }
          return {
            snapshot: { kind: 'behind', branch: event.branch, base, oid, behind: known.behind },
            fast: false,
          }
        }
      }
    } catch (error) {
      this.deps.log(
        'warn',
        `GitHub flow: reading ${state.key} for a routine failed: ${messageOf(error)}`,
      )
      return null
    }
  }
}

function watchState(pr: FlowPullRequest): PrFlowState | null {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.checks.state === 'failing') return 'checks_failed'
  if (pr.mergeable === 'conflicting') return 'conflict'
  if (pr.review === 'changes_requested') return 'changes_requested'
  return 'waiting'
}

function toldWord(kind: WatchEvent['kind']): string {
  switch (kind) {
    case 'checks_failed':
      return t('githubFlow.note.toldChecks')
    case 'conflict':
      return t('githubFlow.note.toldConflict')
    case 'review':
      return t('githubFlow.note.toldReview')
    case 'comment':
      return t('githubFlow.note.toldComment')
  }
}
