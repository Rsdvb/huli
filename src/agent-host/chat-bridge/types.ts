// Huli: what a chat platform's bridge and the bridge's controller say to each other. Each
// platform's file speaks its protocol and turns it into these; the controller never sees one.

import type { ChatBridgeProblem, ChatPlatform } from '@shared/chat-bridge'
import type { Measure } from './split'

/** A file or picture the user sent, read from the platform only when it is used. */
export interface InboundFile {
  kind: 'image' | 'file'
  name: string
  mimeType: string | null
  /** As the platform said, when it did. */
  size: number | null
  read(): Promise<Buffer>
}

export interface InboundMessage {
  sender: { id: string; name: string }
  /** Where the answer goes: the chat it came from. */
  chatId: string
  /** A one-to-one chat with the bot. */
  direct: boolean
  /** Without the bot's mention; empty when only files came. */
  text: string
  files: InboundFile[]
  /** The bot's message this one answers, by the platform's id for it, when the user quoted one. */
  replyTo: string | null
  /** What a platform needs to answer this message itself, such as QQ's passive reply id. */
  context?: unknown
}

/** A button the user pressed on a card or a keyboard; `data` is what the button was given. */
export interface InboundAction {
  sender: { id: string; name: string }
  chatId: string
  direct: boolean
  data: string
  /** What a platform needs to answer the press, such as a toast. */
  context?: unknown
}

export interface ChatButton {
  label: string
  /** At most 48 ASCII characters, which every platform's button carries back. */
  data: string
  style?: 'primary' | 'danger'
}

/** A message to send: Markdown of the bridge's own kind, buttons in rows, or a file. */
export interface OutboundMessage {
  markdown: string
  buttons?: ChatButton[][]
  file?: { name: string; bytes: Buffer; mimeType: string }
}

export interface ChatTarget {
  chatId: string
  /** The platform's id of the user, for the platforms that write to a user rather than a chat. */
  userId: string
}

/** What a platform can do, as the controller shapes its messages for it. */
export interface ChatCaps {
  /** Buttons that come back as an `InboundAction`. */
  buttons: boolean
  /** Files can be sent. */
  files: boolean
  /** The most one message may hold, as `measure` counts. */
  limit: number
  measure: Measure
}

export interface AdapterEvents {
  message(message: InboundMessage): void
  action(action: InboundAction): void
  /** Connected, or why not; `detail` holds no credential. */
  status(
    state: 'connecting' | 'connected' | 'error',
    problem?: ChatBridgeProblem,
    detail?: string,
  ): void
  /** The bot's own name, once the platform said it. */
  botName(name: string): void
  log(level: 'info' | 'warn' | 'error', message: string): void
}

/** One platform's connection: in, by events; out, by `send`. */
export interface ChatAdapter {
  readonly platform: ChatPlatform
  readonly caps: ChatCaps
  /** Connects, and connects again after a drop, until stopped. */
  start(): void
  stop(): void
  /** Sends one message; the id the platform gave it, when it gave one. */
  send(target: ChatTarget, message: OutboundMessage, context?: unknown): Promise<string | null>
}

/** A platform refused the credentials: connecting again would fail the same way. */
export class CredentialsRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialsRejected'
  }
}
