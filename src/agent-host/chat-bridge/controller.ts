// Huli: one chat platform's conversation with the user's bound accounts: their commands and
// messages to the sessions, the requests that wait for them with their answers, and each finished
// turn's reply. It talks to the agent host only through its own port, as a phone would, so every
// call is checked as a phone's is. Platform-neutral; each platform's file turns its protocol into
// `InboundMessage`s and sends `OutboundMessage`s. See tools/huli/README.md (Chat apps).

import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { AgentStatus, Project, SessionSummary } from '@shared/agent-host'
import type { AttentionFront } from '@shared/host-control'
import type {
  ChatAccount,
  ChatBinding,
  ChatPlatform,
  ChatPlatformConfig,
} from '@shared/chat-bridge'
import { EXPORT_FORMATS } from '@shared/artifact-types'
import type {
  AgentId,
  PendingPermission,
  PermissionOption,
  QuestionAnswer,
  ThreadEntry,
  ToolEntry,
  UserContent,
} from '@shared/thread'
import { isPortError, PortRequestError } from '@shared/port-rpc'
import { admit, BindingGuard } from './access'
import { parseCommand, type ChatCommand } from './commands'
import type { HostClient } from './host-client'
import { MAX_FILE_BYTES } from './net'
import { Pacer, type PaceRules } from './pacing'
import { splitMessage } from './split'
import type {
  ChatAdapter,
  ChatButton,
  ChatTarget,
  InboundAction,
  InboundFile,
  InboundMessage,
  OutboundMessage,
} from './types'
import { t } from '../i18n'

/** What the host told main, which the bridge hears too. */
export interface Attention {
  sessionId: string
  kind: string
  title: string
  body: string
  request?: { id: string }
  front?: AttentionFront
}

export interface ControllerDeps {
  platform: ChatPlatform
  host: HostClient
  config(): ChatPlatformConfig | undefined
  binding(): ChatBinding | null
  /** An account sent the binding's code; main checks it again and keeps the account. */
  bind(code: string, account: Omit<ChatAccount, 'boundAt'>): void
  defaultAgent(): AgentId | null
  pace: PaceRules
  now?: () => number
  log(level: 'info' | 'warn' | 'error', message: string): void
}

/** How many sessions a list shows. */
const LIST_SIZE = 10
/** How many projects and agents `/new` offers. */
const PICK_SIZE = 10
/** How long after the chat last wrote to a session its turns' replies come in whole. */
const FOLLOW_MS = 24 * 60 * 60_000
/** Buttons are remembered this long, and at most this many. */
const BUTTON_TTL_MS = 24 * 60 * 60_000
const MAX_BUTTONS = 500
/** A command's preview in a request, at most. */
const PREVIEW_CHARS = 1500
/** A plan shows at most this much; the rest is in Kite. */
const PLAN_CHARS = 6000

type ButtonAction =
  | { kind: 'option'; sessionId: string; requestId: string; optionId: string }
  | { kind: 'choice'; sessionId: string; requestId: string; choice: number }
  | { kind: 'select'; sessionId: string }
  | { kind: 'get'; index: number }

interface ActiveRequest {
  sessionId: string
  requestId: string
  title: string
  permission: PendingPermission
  /** The question being asked, for an ask of several, and the answers so far. */
  question: number
  answers: QuestionAnswer[]
}

interface Artifact {
  id: string
  title: string
  version: number
}

/** What the bridge keeps of one bound account's chat while it runs. */
interface ChatState {
  account: ChatAccount
  selected: string | null
  /** The sessions of the last list, by their number from 1. */
  listed: string[]
  /** The projects and agents `/new` offered last. */
  projects: (string | null)[]
  agents: AgentId[]
  following: Map<string, number>
  pendingNew: { projectPath: string | null; agentId: AgentId; label: string } | null
  active: ActiveRequest | null
  artifacts: Artifact[]
  /** The bot's messages by the platform's id, with the session each was about. */
  sentAbout: Map<string, string>
}

function errorCode(error: unknown): string | null {
  if (error instanceof PortRequestError) return error.code
  return isPortError(error) ? error.code : null
}

/** A session's name in a line: its title, else its project's folder. */
function sessionName(session: Pick<SessionSummary, 'title' | 'projectPath'>): string {
  return session.title?.trim() || path.basename(session.projectPath) || t('chatBridge.untitled')
}

/** `text` with the characters that would start Markdown taken as themselves. */
export function plain(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1')
}

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text
}

