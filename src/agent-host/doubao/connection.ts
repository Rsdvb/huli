// Doubao CLI driven one process per turn: `doubao -C <folder> [--resume <id>] -p - --output-format
// stream-json` with the session's model, level and permission mode, the prompt on stdin. The
// process ends with the turn, so Stop ends its process tree, and the next turn resumes the
// conversation. `-p` cannot answer the CLI's own confirmations: it rejects each one by itself and
// names them in the turn's result, so the mode menu says what each mode refuses rather than asks.
// Every run goes through the account's gate (gate.ts), since runs share one service.

import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ConfigOption, StopReason } from '@shared/thread'
import {
  AgentRequestError,
  type AgentConnection,
  type AgentInit,
  type ConnectionHooks,
  type ListedEverywhere,
  type ListedSession,
  type OpenedSession,
  type PromptBlock,
  type PromptResult,
  type SessionOptions,
  type SessionSetup,
  type SessionTarget,
  type SignInClient,
} from '../connection'
import type { HostedContext } from '../driver'
import { t } from '../i18n'
import type { MapperOutput } from '../session-updates'
import {
  AUTH_STATUS_ARGS,
  DEFAULT_MODE,
  LIST_ALL_ARGS,
  LOGIN_ARGS,
  LOGOUT_ARGS,
  MODEL_LIST_ARGS,
  PROMPT_BYTES,
  RUN_ENV,
  exportArgs,
  isMode,
  listArgs,
  turnArgs,
  type Mode,
} from './args'
import { DOUBAO_GATE, type DoubaoGate, type GateUse } from './gate'
import { ConversationIds, newSessionId } from './ids'
import { listedConversation, parseExport, parseListing } from './listing'
import { DoubaoMapper } from './mapper'
import { CONFIG, configOptions, parseModels, startModel, type ModelChoice } from './options'
import { supportedPlatform } from './program'
import type { ResultEvent, StreamEvent } from './protocol'
import { authState, needsSignIn, qrImagePath, SIGN_IN_METHOD, userLine } from './sign-in'

/** How long the account's models are kept before they are read again. */
const MODELS_MAX_AGE_MS = 10 * 60_000
/** When a read of the models that failed is tried again. */
const MODELS_RETRY_MS = 60_000
/** How long a new session waits for the models being read. */
const MODELS_WAIT_MS = 20_000
/** Conversations a page of the listing asks for. */
const LIST_PAGE = 100
/** Pages one listing of a folder reads at most while none of them is the folder's. */
const LIST_RUNS = 5
/** The largest QR code picture Kettu passes on. */
const QR_BYTES = 2 * 1024 * 1024
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
/** The lines of what a run printed for the user that a failure quotes. */
const KEPT_LINES = 6

/**
 * The account's models as last read, which outlive a connection: a read starts Doubao CLI once
 * more, so an agent that starts again shows them while it reads them anew.
 */
let MODELS: { models: ModelChoice[]; due: number } | null = null

interface Turn {
  abort: AbortController
  cancelled: boolean
  /** The entry that says the turn waits for another session's, while it does. */
  queued: string | null
  /** For `collect`: the replies' texts, which go to no thread. */
  texts: string[] | null
}

interface Session {
  id: string
  cwd: string
  /** Doubao's id for the conversation, once its first turn named it. */
  conversation: string | null
  mapper: DoubaoMapper
  /** A listed model's id; null before the account's models are known. */
  model: string | null
  effort: string | null
  mode: Mode
  turn: Turn | null
}

interface RunOptions {
  use: GateUse
  cwd?: string
  input?: string
  signal?: AbortSignal
  /** Each line of stdout as it comes; without it, stdout is kept whole. */
  onLine?(line: string): void
  /** Each line of stderr as it comes. */
  onStderr?(line: string): void
}

interface RunResult {
  stdout: string
  /** What it printed for the user, without its log lines, the latest last. */
  lines: string[]
  code: number | null
  error: string | null
}

/** A run cut off because the turn whose shared service it used ended, which another run fixes. */
function cutOff(run: RunResult): boolean {
  return run.code === 3 || run.lines.some((line) => /共享服务断开|auth_unavailable/.test(line))
}

