// One ACP v1 connection to an agent process, through the official SDK.
//
// The host uses the SDK's `unstable` entrypoint: its client validates every
// `session/update` against the schema of the entrypoint before any handler runs, and the
// stable schema has no `subagent_update` or `session_message`, which sub-sessions need.
// Only the unstable features the architecture allows are used (subagents, the prompt
// response's `usage`, and `session/fork` with its fork point in `_meta`); nothing else
// unstable is advertised or called.

import { homedir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AnyMessage,
  type AuthMethod,
  type ClientConnection,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type McpServer as AcpMcpServer,
  type PromptResponse,
  type SessionUpdate,
  type Stream,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk/unstable'
import type { AgentId, ConfigOption, PermissionOption, ToolEntry } from '@shared/thread'
import {
  AgentRequestError,
  optionAnswer,
  type AgentConnection,
  type AgentInit,
  type AuthMethodInfo,
  type ConnectionHooks,
  type ForkPoint,
  type ListedEverywhere,
  type ListedSession,
  type McpServer,
  type OpenedSession,
  type PermissionAnswer,
  type PromptBlock,
  type PromptResult,
  type SessionOptions,
  type SessionSetup,
  type SessionTarget,
  type SignInClient,
} from '../connection'
import { agentEntryBefore } from '../artifacts/entries'
import type { MovedAccounts } from '../catalog'
import type { AgentTransport, MessageTransport } from '../driver'
import { t } from '../i18n'
import { planRevision } from '../plan-revision'
import {
  addEntry,
  isStopReason,
  mergeConfig,
  type MapperContext,
  type MapperOutput,
} from '../session-updates'
import { compareVersions } from '../versions'
import {
  ANTIGRAVITY_TIER_VERSION,
  antigravityTier,
  antigravityTierSignIn,
} from '../vendor-usage/antigravity'
import {
  KNOWN_UPDATES,
  mapAuthStatus,
  mapReportedAuthStatus,
  mapConfig,
  mapModelUsage,
  mapPermissionOptions,
  mapPermissionToolCall,
  mapSessionUpdate,
  mapTokenTotals,
} from './mapper'
import { compactsAgy, sentCompact } from './agy-compact'
import {
  approved,
  buildMode,
  currentMode,
  KEEP_PLANNING,
  MODE_OPTION,
  PLAN_MODE,
  planOptions,
  plansAgy,
  planWrite,
} from './agy-plan'
import {
  FULL_ACCESS,
  HELD_MODE,
  DIR_FLAG_META,
  DIRS_META,
  SESSION_FLAG_META,
  lacks,
  offersFullAccess,
  restoreOrder,
  withFullAccess,
} from './agy-access'
import { systemPromptMeta, takesSystemPromptAppend } from './agy-prompt'
import { AgySubagents, fileBrain, subagentCall, type AgyBrain } from './agy-subagents'
import {
  agyAllowOnce,
  agyAutoAllowed,
  agyQuestion,
  agySummary,
  fromAgy,
  inWholeFile,
  onAgyOwnFiles,
  throughGateway,
} from './agy-tools'
import { fromCodeMode } from './code-mode'
import { forkPointMeta, forksAtMessage } from './fork-point'
import {
  DELETE_AGAIN_MS,
  hiddenRemoval,
  promptsHidden,
  sessionMeta,
  type Removal,
} from './hidden-sessions'
import {
  agyAnswer,
  answerOption,
  formAnswer,
  OTHER_ANSWER,
  pendingElicitation,
  sessionElicitation,
  type SessionElicitation,
} from './elicitation'
import { askedCall, mcpNaming, ownCall, type McpNaming } from './kettu-calls'
import { ownTitles } from './own-titles'
import { DELEGATED_SIGN_IN, delegatedSignInStart, requestUrlElicitation } from './sign-in'

/** A message-level stream to an agent, from a process's stdio or an in-process agent. */
export interface AcpTransport {
  readonly stream: Stream
  close(): void
}

export function processTransport(
  stdin: NodeJS.WritableStream,
  stdout: NodeJS.ReadableStream,
): AcpTransport {
  const stream = ndJsonStream(
    Writable.toWeb(stdin as Writable) as WritableStream<Uint8Array>,
    Readable.toWeb(stdout as Readable) as ReadableStream<Uint8Array>,
  )
  return { stream, close: () => {} }
}

/** Connects an SDK `AgentApp` through an in-memory stream pair, for tests and development. */
export function inProcessTransport(app: AgentApp): AcpTransport & MessageTransport {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>()
  const toClient = new TransformStream<AnyMessage, AnyMessage>()
  const agentConnection = app.connect({ readable: toAgent.readable, writable: toClient.writable })
  return {
    kind: 'messages',
    stream: { readable: toClient.readable, writable: toAgent.writable },
    close: () => agentConnection.close(),
  }
}

/** The words for what the session router reports with a `data.reason`; the agent's own otherwise. */
function routerText(error: RequestError): string {
  const data = error.data as { reason?: unknown; folder?: unknown } | null
  if (data?.reason === 'folder_missing') {
    return t('agent.sessionFolderMissing', { folder: String(data.folder ?? '(none)') })
  }
  if (data?.reason === 'no_session_flag') return t('agent.noSessionFlag')
  return error.message
}

/** The ACP messages over what the launcher gave the driver. */
function acpTransport(transport: AcpTransport | AgentTransport): AcpTransport {
  if ('kind' in transport && transport.kind === 'stdio') {
    return processTransport(transport.stdin, transport.stdout)
  }
  return { stream: transport.stream as Stream, close: () => transport.close() }
}

/** What ACP needs to know of the agent behind it, besides the neutral hooks. */
export interface AcpOptions {
  /** The catalog's agent, whose adapter's `_meta` and hidden-session removal apply. */
  agentId?: AgentId
  /** Its name, for an error about it. */
  name?: string
  /** Accounts its vendor moved to another harness, whose refusal is no sign-in to ask for. */
  movedAccounts?: MovedAccounts
  /** agy's brain folder, where it writes its subagents' work; the user's own unless a test sets it. */
  agyBrain?: AgyBrain
  /** How often a running agy subagent's work is read again, in milliseconds. */
  agyPollMs?: number
}

export type AcpHooks = ConnectionHooks & AcpOptions

const AUTH_REQUIRED = -32000

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: true },
  session: { notices: {}, compaction: {}, configOptions: { boolean: {} } },
  subagents: {},
  // A form or a page a session asks for shows as a card; a sign-in's page opens on the client that
  // asked for the sign-in.
  elicitation: { form: {}, url: {} },
  // Kilo publishes its terminal sign-in command only to a client that advertises this, and Mistral
  // Vibe its sign-in whose page the client opens.
  _meta: { 'terminal-auth': true, [DELEGATED_SIGN_IN]: true },
}