/** The ways out of the finished turn: the reply after its last tool call, and what it made. */
export function finishedTurn(entries: readonly ThreadEntry[]): {
  reply: string
  artifacts: Artifact[]
} {
  let end = entries.length - 1
  while (end >= 0 && entries[end]!.kind !== 'turn_end') end--
  if (end < 0) end = entries.length
  let start = end - 1
  while (
    start >= 0 &&
    !(entries[start]!.kind === 'user' && !(entries[start] as { approval?: boolean }).approval)
  ) {
    start--
  }
  const turn = entries.slice(start + 1, end)
  const lastWork = turn.findLastIndex((entry) => entry.kind === 'tool' || entry.kind === 'subagent')
  const texts = (list: readonly ThreadEntry[]) =>
    list
      .flatMap((entry) =>
        entry.kind === 'agent' && entry.markdown.trim() ? [entry.markdown.trim()] : [],
      )
      .join('\n\n')
  let reply = texts(turn.slice(lastWork + 1))
  if (!reply) {
    const last = turn.findLast((entry) => entry.kind === 'agent' && entry.markdown.trim())
    reply = last?.kind === 'agent' ? last.markdown.trim() : ''
  }
  const artifacts: Artifact[] = []
  for (const entry of turn) {
    if (entry.kind !== 'artifact' || entry.version === null || entry.action === 'delete') continue
    const known = artifacts.findIndex((artifact) => artifact.id === entry.artifactId)
    const artifact = { id: entry.artifactId, title: entry.title, version: entry.version }
    if (known >= 0) artifacts[known] = artifact
    else artifacts.push(artifact)
  }
  return { reply, artifacts }
}

function isPermissionTool(
  entry: ThreadEntry,
  requestId?: string,
): entry is ToolEntry & {
  permission: PendingPermission
} {
  return (
    entry.kind === 'tool' &&
    entry.permission !== null &&
    (requestId === undefined || entry.permission.requestId === requestId)
  )
}

export class ChatController {
  private adapter: ChatAdapter | null = null
  private pacer: Pacer
  private readonly guard = new BindingGuard()
  private readonly chats = new Map<string, ChatState>()
  private readonly buttons = new Map<string, { action: ButtonAction; at: number; chat: string }>()
  private readonly now: () => number

  constructor(private readonly deps: ControllerDeps) {
    this.pacer = new Pacer(deps.pace)
    this.now = deps.now ?? Date.now
  }

  attach(adapter: ChatAdapter): void {
    this.adapter = adapter
  }

  stop(): void {
    this.pacer.stop()
    this.pacer = new Pacer(this.deps.pace)
  }

  /** The accounts changed: a new one is welcomed, a removed one forgotten. */
  accountsChanged(previous: readonly ChatAccount[]): void {
    const accounts = this.deps.config()?.accounts ?? []
    for (const id of [...this.chats.keys()]) {
      if (!accounts.some((account) => account.id === id)) this.chats.delete(id)
    }
    for (const account of accounts) {
      if (previous.some((each) => each.id === account.id)) continue
      const chat = this.chat(account)
      void this.say(
        chat,
        `${t('chatBridge.bound', { name: plain(account.name) })}\n\n${this.helpText()}`,
      )
    }
  }

  // ---- In

  async message(message: InboundMessage): Promise<void> {
    const sender = { platform: this.deps.platform, id: message.sender.id, direct: message.direct }
    const admission = admit(
      this.deps.config(),
      this.deps.binding(),
      this.guard,
      sender,
      message.text,
      this.now(),
    )
    if (admission.kind === 'drop') return
    if (admission.kind === 'bind') {
      this.deps.log('info', 'An account sent the binding code')
      this.deps.bind(admission.code, {
        id: message.sender.id,
        name: clip(message.sender.name || message.sender.id, 64),
        chatId: message.chatId === message.sender.id ? null : message.chatId,
      })
      return
    }
    const chat = this.chat(admission.account)
    try {
      if (message.replyTo) {
        const about = chat.sentAbout.get(message.replyTo)
        if (about && message.text && !message.text.startsWith('/')) chat.selected = about
      }
      const command =
        message.files.length > 0
          ? { kind: 'text' as const, text: message.text }
          : parseCommand(message.text)
      await this.run(chat, command, message.files)
    } catch (error) {
      await this.failed(chat, error)
    }
  }

  async action(action: InboundAction): Promise<void> {
    const config = this.deps.config()
    const sender = { platform: this.deps.platform, id: action.sender.id, direct: action.direct }
    const admission = admit(config, null, this.guard, sender, '', this.now())
    if (admission.kind !== 'account') return
    const chat = this.chat(admission.account)
    const button = this.buttons.get(action.data)
    if (!button || button.chat !== chat.account.id || this.now() - button.at > BUTTON_TTL_MS) {
      await this.say(chat, t('chatBridge.buttonGone'))
      return
    }
    try {
      const { action: what } = button
      switch (what.kind) {
        case 'option':
          await this.respond(chat, what.sessionId, what.requestId, { optionId: what.optionId })
          break
        case 'choice':
          await this.answerChoice(chat, what.sessionId, what.requestId, [what.choice])
          break
        case 'select':
          await this.select(chat, what.sessionId)
          break
        case 'get':
          await this.sendArtifact(chat, what.index)
          break
      }
    } catch (error) {
      await this.failed(chat, error)
    }
  }