/** A failed turn's error, from its result: a sign-in it needs, or the CLI's own words. */
export function turnError(result: ResultEvent): AgentRequestError {
  const code = result.error?.code
  const message = (result.errors ?? []).join('\n') || t('doubao.failed')
  if (needsSignIn(code, message)) return new AgentRequestError('auth_required', message)
  return new AgentRequestError('agent_error', message, null, code ? { code } : undefined)
}

/** The error of a read whose output holds no answer: its result's, or what it printed. */
function readError(run: RunResult): AgentRequestError {
  const result = resultOf(run.stdout)
  if (result?.is_error) return turnError(result)
  const message = run.error ?? run.lines.at(-1) ?? t('doubao.exited', { code: run.code ?? 'null' })
  return new AgentRequestError(
    needsSignIn(undefined, message) ? 'auth_required' : 'agent_error',
    message,
  )
}

function resultOf(stdout: string): ResultEvent | null {
  try {
    const value = JSON.parse(stdout.trim()) as unknown
    return typeof value === 'object' && value !== null && (value as ResultEvent).type === 'result'
      ? (value as ResultEvent)
      : null
  } catch {
    return null
  }
}

function fileOf(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  try {
    const { pathname } = new URL(uri)
    const file = decodeURIComponent(pathname)
    // file:///C:/x reads as /C:/x.
    return /^\/[A-Za-z]:\//.test(file) ? file.slice(1) : file
  } catch {
    return uri
  }
}

/** Kettu's prompt as the one text `-p -` reads: its words, and the paths of what it links. */
export function promptText(blocks: readonly PromptBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'resource_link':
        parts.push(` ${fileOf(block.uri)} `)
        break
      case 'resource':
        parts.push(
          `\n<file path="${fileOf(block.resource.uri)}">\n${block.resource.text}\n</file>\n`,
        )
        break
      case 'image':
        // Doubao CLI takes no pictures on stdin; the host offers none, as its capabilities say.
        break
    }
  }
  return parts.join('')
}