type AuthMethodMeta = {
  type?: unknown
  args?: unknown
  env?: unknown
  'env-var'?: unknown
  'terminal-auth'?: { command?: unknown; args?: unknown } | null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

/** `_meta["terminal-auth"]`'s command, which runs as given rather than after the launch command. */
function namedCommand(meta: AuthMethodMeta | null | undefined): {
  command: string
  args: string[]
} | null {
  const named = meta?.['terminal-auth']
  if (typeof named !== 'object' || named === null) return null
  if (typeof named.command !== 'string' || named.command === '') return null
  return { command: named.command, args: stringList(named.args) }
}

// Agents that take HTTP MCP servers in `session/new` without declaring `mcpCapabilities`, from
// the version checked: agy 1.5.9 discovers, initializes and lists tools with the given headers.
const UNDECLARED_HTTP: Partial<Record<AgentId, string>> = {
  antigravity: '1.5.9',
}

function takesHttpUndeclared(agentId: AgentId | undefined, init: InitializeResponse): boolean {
  const since = agentId ? UNDECLARED_HTTP[agentId] : undefined
  const version = init.agentInfo?.version
  return since !== undefined && typeof version === 'string' && compareVersions(version, since) >= 0
}

/** One of `init.authMethods`, reading the metadata forms agents publish a terminal sign-in in. */
function authMethod(method: AuthMethod): AuthMethodInfo {
  const meta = method._meta as AuthMethodMeta | null | undefined
  const named = namedCommand(meta)
  const declaredType = (method as AuthMethod & { type?: unknown }).type
  const declared = declaredType === 'terminal'
  const envDeclared =
    declaredType === 'env_var' || meta?.type === 'env_var' || meta?.type === 'env-var'
  const terminal = declared || named !== null || meta?.type === 'terminal'
  const declaredArgs = (method as { args?: string[] }).args ?? []
  const args = named?.args ?? (declared ? declaredArgs : stringList(meta?.args))
  const env = declared
    ? { ...((method as { env?: Record<string, string> }).env ?? {}) }
    : stringMap(meta?.env)
  return {
    id: method.id,
    name: method.name,
    ...(method.description ? { description: method.description } : {}),
    type: terminal ? 'terminal' : envDeclared ? 'env' : 'agent',
    ...(named ? { command: named.command } : {}),
    args: terminal ? args : [],
    env: terminal ? env : {},
    ...(envDeclared
      ? {
          envVars: Object.entries(stringMap(meta?.env ?? (method as { env?: unknown }).env)).map(
            ([name, value]) => ({
              name,
              optional: value === 'optional',
            }),
          ),
        }
      : {}),
  }
}

// Updates for a session id nobody registered yet, such as the commands an agent sends right
// after answering `session/new`, wait here for the session to register.
const PENDING_SESSIONS = 32
const PENDING_UPDATES = 2_000
const PENDING_TTL_MS = 60_000
// OpenCode marks a subagent's updates, which it sends on the session the subagent runs under.
const CHILD_SESSION_META = 'opencode/child-session'
const CHILD_SESSIONS = 1_000
// Sessions Kettu closed: their late updates are dropped, not kept for a later register.
const CLOSED_SESSIONS = 256
// Pages opened for a session's elicitation that wait for the agent to say they are done.
const OPEN_PAGES = 64

/** agy's plan files in a session: the calls of this turn that write one, and what they wrote. */
interface AgyPlans {
  calls: Map<string, string>
  written: { toolCallId: string; file: string } | null
  /** The plan an earlier turn wrote, which a rewrite need not mark for review again. */
  last: string | null
}

/** An agy session as it was opened, to start its process again with or without agy's flag. */
interface AgyAccess {
  cwd: string
  options: SessionOptions
  /** Its process runs with the flag. */
  full: boolean
  /** Its options as Kettu last showed them, Full access among them. */
  config: ConfigOption[]
  /** The mode chosen while a turn ran that needs a restart, made once the turn ends. */
  pending: string | null
  /** The restart under way, which the session's next requests wait for. */
  restarting: Promise<void> | null
}

/** A plan agy wrote in a turn, as the entry that shows it. */
interface AgyPlan {
  entryId: string
  toolCallId: string
  file: string
  markdown: string
  options: PermissionOption[]
}

/** Kettu's prompt blocks as ACP content blocks. */
function contentBlocks(prompt: readonly PromptBlock[]): ContentBlock[] {
  return prompt.map((block): ContentBlock => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'image':
        return {
          type: 'image',
          mimeType: block.mimeType,
          data: block.data,
          ...(block.uri !== undefined ? { uri: block.uri } : {}),
        }
      case 'resource_link':
        return {
          type: 'resource_link',
          uri: block.uri,
          name: block.name,
          ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
          ...(block.size !== undefined ? { size: block.size } : {}),
        }
      case 'resource':
        return {
          type: 'resource',
          resource: {
            uri: block.resource.uri,
            mimeType: block.resource.mimeType,
            text: block.resource.text,
          },
        }
    }
  })
}

/** Kettu's MCP servers as ACP's. */
export function mcpServers(servers: readonly McpServer[] | undefined): AcpMcpServer[] {
  return (servers ?? []).map((server): AcpMcpServer => {
    if (server.type === 'stdio') {
      return {
        name: server.name,
        command: server.command,
        args: [...server.args],
        env: server.env.map(({ name, value }) => ({ name, value })),
      }
    }
    return {
      type: server.type,
      name: server.name,
      url: server.url,
      headers: server.headers.map(({ name, value }) => ({ name, value })),
    }
  })
}

export class AcpConnection implements AgentConnection {
  private readonly connection: ClientConnection
  private readonly targets = new Map<string, SessionTarget>()
  private readonly pending = new Map<string, { at: number; updates: SessionUpdate[] }>()
  private readonly unregistered = new Set<string>()
  /** Sessions Kettu runs a report in, which no thread shows. */
  private readonly collectors = new Map<string, (update: SessionUpdate) => void>()
  /** OpenCode's subagent sessions, to the session each runs under. */
  private readonly children = new Map<string, string>()
  /** How its hidden sessions go, once `initialize` has answered. */
  private removal: Removal | null = null
  /** Hidden sessions an agent keeps once prompted: open to read, never to prompt. */
  private readonly unprompted = new Set<string>()
  /** agy's names for the tools each session's MCP servers run without asking. */
  private readonly autoAllowed = new Map<string, ReadonlySet<string>>()
  /** The version the agent named in `initialize`. */
  private version: string | null = null
  /** How the agent names the MCP tools it calls, once `initialize` has answered. */
  private naming: McpNaming | null = null
  /** The sign-in in progress, which the next `authenticate` written out runs for. */
  private signIn: SignInClient | null = null
  /** The sign-in each `authenticate` in flight runs for, by its JSON-RPC id as a string. */
  private readonly signInRequests = new Map<string, SignInClient>()
  /** Huli: the sign-ins whose page is open, by the id of the elicitation that opened it. */
  private readonly signInPages = new Map<string, SignInClient>()
  /** Sessions with a prompt in flight. */
  private readonly prompting = new Set<string>()
  /** agy's plan files, by session. */
  private readonly agyPlans = new Map<string, AgyPlans>()
  /** The mode each agy session was in before it entered Plan mode, which a plan builds in. */
  private readonly agyBuildModes = new Map<string, string>()
  /** agy offers full access, once `initialize` has answered. */
  private fullAccess = false
  /** agy takes a system prompt addition for a new session, once `initialize` has answered. */
  private appendsSystemPrompt = false
  /** Huli: the agent takes ACP's `additionalDirectories`, once `initialize` has answered. */
  private takesDirectories = false
  /** Huli: the session router starts a session's process with each further folder's flag. */
  private routesDirectories = false
  /** Huli: the sessions opened with the project's further folders as workspace roots. */
  private readonly foldered = new Set<string>()
  /** agy's sessions while it offers full access. */
  private readonly agyAccess = new Map<string, AgyAccess>()
  /** Pages a session's elicitation opened, by its id, until the agent says they are done. */
  private readonly openPages = new Map<string, { sessionId: string; entryId: string }>()
  /** agy's subagents, which Kettu reads from its brain folder. */
  private readonly subagents: AgySubagents | null