  private chat(account: ChatAccount): ChatState {
    let chat = this.chats.get(account.id)
    if (!chat) {
      chat = {
        account,
        selected: null,
        listed: [],
        projects: [],
        agents: [],
        following: new Map(),
        pendingNew: null,
        active: null,
        artifacts: [],
        sentAbout: new Map(),
      }
      this.chats.set(account.id, chat)
    }
    chat.account = account
    return chat
  }

  private target(chat: ChatState): ChatTarget {
    return { chatId: chat.account.chatId ?? chat.account.id, userId: chat.account.id }
  }

  private async run(chat: ChatState, command: ChatCommand, files: InboundFile[]): Promise<void> {
    switch (command.kind) {
      case 'help':
        return this.say(chat, this.helpText())
      case 'list':
        return this.list(chat)
      case 'select': {
        if (command.index === null) return this.current(chat)
        const sessionId = chat.listed[command.index - 1]
        if (!sessionId) return this.say(chat, t('chatBridge.noSuchSession'))
        return this.select(chat, sessionId)
      }
      case 'new':
        return this.newSession(chat, command.project, command.agent)
      case 'stop': {
        const sessionId = chat.selected
        if (!sessionId) return this.say(chat, t('chatBridge.noSession'))
        await this.deps.host.request('sessions.cancel', { sessionId })
        return this.say(chat, t('chatBridge.stopped'))
      }
      case 'now':
        if (!command.text) return this.say(chat, t('chatBridge.nowHint'))
        return this.deliver(chat, [{ type: 'text', text: command.text }], true)
      case 'allow':
      case 'deny':
        return this.answerKind(chat, command.kind)
      case 'pick':
        return this.pick(chat, command.choices, command.note)
      case 'get':
        return this.sendArtifact(chat, command.index)
      case 'status':
        return this.current(chat)
      case 'unknown':
        return this.say(chat, t('chatBridge.unknown', { name: plain(command.name) }))
      case 'text': {
        const active = chat.active
        const question = active?.permission.questions?.[active.question]
        if (
          files.length === 0 &&
          command.text &&
          active &&
          question?.allowsText &&
          !question.secret &&
          (chat.selected === null || chat.selected === active.sessionId)
        ) {
          return this.answerText(chat, command.text)
        }
        const content: UserContent[] = []
        for (const file of files) content.push(await this.attachFile(file))
        if (command.text) content.push({ type: 'text', text: command.text })
        if (content.length === 0) return
        return this.deliver(chat, content, false)
      }
    }
  }

  private helpText(): string {
    return t('chatBridge.help')
  }

  // ---- Sessions

  private async sessions(): Promise<SessionSummary[]> {
    const all = await this.deps.host.request('sessions.list', {})
    return all.filter(
      (session) =>
        session.parentId === null &&
        session.archivedAt === null &&
        session.origin !== 'subagent' &&
        !session.prepared,
    )
  }

  private async agentNames(): Promise<Map<AgentId, string>> {
    const agents = await this.deps.host.request('agents.list', undefined)
    return new Map(agents.map((agent) => [agent.id, agent.name]))
  }

  private stateMark(session: SessionSummary): string {
    if (session.permissionCount > 0) return t('chatBridge.state.waiting')
    if (session.status === 'running' || session.turnStartedAt) return t('chatBridge.state.running')
    if (session.attention === 'error') return t('chatBridge.state.error')
    return t('chatBridge.state.idle')
  }

  private async list(chat: ChatState): Promise<void> {
    const [sessions, names] = await Promise.all([this.sessions(), this.agentNames()])
    const rank = (session: SessionSummary) =>
      session.permissionCount > 0 ? 0 : session.turnStartedAt ? 1 : 2
    const shown = sessions
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
      .slice(0, LIST_SIZE)
    chat.listed = shown.map((session) => session.id)
    if (shown.length === 0) return this.say(chat, t('chatBridge.noSessions'))
    const lines = shown.map((session, i) => {
      const chosen = session.id === chat.selected ? ' ←' : ''
      const agent = names.get(session.agentId) ?? session.agentId
      return `**${i + 1}.** ${plain(sessionName(session))} · ${plain(agent)} · ${this.stateMark(session)}${chosen}`
    })
    const buttons = this.caps().buttons
      ? rows(
          shown.map((session, i) => ({
            label: String(i + 1),
            data: this.button(chat, { kind: 'select', sessionId: session.id }),
          })),
          5,
        )
      : undefined
    await this.say(
      chat,
      `${t('chatBridge.listTitle')}\n${lines.join('\n')}\n\n${t('chatBridge.listHint')}`,
      buttons,
    )
  }