/** Same folder, compared as the platform compares paths. */
function samePath(a: string, b: string): boolean {
  const x = path.resolve(a).replace(/[\\/]+$/, '')
  const y = path.resolve(b).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

export class DoubaoConnection implements AgentConnection {
  readonly closed: Promise<void>
  private resolveClosed!: () => void
  private done = false
  private readonly sessions = new Map<string, Session>()
  private readonly targets = new Map<string, SessionTarget>()
  private readonly ids: ConversationIds
  private readonly gate: DoubaoGate
  /** Whether the account is signed in, as last seen; null until known. */
  private signedIn: boolean | null = null
  private modelsRun: Promise<void> | null = null
  /** When a read of the models that failed may run again. */
  private modelsRetry = 0
  private readonly stopping = new AbortController()

  constructor(
    private readonly context: HostedContext,
    gate: DoubaoGate = DOUBAO_GATE,
  ) {
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve))
    this.ids = new ConversationIds(context.kettuDir ?? null)
    this.gate = gate
  }

  get isClosed(): boolean {
    return this.done
  }

  // Doubao CLI deletes no conversation, so a session made for Kettu's own use would stay.
  get hiddenSessions(): boolean {
    return false
  }

  // A session that is only opened runs nothing, so Doubao never hears of it.
  get unpromptedSessions(): boolean {
    return true
  }

  private get hooks(): ConnectionHooks {
    return this.context.hooks
  }

  close(): void {
    if (this.done) return
    this.done = true
    this.stopping.abort(new AgentRequestError('closed', 'Doubao stopped'))
    for (const session of this.sessions.values()) {
      if (session.turn) {
        session.turn.cancelled = true
        session.turn.abort.abort()
      }
    }
    this.resolveClosed()
  }

  initialize(): Promise<AgentInit> {
    if (!supportedPlatform(process.platform, process.arch)) {
      return Promise.reject(new AgentRequestError('agent_error', t('doubao.unsupported')))
    }
    // The models also tell whether the account is signed in.
    void this.refreshModels()
    return Promise.resolve({
      name: t('doubao.name'),
      version: this.context.cliVersion ?? null,
      capabilities: {
        loadSession: true,
        listSessions: true,
        resumeSession: true,
        closeSession: true,
        deleteSession: false,
        forkSession: false,
        forkAtMessage: false,
        ownTitles: 'listed',
        logout: true,
        authStatus: true,
        steering: false,
        mcpHttp: false,
        mcpSse: false,
        mcpStdio: false,
        prompt: { image: false, audio: false, embeddedContext: true },
      },
      authMethods: [
        {
          id: SIGN_IN_METHOD,
          name: t('doubao.auth.qr'),
          description: t('doubao.auth.qrDescription'),
          type: 'agent',
          args: [],
          env: {},
        },
      ],
      raw: { version: this.context.cliVersion ?? null },
    })
  }

  // Running the CLI.

  /** Runs one command line through the gate, as `use` may. */
  private async run(args: readonly string[], options: RunOptions): Promise<RunResult> {
    this.assertOpen()
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.stopping.signal])
      : this.stopping.signal
    const release = await this.gate.enter(options.use, { signal })
    try {
      return await this.spawnRun(args, { ...options, signal })
    } finally {
      release()
    }
  }

  /** A read, tried once more when the end of another run cut it off. */
  private async read(args: readonly string[]): Promise<RunResult> {
    const first = await this.run(args, { use: 'read' })
    return first.code !== 0 && cutOff(first) ? this.run(args, { use: 'read' }) : first
  }

  private spawnRun(args: readonly string[], options: RunOptions): Promise<RunResult> {
    const { spec, env } = this.context
    let child: ChildProcess
    try {
      child = this.context.spawn({
        command: spec.command,
        args: [...spec.args, ...args],
        cwd: options.cwd ?? os.homedir(),
        env: { ...env, ...spec.env, ...RUN_ENV },
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      return Promise.reject(new AgentRequestError('closed', (error as Error).message))
    }
    this.hooks.traffic('out', { command: 'doubao', args })
    return new Promise((resolve) => {
      let stdout = ''
      let partial = ''
      let errPartial = ''
      const lines: string[] = []
      let error: string | null = null
      let settled = false
      const keep = (line: string): void => {
        const text = userLine(line)
        if (text === null) return
        lines.push(text)
        if (lines.length > KEPT_LINES) lines.shift()
      }
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        if (!options.onLine) {
          stdout += chunk
          return
        }
        partial += chunk
        let at: number
        while ((at = partial.indexOf('\n')) >= 0) {
          const line = partial.slice(0, at).trim()
          partial = partial.slice(at + 1)
          if (line) options.onLine(line)
        }
      })
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        errPartial += chunk
        let at: number
        while ((at = errPartial.indexOf('\n')) >= 0) {
          const line = errPartial.slice(0, at)
          errPartial = errPartial.slice(at + 1)
          keep(line)
          options.onStderr?.(line)
        }
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.input ?? '', 'utf8')
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        if (partial.trim() && options.onLine) options.onLine(partial.trim())
        if (errPartial) keep(errPartial)
        resolve({ stdout, lines, code, error })
      }
      child.once('error', (failure) => {
        error = failure.message
        if (child.pid === undefined) finish(null)
      })
      child.once('close', (code) => finish(code))
    })
  }

  // The account.

  private markSignedIn(signedIn: boolean): void {
    if (this.signedIn === signedIn) return
    this.signedIn = signedIn
    this.hooks.account(
      signedIn
        ? { kind: 'account', label: t('doubao.account.plan'), email: null }
        : { kind: 'none', label: '', email: null },
    )
  }

  async readAuthStatus(): Promise<void> {
    const run = await this.read(AUTH_STATUS_ARGS)
    const state = authState([run.stdout, ...run.lines].join('\n'))
    if (state !== 'unknown') this.markSignedIn(state === 'signed-in')
  }

  async authenticate(methodId: string, client?: SignInClient): Promise<void> {
    if (methodId !== SIGN_IN_METHOD) {
      throw new AgentRequestError('agent_error', `Doubao has no sign-in ${methodId}`, -32602)
    }
    let shown: string | null = null
    const show = async (file: string): Promise<void> => {
      const image = await readQr(file)
      if (!image || image === shown || client?.signal.aborted) return
      shown = image
      client?.showImage?.({ mimeType: 'image/png', data: image })
    }
    try {
      // The picture's line may come on either stream; each new code replaces the one before.
      let showing = Promise.resolve()
      const line = (text: string): void => {
        this.gate.atWork()
        const file = qrImagePath(text)
        if (file) showing = showing.then(() => show(file))
      }
      const run = await this.run(LOGIN_ARGS, {
        use: 'turn',
        ...(client ? { signal: client.signal } : {}),
        onLine: line,
        onStderr: line,
      })
      await showing
      if (client?.signal.aborted)
        throw new AgentRequestError('agent_error', t('doubao.auth.cancelled'))
      if (run.code !== 0) throw readError(run)
    } finally {
      if (shown !== null) client?.showImage?.(null)
    }
    this.markSignedIn(true)
    MODELS = null
    void this.refreshModels()
  }

  async logout(): Promise<void> {
    // It stops the account's running tasks too, so it waits for Kettu's.
    const run = await this.run(LOGOUT_ARGS, { use: 'turn' })
    if (run.code !== 0) throw readError(run)
    MODELS = null
    this.markSignedIn(false)
  }

  // The models.

  private refreshModels(force = false): Promise<void> {
    if (this.done) return Promise.resolve()
    if (this.modelsRun) return this.modelsRun
    const now = Date.now()
    if (!force && ((MODELS && now < MODELS.due) || now < this.modelsRetry)) {
      return Promise.resolve()
    }
    this.modelsRun = (async () => {
      const run = await this.read(MODEL_LIST_ARGS)
      const models = run.code === 0 ? parseModels(run.stdout) : null
      if (!models) {
        this.modelsRetry = Date.now() + MODELS_RETRY_MS
        const error = readError(run)
        if (error.kind === 'auth_required') this.markSignedIn(false)
        return
      }
      MODELS = { models, due: Date.now() + MODELS_MAX_AGE_MS }
      this.markSignedIn(true)
      for (const session of this.sessions.values()) {
        if (this.targets.has(session.id)) this.config(session)
      }
    })()
      .catch((error: unknown) => {
        this.modelsRetry = Date.now() + MODELS_RETRY_MS
        if (!this.done) this.hooks.log('warn', `model list failed: ${(error as Error).message}`)
      })
      .finally(() => {
        this.modelsRun = null
      })
    return this.modelsRun
  }

  /** Waits a while for the models being read, so a session starts on the account's own. */
  private async modelsSoon(): Promise<void> {
    const run = this.refreshModels()
    let timer: ReturnType<typeof setTimeout> | null = null
    await Promise.race([
      run,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MODELS_WAIT_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  private get models(): readonly ModelChoice[] {
    return MODELS?.models ?? []
  }

  /** Keeps the session on a listed model, at a level that model has. */
  private settle(session: Session): ModelChoice | null {
    const models = this.models
    const listed = models.find((model) => model.id === session.model)
    const model = listed ?? startModel(models)
    if (!model) return null
    if (!listed) {
      session.model = model.id
      session.effort = model.effort
    } else if (session.effort === null || !model.efforts.includes(session.effort)) {
      session.effort = model.effort
    }
    return model
  }

  private options(session: Session): ConfigOption[] {
    this.settle(session)
    return configOptions(session, this.models)
  }

  private config(session: Session): void {
    this.deliver(session.id, {
      patches: [{ op: 'session.update', changes: { config: this.options(session) } }],
      effects: [],
    })
  }

  // Sessions.

  private open(sessionId: string, cwd: string, conversation: string | null): Session {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.cwd = cwd
      existing.conversation ??= conversation
      return existing
    }
    const session: Session = {
      id: sessionId,
      cwd,
      conversation,
      mapper: new DoubaoMapper(cwd),
      model: null,
      effort: null,
      mode: DEFAULT_MODE,
      turn: null,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  async newSession(cwd: string, options: SessionOptions = {}): Promise<OpenedSession> {
    this.assertOpen()
    if (options.hidden) {
      // Kettu's own read of the options is also how it learns of a sign-in made elsewhere.
      await this.readAuthStatus().catch(() => {})
      if (this.signedIn === false) {
        throw new AgentRequestError('auth_required', t('doubao.signInNeeded'))
      }
    }
    if (MODELS === null) await this.modelsSoon()
    else void this.refreshModels()
    const sessionId = newSessionId()
    const session = this.open(sessionId, cwd, null)
    return { sessionId, config: this.options(session) }
  }

  async resumeSession(sessionId: string, cwd: string): Promise<SessionSetup> {
    this.assertOpen()
    const conversation = await this.ids.conversationOf(sessionId)
    if (MODELS === null) await this.modelsSoon()
    else void this.refreshModels()
    return { config: this.options(this.open(sessionId, cwd, conversation)) }
  }

  /** Opens a conversation again with its history from `--export`, as an import does. */
  async loadSession(sessionId: string, cwd: string): Promise<SessionSetup> {
    this.assertOpen()
    const conversation = await this.ids.conversationOf(sessionId)
    const session = this.open(sessionId, cwd, conversation)
    if (conversation !== null) {
      const run = await this.read(exportArgs(conversation))
      const turns = run.code === 0 ? parseExport(run.stdout) : null
      if (!turns) throw readError(run)
      const target = this.targets.get(sessionId)
      if (target) target.apply(session.mapper.replay(turns, target.context()))
    }
    if (MODELS === null) await this.modelsSoon()
    return { config: this.options(session) }
  }

  forkSession(): Promise<OpenedSession> {
    return Promise.reject(new AgentRequestError('agent_error', 'Doubao CLI has no forks'))
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.turn) {
      session.turn.cancelled = true
      session.turn.abort.abort()
    }
    this.sessions.delete(sessionId)
  }

  deleteSession(): Promise<void> {
    return Promise.reject(new AgentRequestError('agent_error', 'Doubao CLI keeps its sessions'))
  }

  /**
   * The conversations of `cwd`, newest first; one of no folder belongs to the home folder. The
   * listing has every folder's, so pages are read on with `--cursor` until one of `cwd`'s is
   * found, or `LIST_RUNS` of them were read, which the next page goes on from.
   */
  async listSessions(
    cwd: string,
    cursor: string | null,
  ): Promise<{ sessions: ListedSession[]; nextCursor: string | null }> {
    const sessions: ListedSession[] = []
    let next = cursor
    for (let run = 0; run < LIST_RUNS; run++) {
      const page = await this.listing(listArgs(LIST_PAGE, next))
      for (const { sessionId, title, updatedAt, cwd: folder } of page.sessions) {
        if (samePath(folder, cwd)) sessions.push({ sessionId, title, updatedAt, cwd: folder })
      }
      next = page.nextCursor
      if (sessions.length > 0 || next === null) break
    }
    return { sessions, nextCursor: next }
  }

  /** Every unarchived conversation of the account, from every folder and device. */
  async listAllSessions(): Promise<{ sessions: ListedEverywhere[]; nextCursor: string | null }> {
    // `--all` reads every page itself.
    return { sessions: (await this.listing(LIST_ALL_ARGS)).sessions, nextCursor: null }
  }

  private async listing(
    args: readonly string[],
  ): Promise<{ sessions: ListedEverywhere[]; nextCursor: string | null }> {
    this.assertOpen()
    const run = await this.read(args)
    const page = run.code === 0 ? parseListing(run.stdout) : null
    if (!page) {
      const error = readError(run)
      if (error.kind === 'auth_required') this.markSignedIn(false)
      throw error
    }
    this.markSignedIn(true)
    const sessions: ListedEverywhere[] = []
    for (const item of page.conversations) {
      // A session Kettu started is listed under its own id, so it shows as imported already.
      sessions.push(listedConversation(item, await this.ids.sessionOf(item.session_id)))
    }
    return { sessions, nextCursor: page.nextCursor }
  }

  async removeHidden(sessionId: string): Promise<void> {
    await this.closeSession(sessionId)
  }

  register(sessionId: string, target: SessionTarget): void {
    this.targets.set(sessionId, target)
  }

  unregister(sessionId: string, target?: SessionTarget): void {
    if (target && this.targets.get(sessionId) !== target) return
    this.targets.delete(sessionId)
  }

  reopen(): void {}

  rootOf(id: string): string {
    return id
  }

  // Turns.

  async prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult> {
    const session = this.requireSession(sessionId)
    // The stream carries no token counts.
    const stopReason = await this.startTurn(session, promptText(prompt), null)
    return { stopReason, tokens: null, models: [] }
  }

  async collect(sessionId: string, text: string): Promise<string[]> {
    const session = this.requireSession(sessionId)
    const texts: string[] = []
    await this.startTurn(session, text, texts)
    return texts
  }

  private async startTurn(
    session: Session,
    text: string,
    texts: string[] | null,
  ): Promise<StopReason> {
    if (session.turn) throw new AgentRequestError('agent_error', 'A turn is already running')
    if (!text.trim()) throw new AgentRequestError('agent_error', t('doubao.emptyPrompt'))
    if (Buffer.byteLength(text, 'utf8') > PROMPT_BYTES) {
      throw new AgentRequestError('agent_error', t('doubao.promptTooLong'))
    }
    const turn: Turn = { abort: new AbortController(), cancelled: false, queued: null, texts }
    session.turn = turn
    try {
      // Read before the turn holds the gate: a read then would start the service the turn uses.
      if (this.models.length === 0) await this.modelsSoon()
      const signal = AbortSignal.any([turn.abort.signal, this.stopping.signal])
      const release = await this.gate.enter('turn', {
        signal,
        ahead: (count) => this.waiting(session, turn, count),
      })
      this.waiting(session, turn, 0)
      try {
        return await this.runTurn(session, turn, text, signal)
      } finally {
        release()
      }
    } catch (error) {
      if (turn.cancelled) return 'cancelled'
      throw error
    } finally {
      this.waiting(session, turn, 0)
      if (session.turn === turn) session.turn = null
    }
  }

  /** Says, while the turn waits, how many turns of other sessions go first; removes it after. */
  private waiting(session: Session, turn: Turn, ahead: number): void {
    const target = this.targets.get(session.id)
    if (!target) return
    if (ahead <= 0 || turn.cancelled) {
      if (turn.queued === null) return
      const id = turn.queued
      turn.queued = null
      target.apply({ patches: [{ op: 'entry.remove', ids: [id] }], effects: [] })
      return
    }
    const title = t('doubao.queue.title', { count: ahead })
    if (turn.queued !== null) {
      target.apply({
        patches: [{ op: 'entry.update', id: turn.queued, changes: { title } }],
        effects: [],
      })
      return
    }
    const id = target.context().nextId()
    turn.queued = id
    target.apply({
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'notice',
            id,
            severity: 'info',
            title,
            description: t('doubao.queue.description'),
          },
        },
      ],
      effects: [],
    })
  }

  private async runTurn(
    session: Session,
    turn: Turn,
    text: string,
    signal: AbortSignal,
  ): Promise<StopReason> {
    this.settle(session)
    const conversation = session.conversation ?? (await this.ids.conversationOf(session.id))
    session.conversation = conversation
    const args = turnArgs({
      cwd: session.cwd,
      resume: conversation,
      model: session.model,
      effort: session.effort,
      mode: session.mode,
    })
    let result: ResultEvent | null = null
    const run = await this.spawnRun(args, {
      use: 'turn',
      cwd: session.cwd,
      input: text,
      signal,
      onLine: (line) => {
        this.gate.atWork()
        let event: StreamEvent
        try {
          event = JSON.parse(line) as StreamEvent
        } catch {
          this.hooks.ignored(session.id, 'non-JSON line')
          return
        }
        this.hooks.traffic('in', event)
        if (event.type === 'system') {
          if (event.subtype === 'init' && typeof event.session_id === 'string')
            this.bound(session, event.session_id)
          return
        }
        if (event.type === 'result') result = event
        this.event(session, turn, event)
      },
    })
    this.deliver(session.id, session.mapper.finish())
    // The next turn, here or after a restart, resumes the conversation this one named.
    await this.ids.flushed()
    if (turn.cancelled) return 'cancelled'
    const ended = result as ResultEvent | null
    if (ended) {
      if (!ended.is_error) return 'end_turn'
      if (ended.error?.code === 'cancelled') return 'cancelled'
      const error = turnError(ended)
      if (error.kind === 'auth_required') this.markSignedIn(false)
      throw error
    }
    const error = readError(run)
    if (error.kind === 'auth_required') this.markSignedIn(false)
    throw error
  }

  /** The conversation the turn runs in, which Doubao names as the turn starts. */
  private bound(session: Session, conversation: string): void {
    if (session.conversation === conversation) return
    session.conversation = conversation
    void this.ids.remember(session.id, conversation)
  }

  private event(session: Session, turn: Turn, event: StreamEvent): void {
    if (turn.texts) {
      if (event.type === 'assistant') {
        const text = event.message.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('')
        if (text) turn.texts.push(text)
      }
      return
    }
    const target = this.targets.get(session.id)
    if (!target) return
    const output = session.mapper.event(event, target.context())
    if (output) target.apply(output)
    else this.hooks.ignored(session.id, String((event as { type?: unknown }).type))
  }

  async steer(): Promise<'injected' | 'promptRequired'> {
    return 'promptRequired'
  }

  async injectHistory(): Promise<boolean> {
    return false
  }

  async cancel(sessionId: string): Promise<void> {
    const turn = this.sessions.get(sessionId)?.turn
    if (!turn) return
    turn.cancelled = true
    // While it waits, the gate lets it go; while it runs, the host ends its process tree.
    turn.abort.abort()
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.setConfigOption(sessionId, CONFIG.mode, modeId)
  }

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const session = this.requireSession(sessionId)
    if (typeof value !== 'string')
      throw new AgentRequestError('agent_error', `${optionId} takes a choice`)
    switch (optionId) {
      case CONFIG.mode:
        if (!isMode(value)) throw new AgentRequestError('agent_error', `No mode ${value}`)
        // Each turn's command line carries it, so the next turn runs in it.
        session.mode = value
        break
      case CONFIG.model: {
        if (!this.models.some((model) => model.id === value)) await this.refreshModels(true)
        const model = this.models.find((choice) => choice.id === value)
        if (!model) throw new AgentRequestError('agent_error', `No model ${value}`)
        if (session.turn) throw new AgentRequestError('agent_error', 'Change it between turns')
        session.model = model.id
        if (session.effort === null || !model.efforts.includes(session.effort))
          session.effort = model.effort
        break
      }
      case CONFIG.effort: {
        const model = this.settle(session)
        if (!model?.efforts.includes(value)) {
          throw new AgentRequestError('agent_error', `No ${optionId} ${value}`)
        }
        if (session.turn) throw new AgentRequestError('agent_error', 'Change it between turns')
        session.effort = value
        break
      }
      default:
        throw new AgentRequestError('agent_error', `No option ${optionId}`)
    }
    return this.options(session)
  }

  // Helpers.

  private deliver(sessionId: string, output: MapperOutput): void {
    if (output.patches.length === 0 && output.effects.length === 0) return
    this.targets.get(sessionId)?.apply(output)
  }

  private requireSession(sessionId: string): Session {
    this.assertOpen()
    const session = this.sessions.get(sessionId)
    if (!session) throw new AgentRequestError('agent_error', `No session ${sessionId}`, -32002)
    return session
  }

  private assertOpen(): void {
    if (this.done) throw new AgentRequestError('closed', 'Doubao stopped')
  }
}

/** The QR code picture the CLI wrote, as base64; null until it is a whole PNG Kettu may pass on. */
async function readQr(file: string): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const bytes = await readFile(file)
      if (bytes.length > 0 && bytes.length <= QR_BYTES && bytes.subarray(0, 4).equals(PNG)) {
        return bytes.toString('base64')
      }
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}