  private constructor(
    private readonly transport: AcpTransport,
    private readonly hooks: AcpHooks,
  ) {
    this.subagents =
      hooks.agentId === 'antigravity'
        ? new AgySubagents({
            brain: hooks.agyBrain ?? fileBrain(homedir()),
            target: (sessionId) => this.targets.get(sessionId),
            ignored: (sessionId, what) => hooks.ignored(sessionId, what),
            ...(hooks.agyPollMs !== undefined ? { pollMs: hooks.agyPollMs } : {}),
          })
        : null
    const app = client({ name: 'Kettu' })
      .onNotification(methods.client.session.update, (ctx) => {
        this.deliver(ctx.params.sessionId, ctx.params.update)
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const target = this.targets.get(ctx.params.sessionId)
        if (!target) {
          // Never approve without the user: a request for an unknown session is declined.
          hooks.log('warn', `Permission request for unknown session ${ctx.params.sessionId}`)
          return { outcome: { outcome: 'cancelled' } }
        }
        // A call through Kettu's gateway asks and shows as the tool it runs.
        const asked = this.agy ? throughGateway(ctx.params.toolCall) : ctx.params.toolCall
        if (this.agy) {
          // agy asks for every MCP tool; Kettu's own run without asking, as Claude Code's do.
          const optionId = agyAllowOnce(
            asked,
            ctx.params.options,
            this.autoAllowed.get(ctx.params.sessionId),
          )
          if (optionId) return { outcome: { outcome: 'selected', optionId } }
        }
        const shaped = this.agy
          ? await inWholeFile(
              fromAgy(asked),
              (file) => target.readProjectFile?.(file) ?? Promise.resolve(null),
            )
          : ctx.params.toolCall
        const context = target.context()
        const toolCall = askedCall(shaped, this.naming, context)
        const { entryId, output } = mapPermissionToolCall(toolCall, context)
        const answer = await target.requestPermission(
          {
            toolCallId: ctx.params.toolCall.toolCallId,
            toolEntryId: entryId,
            output,
            options: mapPermissionOptions(ctx.params.options),
          },
          ctx.signal,
        )
        const picked = optionAnswer(answer)
        return picked === 'cancelled'
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId: picked.optionId } }
      })
      .onRequest(methods.client.elicitation.create, (ctx) => {
        // A sign-in's page opens on the client that asked for that sign-in.
        const page = requestUrlElicitation(ctx.params)
        const signIn = page ? this.signInRequests.get(page.requestId) : undefined
        if (page && signIn) {
          if (signIn.signal.aborted) return { action: 'cancel' }
          signIn.openLink(page.url)
          const { elicitationId } = ctx.params as { elicitationId?: unknown }
          if (typeof elicitationId === 'string') this.signInPages.set(elicitationId, signIn)
          return { action: 'accept' }
        }
        return this.elicit(ctx.params, ctx.signal)
      })
      // A sign-in's own `authenticate` answers once it is done; a session's page is done here.
      // Huli: a sign-in's page done tells its sign-in, for an agent that never answers it.
      .onNotification(methods.client.elicitation.complete, (ctx) => {
        const signIn = this.signInPages.get(ctx.params.elicitationId)
        this.signInPages.delete(ctx.params.elicitationId)
        if (signIn) signIn.pageDone?.()
        else this.pageDone(ctx.params.elicitationId)
      })
      .onNotification(
        'auth/status_update',
        (params: unknown) => params,
        (ctx) => {
          const status = mapReportedAuthStatus(ctx.params)
          if (!status) hooks.ignored(null, 'auth/status_update with an unknown shape')
          else {
            hooks.authState?.(status.state)
            if (status.account) hooks.account(status.account)
          }
        },
      )
      .onNotification(
        '_auth/status_update',
        (params: unknown) => params,
        (ctx) => {
          const account = mapAuthStatus(ctx.params)
          if (account) hooks.account(account)
          else hooks.ignored(null, '_auth/status_update with an unknown shape')
        },
      )
      .onNotification('*', (ctx) => {
        // `$/cancel_request` is handled by the SDK itself before it reaches here.
        if (!ctx.method.startsWith('$/')) hooks.ignored(null, `notification ${ctx.method}`)
      })
    this.connection = app.connect(this.tap(transport.stream))
    void this.connection.closed.then(() => this.subagents?.forget())
  }

  static connect(transport: AcpTransport | AgentTransport, hooks: AcpHooks): AcpConnection {
    return new AcpConnection(acpTransport(transport), hooks)
  }

  /** Records traffic, and drops update variants the SDK's schema would reject noisily. */
  private tap(stream: Stream): Stream {
    const hooks = this.hooks
    const readable = stream.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform: (message, controller) => {
          hooks.traffic('in', message)
          const variant = unknownVariant(message)
          if (variant) {
            const sessionId = (message as { params: { sessionId?: unknown } }).params.sessionId
            hooks.ignored(
              typeof sessionId === 'string' ? sessionId : null,
              `session update ${variant}`,
            )
            return
          }
          controller.enqueue(message)
        },
      }),
    )
    const writer = stream.writable.getWriter()
    const writable = new WritableStream<AnyMessage>({
      write: (message) => {
        hooks.traffic('out', message)
        if (this.signIn && 'method' in message && message.method === methods.agent.authenticate) {
          if ('id' in message) this.signInRequests.set(String(message.id), this.signIn)
        }
        return writer.write(message)
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    })
    return { readable, writable }
  }

  /**
   * A session's form or page as a card, and agy's questions as the questions card, answered by the
   * user. A request outside a session Kettu has, or one no card can show, is declined.
   */
  private async elicit(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    const raw = params as { sessionId?: unknown; toolCallId?: unknown; mode?: unknown }
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : null
    const target = sessionId ? this.targets.get(sessionId) : undefined
    const asked = target ? sessionElicitation(params, this.agy) : null
    if (!sessionId || !target || !asked) {
      this.hooks.ignored(sessionId, `elicitation/create (${String(raw.mode)}) Kettu cannot show`)
      return { action: 'decline' }
    }
    const ctx = target.context()
    if (asked.kind === 'questions') {
      const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId : null
      return this.askQuestions(target, toolCallId, asked, signal)
    }
    const server = this.hooks.name ?? this.hooks.agentId ?? 'ACP'
    const elicitation = pendingElicitation(asked, server)
    const entryId = ctx.nextId()
    const entry: ToolEntry = {
      kind: 'tool',
      id: entryId,
      title: t(asked.kind === 'url' ? 'elicitation.urlTitle' : 'elicitation.formTitle', { server }),
      toolKind: 'other',
      status: 'pending',
      content: asked.message ? [{ type: 'markdown', markdown: asked.message }] : [],
      locations: [],
      permission: null,
      permissionResult: null,
      elicitation: {
        server,
        kind: asked.kind,
        ...(asked.kind === 'url' ? { url: asked.url } : {}),
      },
    }
    const accept = asked.kind === 'url' ? t('elicitation.open') : t('elicitation.submit')
    let result: CreateElicitationResponse
    try {
      const answer = await target.requestPermission(
        {
          toolCallId: `elicitation:${entryId}`,
          toolEntryId: entryId,
          output: { patches: [{ op: 'entry.add', entry }], effects: [] },
          options: [
            { id: 'accept', name: accept, kind: 'allow_once' },
            { id: 'decline', name: t('elicitation.decline'), kind: 'reject_once' },
          ],
          elicitation,
        },
        signal,
      )
      result = formAnswer(answer)
    } catch {
      result = { action: 'cancel' }
    }
    let status: ToolEntry['status'] = result.action === 'cancel' ? 'cancelled' : 'completed'
    // A page the user opened stays in progress until the agent reports it done.
    if (result.action === 'accept' && asked.kind === 'url') {
      status = 'in_progress'
      this.openPages.set(asked.elicitationId, { sessionId, entryId })
      if (this.openPages.size > OPEN_PAGES) {
        this.openPages.delete(this.openPages.keys().next().value!)
      }
    }
    this.setEntryStatus(sessionId, entryId, status)
    return result
  }

  /**
   * agy's questions on the call that asks them, which the thread shows already, as the questions
   * card; the answers go back as the fields agy reads.
   */
  private async askQuestions(
    target: SessionTarget,
    toolCallId: string | null,
    asked: Extract<SessionElicitation, { kind: 'questions' }>,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    const ctx = target.context()
    const { questions, fields } = asked
    const first = questions[0]!
    const entryId = toolCallId ? `t:${toolCallId}` : ctx.nextId()
    const shown = ctx.thread.byId[entryId]
    const entry: ToolEntry = {
      kind: 'tool',
      id: entryId,
      title: first.question,
      toolKind: 'other',
      status: 'pending',
      content: [],
      locations: [],
      permission: null,
      permissionResult: null,
      question: first.question,
    }
    const output = {
      patches: [
        shown?.kind === 'tool'
          ? {
              op: 'entry.update' as const,
              id: entryId,
              changes: { title: first.question, question: first.question },
            }
          : { op: 'entry.add' as const, entry },
      ],
      effects: [],
    }
    try {
      const answer = await target.requestPermission(
        {
          toolCallId: toolCallId ?? entryId,
          toolEntryId: entryId,
          output,
          options: [
            ...first.options.map((option, index) => ({
              id: answerOption(index),
              name: option.label,
              kind: 'allow_once' as const,
            })),
            { id: OTHER_ANSWER, name: t('question.other'), kind: 'reject_once' as const },
          ],
          questions,
        },
        signal,
      )
      return agyAnswer(fields, answer)
    } catch {
      // Withdrawn: the agent no longer waits for the answer.
      return { action: 'cancel' }
    }
  }

  private pageDone(elicitationId: string): void {
    const page = this.openPages.get(elicitationId)
    if (!page) return
    this.openPages.delete(elicitationId)
    this.setEntryStatus(page.sessionId, page.entryId, 'completed')
  }

  private setEntryStatus(sessionId: string, entryId: string, status: ToolEntry['status']): void {
    const target = this.targets.get(sessionId)
    const entry = target?.context().thread.byId[entryId]
    if (!target || entry?.kind !== 'tool' || entry.status === status) return
    target.apply({
      patches: [{ op: 'entry.update', id: entryId, changes: { status } }],
      effects: [],
    })
  }

  private allowWithoutAsking(sessionId: string, options: SessionOptions): void {
    if (this.agy) this.autoAllowed.set(sessionId, agyAutoAllowed(options.mcpServers))
  }

  /** Whether the agent is agy, whose tool calls take a shape of their own. */
  private get agy(): boolean {
    return this.hooks.agentId === 'antigravity'
  }

  private map(sessionId: string, update: SessionUpdate, ctx: MapperContext): MapperOutput {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
      return mapSessionUpdate(update, ctx)
    }
    // agy's subagent shows as its card, not as the call that started it.
    const subagent = this.subagents ? subagentCall(update) : null
    if (subagent) return this.subagents!.callOutput(sessionId, update, subagent)
    if (this.agy && onAgyOwnFiles(update, ctx)) return { patches: [], effects: [] }
    const shaped = this.agy
      ? fromAgy(throughGateway(update), (id) => this.subagents?.nameOf(id) ?? null)
      : this.naming === 'code'
        ? fromCodeMode(update)
        : update
    const call = ownCall(shaped, this.naming, ctx)
    if (!call) return { patches: [], effects: [] }
    const out = mapSessionUpdate(call, ctx)
    if (this.agy) this.agyRow(update, ctx, out)
    return out
  }

  /**
   * What agy's call carries that ACP has no field for: a question, which stands apart from the
   * work as Claude Code's do even before it is asked, and what a call says it does.
   */
  private agyRow(update: ToolCallUpdate, ctx: MapperContext, out: MapperOutput): void {
    const id = `t:${update.toolCallId}`
    const shown = ctx.thread.byId[id]
    const entry = shown?.kind === 'tool' ? shown : null
    const changes: { question?: string; description?: string } = {}
    const question = agyQuestion(update)
    if (question !== null && entry?.question === undefined) changes.question = question
    const summary = agySummary(update)
    if (summary !== undefined && entry?.description !== summary) changes.description = summary
    if (Object.keys(changes).length > 0) out.patches.push({ op: 'entry.update', id, changes })
  }

  /**
   * After a session applied an update: agy's subagent its call started shows its prompt and work,
   * which Kettu now holds as a session, and one its message woke is read again.
   */
  private afterApply(update: SessionUpdate): void {
    if (!this.subagents) return
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    if (subagentCall(update)) {
      this.subagents.started(update)
      return
    }
    const input = update.rawInput as { Recipient?: unknown } | null | undefined
    if ((update as { name?: unknown }).name === 'send_message') {
      if (typeof input?.Recipient === 'string') this.subagents.messaged(input.Recipient)
    }
  }

  private deliver(sessionId: string, update: SessionUpdate): void {
    this.learnChild(sessionId, update)
    const target = this.targets.get(sessionId)
    if (target) {
      this.notePlanWrite(sessionId, update)
      target.apply(this.withAccess(sessionId, this.map(sessionId, update, target.context())))
      this.afterApply(update)
      return
    }
    const collector = this.collectors.get(sessionId)
    if (collector) {
      collector(update)
      return
    }
    if (this.unregistered.has(sessionId)) {
      this.hooks.ignored(sessionId, 'update for a session Kettu closed')
      return
    }
    const now = Date.now()
    for (const [id, entry] of this.pending) {
      if (now - entry.at > PENDING_TTL_MS) {
        this.pending.delete(id)
        this.hooks.ignored(id, `${entry.updates.length} updates for a session Kettu does not have`)
      }
    }
    let entry = this.pending.get(sessionId)
    if (!entry) {
      if (this.pending.size >= PENDING_SESSIONS) {
        this.hooks.ignored(sessionId, 'update for an unknown session')
        return
      }
      entry = { at: now, updates: [] }
      this.pending.set(sessionId, entry)
    }
    if (entry.updates.length < PENDING_UPDATES) entry.updates.push(update)
  }

  private learnChild(sessionId: string, update: SessionUpdate): void {
    const child = (
      update._meta as Record<string, { id?: unknown } | undefined> | null | undefined
    )?.[CHILD_SESSION_META]
    const id = child?.id
    if (typeof id !== 'string' || id === sessionId || this.children.get(id) === sessionId) {
      return
    }
    this.children.delete(id)
    this.children.set(id, sessionId)
    if (this.children.size > CHILD_SESSIONS) {
      this.children.delete(this.children.keys().next().value!)
    }
  }

  /** The session `id` runs under: its own if Kettu has it, else as OpenCode reported it. */
  rootOf(id: string): string {
    return this.targets.has(id) ? id : (this.children.get(id) ?? id)
  }

  /** Routes a session's updates to `target`, first replaying any that arrived early. */
  register(sessionId: string, target: SessionTarget): void {
    this.targets.set(sessionId, target)
    this.unregistered.delete(sessionId)
    const early = this.pending.get(sessionId)
    if (!early) return
    this.pending.delete(sessionId)
    for (const update of early.updates) {
      target.apply(this.withAccess(sessionId, this.map(sessionId, update, target.context())))
      this.afterApply(update)
    }
  }

  unregister(sessionId: string, target?: SessionTarget): void {
    if (target && this.targets.get(sessionId) !== target) return
    this.targets.delete(sessionId)
    this.pending.delete(sessionId)
    this.agyPlans.delete(sessionId)
    this.agyBuildModes.delete(sessionId)
    this.subagents?.forget(sessionId)
    this.unregistered.add(sessionId)
    if (this.unregistered.size > CLOSED_SESSIONS) {
      this.unregistered.delete(this.unregistered.values().next().value!)
    }
  }

  /** Updates for a session Kettu closed wait for its next register again, like early ones. */
  reopen(sessionId: string): void {
    this.unregistered.delete(sessionId)
  }

  get closed(): Promise<void> {
    return this.connection.closed
  }

  get isClosed(): boolean {
    return this.connection.signal.aborted
  }

  get systemPromptAppend(): boolean {
    return this.appendsSystemPrompt
  }

  close(): void {
    this.connection.close()
    this.transport.close()
  }

  private config(
    options: Parameters<typeof mapConfig>[0],
    modes: Parameters<typeof mapConfig>[1],
  ): ConfigOption[] {
    return mapConfig(options, modes)
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      throw this.toError(error)
    }
  }

  private toError(error: unknown): AgentRequestError {
    if (error instanceof AgentRequestError) return error
    if (error instanceof RequestError) {
      const moved = this.hooks.movedAccounts
      if (moved?.refusal.test(error.message)) {
        this.hooks.accountRefused?.()
        return new AgentRequestError('agent_error', t(moved.refused), error.code, {
          movedTo: moved.to,
          refusal: error.message,
        })
      }
      if (error.code === AUTH_REQUIRED) {
        return new AgentRequestError('auth_required', error.message, error.code, error.data)
      }
      return new AgentRequestError('agent_error', routerText(error), error.code, error.data)
    }
    if (this.connection.signal.aborted) {
      return new AgentRequestError('closed', 'The agent connection closed')
    }
    return new AgentRequestError('agent_error', (error as Error)?.message ?? String(error))
  }

  async initialize(appVersion: string, signal?: AbortSignal): Promise<AgentInit> {
    const init: InitializeResponse = await this.call(() =>
      this.connection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'Kettu', title: 'Kettu', version: appVersion },
          clientCapabilities: CLIENT_CAPABILITIES,
        },
        signal ? { cancellationSignal: signal } : undefined,
      ),
    )
    if (init.protocolVersion !== 1) {
      throw new Error(
        t('agent.protocolVersion', {
          agent: this.hooks.name ?? t('agent.theAgent'),
          version: String(init.protocolVersion),
        }),
      )
    }
    const caps = init.agentCapabilities ?? {}
    const session = caps.sessionCapabilities ?? {}
    const result: AgentInit = {
      protocolVersion: init.protocolVersion,
      name: init.agentInfo?.title ?? init.agentInfo?.name ?? null,
      version: init.agentInfo?.version ?? null,
      capabilities: {
        loadSession: caps.loadSession === true,
        listSessions: session.list != null,
        resumeSession: session.resume != null,
        closeSession: session.close != null,
        deleteSession: session.delete != null,
        forkSession: session.fork != null,
        forkAtMessage: session.fork != null && forksAtMessage(init.agentInfo),
        ownTitles: ownTitles(init.agentInfo),
        logout: caps.auth?.logout != null,
        authStatus: caps.auth?.status != null,
        // `_session/steering`, an extension advertised in the response's own `_meta`.
        steering:
          (init._meta as { steering?: { supported?: unknown } } | null | undefined)?.steering
            ?.supported === true,
        mcpHttp:
          caps.mcpCapabilities?.http === true || takesHttpUndeclared(this.hooks.agentId, init),
        mcpSse: caps.mcpCapabilities?.sse === true,
        // Every ACP agent takes stdio servers; the others it declares.
        mcpStdio: true,
        prompt: {
          image: caps.promptCapabilities?.image === true,
          audio: caps.promptCapabilities?.audio === true,
          embeddedContext: caps.promptCapabilities?.embeddedContext === true,
        },
      },
      authMethods: (init.authMethods ?? []).map(authMethod),
      raw: init.agentCapabilities ?? null,
    }
    this.version = result.version
    this.fullAccess = this.agy && offersFullAccess(result.version, init._meta)
    this.appendsSystemPrompt = this.agy && takesSystemPromptAppend(result.version, caps)
    this.takesDirectories = session.additionalDirectories != null
    this.routesDirectories =
      typeof (init._meta as Record<string, unknown> | null | undefined)?.[DIR_FLAG_META] ===
      'string'
    this.naming = mcpNaming(init.agentInfo)
    this.removal = hiddenRemoval(this.hooks.agentId, result.capabilities, result.version)
    return result
  }

  private meta(options: SessionOptions): Record<string, unknown> | undefined {
    const meta = sessionMeta(this.hooks.agentId, options)
    if (this.takesDirectories || !this.routesDirectories || !options.folders?.length) return meta
    return { ...meta, [DIRS_META]: [...options.folders] }
  }

  /**
   * Huli: the project's further folders as ACP's own field, for an agent that takes it; the
   * session counts as handed them when it takes them either way.
   */
  private directories(
    sessionId: string,
    options: SessionOptions,
  ): { additionalDirectories?: string[] } {
    const folders = options.folders ?? []
    if (folders.length > 0 && (this.takesDirectories || this.routesDirectories)) {
      this.foldered.add(sessionId)
    } else {
      this.foldered.delete(sessionId)
    }
    return this.takesDirectories && folders.length > 0
      ? { additionalDirectories: [...folders] }
      : {}
  }

  /** Huli: whether the session was opened with the project's further folders as its roots. */
  takesFolders(sessionId: string): boolean {
    return this.foldered.has(sessionId)
  }

  async newSession(cwd: string, options: SessionOptions = {}): Promise<OpenedSession> {
    const started = this.meta(options)
    const meta =
      this.appendsSystemPrompt && options.systemPromptAppend
        ? { ...started, ...systemPromptMeta(options.systemPromptAppend) }
        : started
    const dirs = this.takesDirectories && options.folders?.length ? [...options.folders] : null
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: mcpServers(options.mcpServers),
        ...(dirs ? { additionalDirectories: dirs } : {}),
        ...(meta ? { _meta: meta } : {}),
      }),
    )
    this.directories(response.sessionId, options)
    this.readPlan(response._meta)
    this.allowWithoutAsking(response.sessionId, options)
    if (options.hidden && !promptsHidden(this.removal)) this.unprompted.add(response.sessionId)
    return {
      sessionId: response.sessionId,
      config: this.opened(
        response.sessionId,
        cwd,
        options,
        this.config(response.configOptions, response.modes),
      ),
    }
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const meta = this.meta(options)
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers: mcpServers(options.mcpServers),
        ...this.directories(sessionId, options),
        ...(meta ? { _meta: meta } : {}),
      }),
    )
    this.readPlan(response._meta)
    this.allowWithoutAsking(sessionId, options)
    return {
      config: this.opened(
        sessionId,
        cwd,
        options,
        this.config(response.configOptions, response.modes),
      ),
    }
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
  ): Promise<SessionSetup> {
    const meta = this.meta(options)
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: mcpServers(options.mcpServers),
        ...this.directories(sessionId, options),
        ...(meta ? { _meta: meta } : {}),
      }),
    )
    this.readPlan(response._meta)
    this.allowWithoutAsking(sessionId, options)
    return {
      config: this.opened(
        sessionId,
        cwd,
        options,
        this.config(response.configOptions, response.modes),
      ),
    }
  }

  /**
   * `session/fork`, from ACP's unstable schema: a new session that starts from this one, up to
   * `point` for an agent with `forkAtMessage`.
   */
  async forkSession(
    sessionId: string,
    cwd: string,
    options: SessionOptions = {},
    point?: ForkPoint,
  ): Promise<OpenedSession> {
    const meta = this.meta(options)
    const forkMeta = point ? { ...meta, ...forkPointMeta(point) } : meta
    const dirs = this.takesDirectories && options.folders?.length ? [...options.folders] : null
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.fork, {
        sessionId,
        cwd,
        mcpServers: mcpServers(options.mcpServers),
        ...(dirs ? { additionalDirectories: dirs } : {}),
        ...(forkMeta ? { _meta: forkMeta } : {}),
      }),
    )
    this.directories(response.sessionId, options)
    this.allowWithoutAsking(response.sessionId, options)
    return {
      sessionId: response.sessionId,
      config: this.config(response.configOptions, response.modes),
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.call(() => this.connection.agent.request(methods.agent.session.close, { sessionId }))
    this.autoAllowed.delete(sessionId)
    this.agyAccess.delete(sessionId)
    this.foldered.delete(sessionId)
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.call(() =>
      this.connection.agent.request(methods.agent.session.delete, { sessionId }),
    )
    this.autoAllowed.delete(sessionId)
    this.agyAccess.delete(sessionId)
    this.foldered.delete(sessionId)
  }

  async listSessions(
    cwd: string,
    cursor: string | null,
  ): Promise<{ sessions: ListedSession[]; nextCursor: string | null }> {
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.list, {
        cwd,
        ...(cursor ? { cursor } : {}),
      }),
    )
    return {
      sessions: response.sessions.map((info) => ({
        sessionId: info.sessionId,
        title: info.title ?? null,
        updatedAt: info.updatedAt ?? null,
        cwd: info.cwd,
      })),
      nextCursor: response.nextCursor ?? null,
    }
  }

  /** Huli: every folder's sessions, for the import from the agents; ACP makes `cwd` optional. */
  async listAllSessions(
    cursor: string | null,
  ): Promise<{ sessions: ListedEverywhere[]; nextCursor: string | null }> {
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.session.list, cursor ? { cursor } : {}),
    )
    return {
      sessions: response.sessions.map((info) => ({
        sessionId: info.sessionId,
        title: info.title ?? null,
        createdAt: null,
        updatedAt: info.updatedAt ?? null,
        cwd: info.cwd,
        subagent: false,
        prompted: true,
      })),
      nextCursor: response.nextCursor ?? null,
    }
  }

  async prompt(sessionId: string, prompt: readonly PromptBlock[]): Promise<PromptResult> {
    // Prompted, it would stay in the agent's history after its removal.
    if (this.unprompted.has(sessionId)) {
      throw new Error(`${this.hooks.name ?? 'The agent'}'s hidden sessions are never prompted`)
    }
    await this.agyAccess.get(sessionId)?.restarting
    const planning = this.agy && plansAgy(this.version) && this.targets.has(sessionId)
    if (planning) {
      const plans = this.agyPlans.get(sessionId)
      this.agyPlans.set(sessionId, { calls: new Map(), written: null, last: plans?.last ?? null })
    }
    this.prompting.add(sessionId)
    let response: PromptResponse
    try {
      response = await this.call(() =>
        this.connection.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: contentBlocks(prompt),
        }),
      )
    } finally {
      this.prompting.delete(sessionId)
      await this.switchPending(sessionId)
    }
    const result: PromptResult = {
      stopReason: isStopReason(response.stopReason) ? response.stopReason : 'end_turn',
      tokens: mapTokenTotals(response.usage),
      models: mapModelUsage(response._meta),
    }
    if (planning && result.stopReason === 'end_turn') await this.showPlan(sessionId)
    if (this.agy && result.stopReason === 'end_turn' && compactsAgy(this.version)) {
      if (sentCompact(prompt)) this.showCompaction(sessionId)
    }
    return result
  }

  /** The divider for a compaction agy ran without saying so, as the entry every agent gets. */
  private showCompaction(sessionId: string): void {
    const target = this.targets.get(sessionId)
    if (!target) return
    const ctx = target.context()
    const out: MapperOutput = { patches: [], effects: [] }
    addEntry(ctx, out, {
      kind: 'compaction',
      id: `c:${ctx.nextId()}`,
      status: 'completed',
      summary: '',
    })
    target.apply(out)
  }

  /** Notes a call of agy's that writes the session's plan, once it has written it. */
  private notePlanWrite(sessionId: string, update: SessionUpdate): void {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    const plans = this.agyPlans.get(sessionId)
    if (!plans || !this.prompting.has(sessionId)) return
    const file = plans.calls.get(update.toolCallId) ?? planWrite(update, sessionId, plans.last)
    if (file === null) return
    plans.calls.set(update.toolCallId, file)
    if (update.status === 'completed') plans.written = { toolCallId: update.toolCallId, file }
  }

  /**
   * Ends a Plan mode turn that wrote agy's plan with the plan, read from agy's file, as an entry
   * that the user is asked to approve once the turn is over.
   */
  private async showPlan(sessionId: string): Promise<void> {
    const plans = this.agyPlans.get(sessionId)
    const written = plans?.written
    const target = this.targets.get(sessionId)
    if (!plans || !written || !target?.readAgentFile) return
    plans.last = written.file
    const { config } = target.context().thread.session
    if (currentMode(config) !== PLAN_MODE) return
    const options = planOptions(config, [
      this.agyBuildModes.get(sessionId) ?? null,
      target.startMode(),
    ])
    if (!options) return
    const markdown = await target.readAgentFile(written.file)
    if (markdown === null || markdown.trim() === '' || this.targets.get(sessionId) !== target) {
      return
    }
    const ctx = target.context()
    // Its own entry: the call that wrote the file keeps its row when agy asked to write it.
    const entryId = `t:${written.toolCallId}#plan`
    const out: MapperOutput = { patches: [], effects: [] }
    addEntry(ctx, out, {
      kind: 'tool',
      id: entryId,
      title: t('antigravity.plan.title'),
      toolKind: 'switch_mode',
      status: 'completed',
      content: [{ type: 'markdown', markdown }],
      locations: [],
      permission: null,
      permissionResult: null,
      planVersion: planRevision(ctx.thread, entryId).version,
    })
    target.apply(out)
    const plan = { entryId, toolCallId: written.toolCallId, file: written.file, markdown, options }
    // The host ends the turn once the prompt has answered.
    setTimeout(() => void this.proposePlan(sessionId, target, plan), 0)
  }

  /**
   * Asks the user about agy's plan: build in a mode, which switches to it and sends what agy's
   * own terminal sends on approval, or keep planning in Plan mode with a note as the next message.
   */
  private async proposePlan(
    sessionId: string,
    target: SessionTarget,
    plan: AgyPlan,
  ): Promise<void> {
    // A turn that started meanwhile means the user went on without answering.
    if (this.targets.get(sessionId) !== target || this.isClosed || this.prompting.has(sessionId)) {
      return
    }
    let answer: PermissionAnswer
    try {
      answer = await target.requestPermission(
        {
          toolCallId: plan.toolCallId,
          toolEntryId: plan.entryId,
          output: { patches: [], effects: [] },
          options: plan.options,
          plan: plan.markdown,
        },
        // Nothing of agy's waits on the answer; the host settles the request when it must.
        new AbortController().signal,
      )
    } catch {
      return
    }
    const picked = optionAnswer(answer)
    if (picked === 'cancelled') return
    const mode = buildMode(picked.optionId)
    if (mode !== null) {
      try {
        const config = await this.setConfigOption(sessionId, MODE_OPTION, mode)
        target.apply({
          patches: [
            {
              op: 'session.update',
              changes: { config: mergeConfig(target.context().thread.session.config, config) },
            },
          ],
          effects: [],
        })
      } catch (error) {
        // The build still runs, in Plan mode, which asks before each change as Default does.
        this.hooks.log('warn', `Could not switch agy to ${mode}: ${(error as Error).message}`)
      }
      target.send(approved(plan.file), { approval: true })
    } else if (picked.optionId === KEEP_PLANNING && picked.note) {
      target.send(picked.note)
    }
  }

  async collect(sessionId: string, text: string): Promise<string[]> {
    const messages: { id: string | null; text: string }[] = []
    this.pending.delete(sessionId)
    this.collectors.set(sessionId, (update) => {
      if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') return
      const id = update.messageId ?? null
      const last = messages.at(-1)
      if (last && (id === null || last.id === id)) last.text += update.content.text
      else messages.push({ id, text: update.content.text })
    })
    try {
      await this.prompt(sessionId, [{ type: 'text', text }])
    } finally {
      this.collectors.delete(sessionId)
      this.unregister(sessionId)
    }
    return messages.map((message) => message.text)
  }

  /**
   * `_session/steering`: sends a message into the running turn. With `promptRequired`, an agent
   * with no turn running answers so instead of starting one, and the message stays Kettu's.
   */
  async steer(
    sessionId: string,
    prompt: readonly PromptBlock[],
  ): Promise<'injected' | 'promptRequired'> {
    const response = await this.call(() =>
      this.connection.agent.request<{ outcome?: unknown }>('_session/steering', {
        sessionId,
        prompt: contentBlocks(prompt),
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      }),
    )
    if (response?.outcome === 'injected' || response?.outcome === 'promptRequired') {
      return response.outcome
    }
    throw new AgentRequestError(
      'agent_error',
      `Unexpected steering outcome ${JSON.stringify(response?.outcome)}`,
    )
  }

  async cancel(sessionId: string): Promise<void> {
    await this.call(() => this.connection.agent.notify(methods.agent.session.cancel, { sessionId }))
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.call(() =>
      this.connection.agent.request(methods.agent.session.setMode, { sessionId, modeId }),
    )
  }

  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const access = this.agyAccess.get(sessionId)
    if (access) {
      await access.restarting
      if (optionId === MODE_OPTION && typeof value === 'string') {
        const switched = await this.switchAccess(sessionId, access, value)
        if (switched) return switched
      }
    }
    if (this.agy && optionId === MODE_OPTION && value === PLAN_MODE) {
      const config = this.targets.get(sessionId)?.context().thread.session.config ?? []
      const mode = currentMode(config)
      if (mode !== null && mode !== PLAN_MODE) this.agyBuildModes.set(sessionId, mode)
    }
    const config = await this.requestConfig(sessionId, optionId, value)
    if (!access) return config
    access.config = withFullAccess(config, access.full)
    return access.config
  }

  private async requestConfig(
    sessionId: string,
    optionId: string,
    value: string | boolean,
  ): Promise<ConfigOption[]> {
    const response = await this.call(() =>
      this.connection.agent.request(
        methods.agent.session.setConfigOption,
        typeof value === 'boolean'
          ? { sessionId, configId: optionId, type: 'boolean', value }
          : { sessionId, configId: optionId, value },
      ),
    )
    return this.config(response.configOptions, null)
  }

  // agy's full access.

  /**
   * Notes an agy session that was just opened, its process started without the flag, and returns
   * its options with Full access among them.
   */
  private opened(
    sessionId: string,
    cwd: string,
    options: SessionOptions,
    config: ConfigOption[],
  ): ConfigOption[] {
    if (!this.fullAccess) return config
    const shown = withFullAccess(config, false)
    this.agyAccess.set(sessionId, {
      cwd,
      options,
      full: false,
      config: shown,
      pending: null,
      restarting: null,
    })
    return shown
  }

  /** What a session update sets of agy's options, Full access among them and chosen while on. */
  private withAccess(sessionId: string, out: MapperOutput): MapperOutput {
    const access = this.agyAccess.get(sessionId)
    if (!access) return out
    for (const patch of out.patches) {
      if (patch.op !== 'session.update' || !patch.changes.config) continue
      access.config = withFullAccess(patch.changes.config, access.full)
      patch.changes.config = access.config
    }
    return out
  }

  /**
   * A mode chosen in a session that offers full access: entering or leaving it restarts the
   * session's process, at once between turns and once the turn ends during one. Null for any
   * other mode, which agy sets itself, and which replaces a restart still waiting.
   */
  private async switchAccess(
    sessionId: string,
    access: AgyAccess,
    mode: string,
  ): Promise<ConfigOption[] | null> {
    const full = mode === FULL_ACCESS
    if (full === access.full) {
      access.pending = null
      return full ? access.config : null
    }
    if (this.prompting.has(sessionId)) {
      access.pending = mode
      return access.config
    }
    access.pending = null
    return this.restartAgy(sessionId, access, full, mode)
  }

  /** The switch chosen while the turn ran, now that it has ended; a failure goes in the thread. */
  private async switchPending(sessionId: string): Promise<void> {
    const access = this.agyAccess.get(sessionId)
    const mode = access?.pending
    if (!access || !mode) return
    access.pending = null
    const full = mode === FULL_ACCESS
    if (full === access.full || this.isClosed) return
    try {
      const config = await this.restartAgy(sessionId, access, full, mode)
      this.targets.get(sessionId)?.apply({
        patches: [{ op: 'session.update', changes: { config } }],
        effects: [],
      })
    } catch (error) {
      const message = (error as Error).message
      this.hooks.log('warn', `Could not switch agy session ${sessionId} to ${mode}: ${message}`)
      const target = this.targets.get(sessionId)
      if (!target) return
      const ctx = target.context()
      const out: MapperOutput = { patches: [], effects: [] }
      addEntry(ctx, out, {
        kind: 'notice',
        id: ctx.nextId(),
        severity: 'error',
        title: t(
          full ? 'antigravity.fullAccess.enterFailed' : 'antigravity.fullAccess.leaveFailed',
        ),
        description: message,
        after: agentEntryBefore(ctx.thread),
      })
      target.apply(out)
    }
  }

  /**
   * Starts the session's process again, with agy's flag for full access or without it in `mode`,
   * and sets the session's values again. A failure starts it again as it was before it throws.
   */
  private async restartAgy(
    sessionId: string,
    access: AgyAccess,
    full: boolean,
    mode: string,
  ): Promise<ConfigOption[]> {
    const before = { full: access.full, config: access.config }
    const was = currentMode(before.config)
    const run = this.resumeAgy(sessionId, access, full, mode, before.config).catch(
      async (error: unknown) => {
        await this.resumeAgy(
          sessionId,
          access,
          before.full,
          was === null || was === FULL_ACCESS ? HELD_MODE : was,
          before.config,
        ).catch(() => {})
        throw this.toError(error)
      },
    )
    const restarting = run.then(
      () => {},
      () => {},
    )
    access.restarting = restarting
    try {
      return await run
    } finally {
      if (access.restarting === restarting) access.restarting = null
    }
  }

  private async resumeAgy(
    sessionId: string,
    access: AgyAccess,
    full: boolean,
    mode: string,
    values: readonly ConfigOption[],
  ): Promise<ConfigOption[]> {
    const meta = { ...this.meta(access.options), ...(full ? { [SESSION_FLAG_META]: true } : {}) }
    const response = await this.connection.agent.request(methods.agent.session.resume, {
      sessionId,
      cwd: access.cwd,
      mcpServers: mcpServers(access.options.mcpServers),
      ...this.directories(sessionId, access.options),
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    })
    access.full = full
    this.readPlan(response._meta)
    this.allowWithoutAsking(sessionId, access.options)
    let config = this.config(response.configOptions, response.modes)
    for (const option of restoreOrder(values)) {
      if (!lacks(config, option)) continue
      try {
        config = await this.requestConfig(sessionId, option.id, option.value)
      } catch (error) {
        this.hooks.log(
          'warn',
          `agy session ${sessionId} kept ${option.id} after a restart: ${(error as Error).message}`,
        )
      }
    }
    const wanted = full ? HELD_MODE : mode
    if (currentMode(config) !== wanted) {
      config = await this.requestConfig(sessionId, MODE_OPTION, wanted)
    }
    access.config = withFullAccess(config, full)
    return access.config
  }

  async authenticate(methodId: string, client?: SignInClient): Promise<void> {
    const options = client
      ? { cancellationSignal: client.signal, stopWaitingOnCancel: true }
      : undefined
    const request = (meta?: Record<string, unknown>) =>
      this.call(() =>
        this.connection.agent.request(
          methods.agent.authenticate,
          meta ? { methodId, _meta: meta } : { methodId },
          options,
        ),
      )
    this.signIn = client ?? null
    try {
      if (methodId !== DELEGATED_SIGN_IN || !client) {
        this.readPlan((await request())._meta)
        return
      }
      // Mistral Vibe: `start` answers with the page and an attempt; `complete` waits for the
      // browser to finish it.
      const started = delegatedSignInStart(await request({ action: 'start' }))
      if (!started) throw new AgentRequestError('agent_error', t('agent.noSignInPage'))
      client.openLink(started.url)
      await request({ action: 'complete', attemptId: started.attemptId })
    } finally {
      if (this.signIn === client) this.signIn = null
      for (const [id, signIn] of this.signInRequests) {
        if (signIn === client) this.signInRequests.delete(id)
      }
      for (const [id, signIn] of this.signInPages) {
        if (signIn === client) this.signInPages.delete(id)
      }
    }
  }

  async readAuthStatus(): Promise<void> {
    const response = await this.call(() =>
      this.connection.agent.request(methods.agent.auth.status, {}),
    )
    const status = mapReportedAuthStatus(response)
    if (!status) {
      this.hooks.ignored(null, 'auth/status with an unknown shape')
      return
    }
    this.hooks.authState?.(status.state)
    if (status.account) this.hooks.account(status.account)
  }

  /**
   * Google Antigravity names its plan in the `_meta` of its sign-in's and sessions' answers while
   * signed in with Google, and none on an API key or a cloud project; the plan's id shows which
   * Google sign-in it is.
   */
  private readPlan(meta: unknown): void {
    if (this.hooks.agentId !== 'antigravity') return
    if (this.version === null || compareVersions(this.version, ANTIGRAVITY_TIER_VERSION) < 0) return
    const plan = antigravityTier(meta)
    if (plan) this.hooks.account({ kind: 'account', label: plan, email: null })
    this.hooks.signInShown?.(plan ? antigravityTierSignIn(meta) : null)
  }

  async logout(): Promise<void> {
    await this.call(() => this.connection.agent.request(methods.agent.logout, {}))
  }

  /** Sends a vendor-specific ACP extension request on this connection. */
  async request<T>(method: string, params?: unknown): Promise<T> {
    return this.call(() => this.connection.agent.request(method, params ?? {})) as Promise<T>
  }

  get hiddenSessions(): boolean {
    return promptsHidden(this.removal)
  }

  get unpromptedSessions(): boolean {
    return this.removal !== null
  }

  async removeHidden(sessionId: string, log: (message: string) => void): Promise<void> {
    this.unregister(sessionId)
    this.unprompted.delete(sessionId)
    const removal = this.removal
    if (!removal) return
    const failed = (error: unknown): void => {
      if (!this.isClosed) log((error as Error).message)
    }
    if (removal === 'close' || removal === 'close-unprompted') {
      await this.closeSession(sessionId).catch(failed)
      return
    }
    await this.deleteSession(sessionId).catch(failed)
    for (const delay of removal === 'delete-again' ? DELETE_AGAIN_MS : []) {
      setTimeout(() => void this.deleteSession(sessionId).catch(failed), delay).unref()
    }
  }
}

/** The `sessionUpdate` of a `session/update` notification the SDK does not know, or null. */
function unknownVariant(message: AnyMessage): string | null {
  if (!('method' in message) || message.method !== 'session/update' || 'id' in message) return null
  const params = message.params as { update?: { sessionUpdate?: unknown } } | undefined
  const variant = params?.update?.sessionUpdate
  if (typeof variant !== 'string') return null
  return KNOWN_UPDATES.has(variant) ? null : variant
}