  private async summaryOf(sessionId: string): Promise<SessionSummary | null> {
    return (await this.sessions()).find((session) => session.id === sessionId) ?? null
  }

  private async select(chat: ChatState, sessionId: string): Promise<void> {
    const session = await this.summaryOf(sessionId)
    if (!session) return this.say(chat, t('chatBridge.noSuchSession'))
    chat.selected = sessionId
    chat.pendingNew = null
    chat.following.set(sessionId, this.now())
    const outputs = await this.deps.host
      .request('sessions.outputs', { sessionId })
      .catch(() => null)
    const reply = outputs?.reply ? `\n\n${clip(outputs.reply, 600)}` : ''
    await this.say(
      chat,
      `${t('chatBridge.selected', { title: plain(sessionName(session)), state: this.stateMark(session) })}${reply}`,
    )
    if (session.permissionCount > 0) await this.showWaiting(chat, sessionId, sessionName(session))
  }

  private async current(chat: ChatState): Promise<void> {
    if (!chat.selected) return this.say(chat, t('chatBridge.noSession'))
    const session = await this.summaryOf(chat.selected)
    if (!session) {
      chat.selected = null
      return this.say(chat, t('chatBridge.noSession'))
    }
    await this.say(
      chat,
      t('chatBridge.current', {
        title: plain(sessionName(session)),
        state: this.stateMark(session),
      }),
    )
  }

  private usableAgents(agents: AgentStatus[]): AgentStatus[] {
    return agents.filter(
      (agent) =>
        agent.registered !== false &&
        !agent.uninstalled &&
        !agent.disabled &&
        !agent.hidden &&
        (agent.state === 'ready' || agent.state === 'available' || agent.state === 'starting'),
    )
  }

  private async newSession(
    chat: ChatState,
    project: string | null,
    agent: string | null,
  ): Promise<void> {
    const [projects, agents] = await Promise.all([
      this.deps.host.request('projects.list', undefined),
      this.deps.host.request('agents.list', undefined).then((all) => this.usableAgents(all)),
    ])
    const recent = projects
      .filter((each: Project) => !each.missing)
      .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.lastOpenedAt - a.lastOpenedAt)
      .slice(0, PICK_SIZE)
    if (project === null) {
      chat.projects = recent.map((each) => each.path)
      chat.agents = agents.slice(0, PICK_SIZE).map((each) => each.id)
      const projectLines = [
        `**0.** ${t('chatBridge.noProject')}`,
        ...recent.map((each, i) => `**${i + 1}.** ${plain(each.name)}`),
      ]
      const agentLines = agents
        .slice(0, PICK_SIZE)
        .map((each, i) => `**${i + 1}.** ${plain(each.name)}`)
      return this.say(
        chat,
        `${t('chatBridge.newProjects')}\n${projectLines.join('\n')}\n\n${t('chatBridge.newAgents')}\n${agentLines.join('\n')}\n\n${t('chatBridge.newHint')}`,
      )
    }
    const byWord = (word: string, names: { name: string }[]) =>
      names.findIndex((each) => each.name.toLowerCase() === word.toLowerCase())
    let projectPath: string | null
    let projectLabel: string
    if (project === '0') {
      projectPath = null
      projectLabel = t('chatBridge.noProject')
    } else {
      const n = /^\d+$/.test(project) ? Number(project) - 1 : byWord(project, recent)
      const listed =
        /^\d+$/.test(project) && chat.projects.length > 0 ? chat.projects[n] : recent[n]?.path
      const found =
        recent.find((each) => each.path === listed) ?? projects.find((each) => each.path === listed)
      if (!found) return this.say(chat, t('chatBridge.noSuchProject'))
      projectPath = found.path
      projectLabel = found.name
    }
    let chosen: AgentStatus | undefined
    if (agent) {
      const n = /^\d+$/.test(agent) ? Number(agent) - 1 : byWord(agent, agents)
      const id = /^\d+$/.test(agent) && chat.agents.length > 0 ? chat.agents[n] : agents[n]?.id
      chosen = agents.find((each) => each.id === id)
      if (!chosen) return this.say(chat, t('chatBridge.noSuchAgent'))
    } else {
      const preferred = this.deps.defaultAgent()
      chosen = agents.find((each) => each.id === preferred) ?? agents[0]
      if (!chosen) return this.say(chat, t('chatBridge.noAgents'))
    }
    chat.pendingNew = { projectPath, agentId: chosen.id, label: `${projectLabel} · ${chosen.name}` }
    await this.say(chat, t('chatBridge.newReady', { where: plain(chat.pendingNew.label) }))
  }

  /** Sends what the user wrote: into a new session they asked for, else the chosen one's queue. */
  private async deliver(chat: ChatState, content: UserContent[], now: boolean): Promise<void> {
    const pending = chat.pendingNew
    if (pending) {
      const session = await this.deps.host.request('sessions.create', {
        agentId: pending.agentId,
        projectPath: pending.projectPath,
        prompt: content,
      })
      chat.pendingNew = null
      chat.selected = session.id
      chat.following.set(session.id, this.now())
      return this.say(chat, t('chatBridge.created', { where: plain(pending.label) }))
    }
    const sessionId = chat.selected
    if (!sessionId) return this.say(chat, t('chatBridge.noSession'))
    chat.following.set(sessionId, this.now())
    const { itemId } = await this.deps.host.request('sessions.queue', { sessionId, content })
    if (itemId === null) return this.say(chat, t('chatBridge.sent'))
    if (now) {
      await this.deps.host.request('sessions.sendNow', { sessionId, itemId })
      return this.say(chat, t('chatBridge.steered'))
    }
    await this.say(chat, t('chatBridge.queued'))
  }

  /** A file the user sent, handed to the host as a phone's attachment is. */
  private async attachFile(file: InboundFile): Promise<UserContent> {
    if (file.size !== null && file.size > MAX_FILE_BYTES) {
      throw new ChatRefusal(t('chatBridge.fileTooLarge', { name: plain(file.name) }))
    }
    const bytes = await file.read()
    if (bytes.length > MAX_FILE_BYTES) {
      throw new ChatRefusal(t('chatBridge.fileTooLarge', { name: plain(file.name) }))
    }
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    const attachment = await this.deps.host.request('attachments.add', {
      source: {
        bytes: data,
        mimeType:
          file.mimeType ?? (file.kind === 'image' ? 'image/jpeg' : 'application/octet-stream'),
        name: file.name,
      },
      thumb: null,
    })
    return { type: 'ref', ref: { kind: 'attachment', attachment } }
  }

  // ---- Requests

  /** What waits in a session, shown as its notification would show it. */
  private async showWaiting(chat: ChatState, sessionId: string, title: string): Promise<void> {
    const { entries } = await this.deps.host.request('sessions.requests', { sessionId })
    const first = entries.find((entry) => isPermissionTool(entry))
    if (!first || !isPermissionTool(first)) {
      if (entries.length > 0) await this.say(chat, t('chatBridge.openKite'))
      return
    }
    await this.present(chat, sessionId, title, requestLine(first), first)
  }

  private async present(
    chat: ChatState,
    sessionId: string,
    title: string,
    body: string,
    tool: ToolEntry & { permission: PendingPermission },
  ): Promise<void> {
    const { permission } = tool
    chat.active = {
      sessionId,
      requestId: permission.requestId,
      title,
      permission,
      question: 0,
      answers: [],
    }
    if (permission.elicitation) {
      return this.say(chat, `**${plain(title)}**\n${plain(body)}\n\n${t('chatBridge.openKite')}`)
    }
    if (permission.questions && permission.questions.length > 0) {
      return this.askQuestion(chat)
    }
    const parts = [`**${plain(title)}**`, plain(body)]
    if (permission.plan) parts.push(clip(permission.plan.markdown, PLAN_CHARS))
    else {
      const preview = tool.rawInput?.trim()
      if (preview && tool.toolKind === 'execute')
        parts.push(`\`\`\`\n${clip(preview, PREVIEW_CHARS)}\n\`\`\``)
      else if (tool.locations[0]) parts.push(`\`${plain(tool.locations[0].path)}\``)
    }
    if (permission.reason) parts.push(`_${plain(clip(permission.reason, 300))}_`)
    parts.push(optionLines(permission.options))
    parts.push(t('chatBridge.optionsHint'))
    const buttons = this.caps().buttons
      ? rows(
          permission.options.map((option) => ({
            label: clip(option.name.replace(/`/g, ''), 24),
            data: this.button(chat, {
              kind: 'option',
              sessionId,
              requestId: permission.requestId,
              optionId: option.id,
            }),
            ...(option.kind.startsWith('allow')
              ? { style: 'primary' as const }
              : option.kind.startsWith('reject')
                ? { style: 'danger' as const }
                : {}),
          })),
          2,
        )
      : undefined
    await this.say(chat, parts.join('\n\n'), buttons, sessionId)
  }

  private async askQuestion(chat: ChatState): Promise<void> {
    const active = chat.active!
    const questions = active.permission.questions!
    const question = questions[active.question]!
    const head =
      questions.length > 1
        ? `**${plain(active.title)}** (${active.question + 1}/${questions.length})`
        : `**${plain(active.title)}**`
    if (question.secret) {
      return this.say(
        chat,
        `${head}\n\n${plain(question.question)}\n\n${t('chatBridge.secretQuestion')}`,
      )
    }
    const lines = question.options.map(
      (option, i) =>
        `**${i + 1}.** ${plain(option.label)}${option.description ? ` — ${plain(clip(option.description, 120))}` : ''}`,
    )
    const hints = [
      question.multiSelect ? t('chatBridge.multiHint') : t('chatBridge.choiceHint'),
      ...(question.allowsText ? [t('chatBridge.textHint')] : []),
    ]
    const buttons =
      this.caps().buttons && !question.multiSelect && question.options.length > 0
        ? rows(
            question.options.map((option, i) => ({
              label: clip(option.label, 24),
              data: this.button(chat, {
                kind: 'choice',
                sessionId: active.sessionId,
                requestId: active.requestId,
                choice: i,
              }),
            })),
            2,
          )
        : undefined
    await this.say(
      chat,
      [
        head,
        plain(question.header ? `${question.header}: ${question.question}` : question.question),
        lines.join('\n'),
        hints.join(' '),
      ]
        .filter(Boolean)
        .join('\n\n'),
      buttons,
      active.sessionId,
    )
  }

  /** The request in front, or a line saying there is none. */
  private async inFront(chat: ChatState): Promise<ActiveRequest | null> {
    if (chat.active) return chat.active
    await this.say(chat, t('chatBridge.noRequest'))
    return null
  }

  private async answerKind(chat: ChatState, kind: 'allow' | 'deny'): Promise<void> {
    const active = await this.inFront(chat)
    if (!active) return
    const { options, questions } = active.permission
    if (questions?.length) return this.say(chat, t('chatBridge.answerQuestion'))
    const order =
      kind === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
    const option = order.map((k) => options.find((each) => each.kind === k)).find(Boolean)
    if (!option) return this.say(chat, t('chatBridge.noSuchOption'))
    await this.respond(chat, active.sessionId, active.requestId, { optionId: option.id })
  }

  private async pick(chat: ChatState, choices: number[], note: string): Promise<void> {
    const active = await this.inFront(chat)
    if (!active) return
    const { questions, options } = active.permission
    if (questions?.length) {
      return this.answerChoice(
        chat,
        active.sessionId,
        active.requestId,
        choices.map((n) => n - 1),
        note,
      )
    }
    if (choices.length !== 1) return this.say(chat, t('chatBridge.oneOption'))
    const option = options[choices[0]! - 1]
    if (!option) return this.say(chat, t('chatBridge.noSuchOption'))
    await this.respond(chat, active.sessionId, active.requestId, {
      optionId: option.id,
      ...(note && option.note ? { note } : {}),
    })
  }

  private async answerChoice(
    chat: ChatState,
    sessionId: string,
    requestId: string,
    choices: number[],
    text = '',
  ): Promise<void> {
    const active = chat.active
    if (!active || active.sessionId !== sessionId || active.requestId !== requestId) {
      return this.say(chat, t('chatBridge.buttonGone'))
    }
    const question = active.permission.questions?.[active.question]
    if (!question || question.secret) return this.say(chat, t('chatBridge.secretQuestion'))
    if (choices.some((n) => n < 0 || n >= question.options.length)) {
      return this.say(chat, t('chatBridge.noSuchOption'))
    }
    if (!question.multiSelect && choices.length > 1)
      return this.say(chat, t('chatBridge.oneOption'))
    if (text && !question.allowsText) return this.say(chat, t('chatBridge.noText'))
    return this.nextAnswer(chat, { question: active.question, choices, ...(text ? { text } : {}) })
  }

  private async answerText(chat: ChatState, text: string): Promise<void> {
    const active = chat.active!
    return this.nextAnswer(chat, { question: active.question, choices: [], text })
  }

  private async nextAnswer(chat: ChatState, answer: QuestionAnswer): Promise<void> {
    const active = chat.active!
    active.answers.push(answer)
    if (active.question + 1 < (active.permission.questions?.length ?? 0)) {
      active.question++
      return this.askQuestion(chat)
    }
    await this.respond(chat, active.sessionId, active.requestId, { answers: active.answers })
  }

  private async respond(
    chat: ChatState,
    sessionId: string,
    requestId: string,
    answer: { optionId: string; note?: string } | { answers: QuestionAnswer[] },
  ): Promise<void> {
    try {
      await this.deps.host.request('permissions.respond', { sessionId, requestId, ...answer })
    } catch (error) {
      if (chat.active?.requestId === requestId) chat.active = null
      if (errorCode(error) === 'not_found') return this.say(chat, t('chatBridge.alreadyAnswered'))
      throw error
    }
    if (chat.active?.requestId === requestId) chat.active = null
    chat.following.set(sessionId, this.now())
    await this.say(chat, t('chatBridge.answered'))
  }

  // ---- Out

  /** Something needs the user, as the host told main for its notifications. */
  async attention(attention: Attention): Promise<void> {
    const accounts = this.deps.config()?.accounts ?? []
    for (const account of accounts) {
      const chat = this.chat(account)
      try {
        await this.tell(chat, attention)
      } catch (error) {
        this.deps.log(
          'warn',
          `Could not tell a chat of a ${attention.kind}: ${describeError(error)}`,
        )
      }
    }
  }

  private follows(chat: ChatState, sessionId: string): boolean {
    if (chat.selected === sessionId) return true
    const at = chat.following.get(sessionId)
    return at !== undefined && this.now() - at < FOLLOW_MS
  }

  private async tell(chat: ChatState, attention: Attention): Promise<void> {
    const following = this.follows(chat, attention.sessionId)
    // A request waits until someone answers it, wherever they are; a turn that ended or failed
    // in front of someone at the computer or on a phone was seen there.
    if (attention.kind !== 'permission' && !following && attention.front?.any) return
    const title = attention.title
    switch (attention.kind) {
      case 'permission': {
        if (!attention.request) {
          return this.say(
            chat,
            `**${plain(title)}**\n${plain(attention.body)}`,
            undefined,
            attention.sessionId,
          )
        }
        const { entries } = await this.deps.host.request('sessions.requests', {
          sessionId: attention.sessionId,
        })
        const tool = entries.find((entry) => isPermissionTool(entry, attention.request!.id))
        if (!tool || !isPermissionTool(tool)) {
          // A site, a device or an app to allow: the session's card in Kite answers those.
          return this.say(
            chat,
            `**${plain(title)}**\n${plain(attention.body)}\n\n${t('chatBridge.openKite')}`,
            undefined,
            attention.sessionId,
          )
        }
        return this.present(chat, attention.sessionId, title, attention.body, tool)
      }
      case 'turn-ended':
        if (!following) {
          return this.say(
            chat,
            `${t('chatBridge.turnEnded', { title: plain(title) })}\n${plain(clip(attention.body, 300))}`,
            this.selectButton(chat, attention.sessionId),
            attention.sessionId,
          )
        }
        return this.sendReply(chat, attention.sessionId, title)
      case 'error':
        return this.say(
          chat,
          `${t('chatBridge.turnFailed', { title: plain(title) })}\n${plain(clip(attention.body, 600))}`,
          undefined,
          attention.sessionId,
        )
      case 'stalled':
        return this.say(
          chat,
          `${t('chatBridge.stalled', { title: plain(title) })}\n${plain(clip(attention.body, 300))}`,
          undefined,
          attention.sessionId,
        )
      default:
        return
    }
  }

  private selectButton(chat: ChatState, sessionId: string): ChatButton[][] | undefined {
    if (!this.caps().buttons) return undefined
    return [
      [{ label: t('chatBridge.open'), data: this.button(chat, { kind: 'select', sessionId }) }],
    ]
  }

  /** The finished turn's reply in whole, and what it made. */
  private async sendReply(chat: ChatState, sessionId: string, title: string): Promise<void> {
    const snapshot = await this.deps.host.request('sessions.snapshot', { sessionId })
    const { reply, artifacts } = finishedTurn(snapshot.entries as ThreadEntry[])
    chat.artifacts = artifacts
    const head = t('chatBridge.replyFrom', { title: plain(title) })
    await this.say(
      chat,
      reply ? `${head}\n\n${reply}` : `${head}\n\n${t('chatBridge.noReply')}`,
      undefined,
      sessionId,
    )
    if (artifacts.length === 0) return
    const lines = artifacts.map((artifact, i) => `**${i + 1}.** ${plain(artifact.title)}`)
    const buttons =
      this.caps().buttons && this.caps().files
        ? rows(
            artifacts.map((artifact, i) => ({
              label: clip(artifact.title, 24),
              data: this.button(chat, { kind: 'get', index: i + 1 }),
            })),
            2,
          )
        : undefined
    await this.say(
      chat,
      `${t('chatBridge.artifacts')}\n${lines.join('\n')}\n\n${t('chatBridge.getHint')}`,
      buttons,
      sessionId,
    )
  }

  private async sendArtifact(chat: ChatState, index: number): Promise<void> {
    const artifact = chat.artifacts[index - 1]
    if (!artifact) return this.say(chat, t('chatBridge.noSuchArtifact'))
    if (!this.caps().files) return this.say(chat, t('chatBridge.openKite'))
    const content = await this.deps.host.request('artifacts.read', {
      id: artifact.id,
      version: artifact.version,
    })
    let file: { name: string; bytes: Buffer; mimeType: string } | null = null
    const safe = (
      [...artifact.title]
        .map((char) => (char < ' ' || '\\/:*?"<>|'.includes(char) ? ' ' : char))
        .join('')
        .replace(/\s+/g, ' ')
        .trim() || 'artifact'
    ).slice(0, 80)
    if (content.type) {
      const format = EXPORT_FORMATS[content.type.name].find((each) => each !== 'pdf')
      if (format) {
        const exported = await this.deps.host.request('artifacts.export', {
          id: artifact.id,
          version: content.version,
          format,
        })
        const only = exported.files.length === 1 ? exported.files[0] : undefined
        if (only) {
          file = {
            name: `${safe}.${format}`,
            bytes: Buffer.from(only.bytes),
            mimeType: EXPORT_TYPES[format] ?? 'application/octet-stream',
          }
        }
      }
    } else if (content.files.length === 1) {
      const only = content.files[0]!
      const read = await this.deps.host.request('artifacts.file', {
        id: artifact.id,
        version: content.version,
        path: only.path,
      })
      const extension = path.extname(only.path) || ''
      file = {
        name: `${safe}${extension}`,
        bytes: Buffer.from(read.bytes),
        mimeType: read.type || only.type,
      }
    }
    if (!file) return this.say(chat, t('chatBridge.openKite'))
    if (file.bytes.length > MAX_FILE_BYTES) return this.say(chat, t('chatBridge.openKite'))
    await this.sendMessage(chat, { markdown: '', file })
  }

  // ---- Sending

  private caps() {
    return (
      this.adapter?.caps ?? {
        buttons: false,
        files: false,
        limit: 4000,
        measure: (s: string) => s.length,
      }
    )
  }

  private button(chat: ChatState, action: ButtonAction): string {
    const now = this.now()
    if (this.buttons.size >= MAX_BUTTONS) {
      for (const [key, value] of this.buttons) {
        if (now - value.at > BUTTON_TTL_MS || this.buttons.size >= MAX_BUTTONS)
          this.buttons.delete(key)
        if (this.buttons.size < MAX_BUTTONS * 0.8) break
      }
    }
    const key = `k${randomBytes(9).toString('base64url')}`
    this.buttons.set(key, { action, at: now, chat: chat.account.id })
    return key
  }

  /** Writes `markdown` to the chat, cut to the platform's size; buttons go with the last piece. */
  private async say(
    chat: ChatState,
    markdown: string,
    buttons?: ChatButton[][],
    about?: string,
  ): Promise<void> {
    const caps = this.caps()
    const pieces = splitMessage(markdown, caps.limit, caps.measure, (n) =>
      t('chatBridge.omitted', { count: n }),
    )
    for (const [i, piece] of pieces.entries()) {
      const last = i === pieces.length - 1
      const id = await this.sendMessage(chat, {
        markdown: piece,
        ...(last && buttons ? { buttons } : {}),
      })
      if (id && about) {
        chat.sentAbout.set(id, about)
        if (chat.sentAbout.size > MAX_BUTTONS) {
          chat.sentAbout.delete(chat.sentAbout.keys().next().value!)
        }
      }
    }
  }

  private sendMessage(chat: ChatState, message: OutboundMessage): Promise<string | null> {
    const adapter = this.adapter
    if (!adapter) return Promise.resolve(null)
    const target = this.target(chat)
    return this.pacer.send(target.chatId, () => adapter.send(target, message))
  }

  private async failed(chat: ChatState, error: unknown): Promise<void> {
    const message =
      error instanceof ChatRefusal
        ? error.message
        : errorCode(error) === 'not_found'
          ? t('chatBridge.gone')
          : t('chatBridge.failed', { reason: plain(describeError(error)) })
    if (!(error instanceof ChatRefusal)) {
      this.deps.log('warn', `A chat command failed: ${describeError(error)}`)
    }
    await this.say(chat, message).catch(() => {})
  }
}

/** A refusal the user is told as it is. */
class ChatRefusal extends Error {}

const EXPORT_TYPES: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown',
}

function describeError(error: unknown): string {
  return clip(error instanceof Error ? error.message : String(error), 200)
}

function rows(buttons: ChatButton[], perRow: number): ChatButton[][] {
  const out: ChatButton[][] = []
  for (let i = 0; i < buttons.length; i += perRow) out.push(buttons.slice(i, i + perRow))
  return out
}

function optionLines(options: readonly PermissionOption[]): string {
  return options
    .map((option, i) => `**${i + 1}.** ${plain(option.name.replace(/`/g, ''))}`)
    .join('\n')
}

/** A request's line, as a notification says it, for a request shown again in the chat. */
function requestLine(tool: ToolEntry): string {
  if (tool.question) return tool.question
  return tool.title
}
