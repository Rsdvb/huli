// Huli: a Telegram bot over the Bot API's long polling (getUpdates), which needs no public
// address: https://core.telegram.org/bots/api#getupdates. Its requests go through Kite's own
// proxy, since Telegram cannot be reached from China otherwise. Buttons are inline keyboards,
// whose presses come back as callback queries. See tools/huli/README.md (Chat apps).

import { CREDENTIAL_FIELDS } from '@shared/chat-bridge'
import { addLogSecret } from '@shared/log/process-log'
import { Lifeline, PlatformError } from './lifeline'
import { toPlainText, toTelegramHtml } from './markdown'
import { httpRequest, jsonRequest, MAX_FILE_BYTES, multipart, type Route } from './net'
import { RateLimited } from './pacing'
import { utf16Length } from './split'
import {
  CredentialsRejected,
  type AdapterEvents,
  type ChatAdapter,
  type ChatCaps,
  type ChatTarget,
  type InboundFile,
  type OutboundMessage,
} from './types'

const API = 'https://api.telegram.org'
/** How long one poll waits for an update, in seconds; the request may take a little longer. */
const POLL_S = 50
/** Updates older than this when the bridge starts are not acted on: they were meant for then. */
const STALE_MS = 5 * 60_000

export const TELEGRAM_CAPS: ChatCaps = {
  buttons: true,
  files: true,
  // 4096 characters after the entities are read, which tags and escapes never add to.
  limit: 4000,
  measure: utf16Length,
}

/** Telegram's FAQ: about one message a second to a chat, and 30 a second in all. */
export const TELEGRAM_PACE = { chatGapMs: 1_050, chatPerMinute: 0, gapMs: 40 }

interface TgAnswer<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

interface TgMessage {
  message_id: number
  date: number
  from?: TgUser
  chat: { id: number; type: string }
  text?: string
  caption?: string
  photo?: { file_id: string; file_size?: number; width: number; height: number }[]
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  reply_to_message?: { message_id: number }
}

interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: {
    id: string
    from: TgUser
    data?: string
    message?: { chat: { id: number; type: string } }
  }
}

function nameOf(user: TgUser): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ')
  return full || (user.username ? `@${user.username}` : String(user.id))
}

export class TelegramAdapter implements ChatAdapter {
  readonly platform = 'telegram' as const
  readonly caps = TELEGRAM_CAPS
  private readonly lifeline: Lifeline
  private readonly token: string
  private offset = 0
  private readonly startedAt = Date.now()

  constructor(
    credentials: Readonly<Record<string, string>>,
    private readonly route: Route,
    private readonly events: AdapterEvents,
    private readonly commands: () => { command: string; description: string }[],
  ) {
    this.token = credentials[CREDENTIAL_FIELDS.telegram[0]!.key] ?? ''
    addLogSecret(this.token)
    this.lifeline = new Lifeline((signal) => this.session(signal), events)
  }

  start(): void {
    this.lifeline.start()
  }

  stop(): void {
    this.lifeline.stop()
  }

  private address(method: string): string {
    return `${API}/bot${this.token}/${method}`
  }

  private async call<T>(
    method: string,
    json: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const { status, data } = await jsonRequest<TgAnswer<T>>(this.route, this.address(method), {
      method: 'POST',
      json,
      ...options,
    })
    return this.result(method, status, data)
  }

  private result<T>(method: string, status: number, data: TgAnswer<T> | null): T {
    if (data?.ok) return data.result as T
    const code = data?.error_code ?? status
    if (code === 401 || code === 404)
      throw new CredentialsRejected('Telegram refused the bot token')
    if (code === 429) throw new RateLimited((data?.parameters?.retry_after ?? 1) * 1000)
    if (code === 409) {
      throw new PlatformError(
        "Another program reads this bot's updates, or it has a webhook set",
        'conflict',
      )
    }
    throw new PlatformError(`Telegram's ${method} answered ${code}: ${data?.description ?? ''}`)
  }

  private async session(signal: AbortSignal): Promise<void> {
    const me = await this.call<TgUser>('getMe', {}, { signal })
    this.events.botName(me.username ? `@${me.username}` : nameOf(me))
    void this.call('setMyCommands', { commands: this.commands() }).catch(() => {})
    this.events.status('connected')
    while (!signal.aborted) {
      const updates = await this.call<TgUpdate[]>(
        'getUpdates',
        { offset: this.offset, timeout: POLL_S, allowed_updates: ['message', 'callback_query'] },
        { timeoutMs: (POLL_S + 15) * 1000, signal },
      )
      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1)
        try {
          this.update(update)
        } catch (error) {
          this.events.log('warn', `A Telegram update failed: ${(error as Error).message}`)
        }
      }
    }
  }

  private update(update: TgUpdate): void {
    const query = update.callback_query
    if (query) {
      void this.call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {})
      if (!query.data || !query.message) return
      this.events.action({
        sender: { id: String(query.from.id), name: nameOf(query.from) },
        chatId: String(query.message.chat.id),
        direct: query.message.chat.type === 'private',
        data: query.data,
      })
      return
    }
    const message = update.message
    if (!message?.from || message.from.is_bot) return
    if (message.date * 1000 < this.startedAt - STALE_MS) return
    const files: InboundFile[] = []
    const photo = message.photo?.at(-1)
    if (photo) {
      files.push(
        this.file(
          photo.file_id,
          'image',
          `photo-${message.message_id}.jpg`,
          'image/jpeg',
          photo.file_size ?? null,
        ),
      )
    }
    if (message.document) {
      const { document } = message
      files.push(
        this.file(
          document.file_id,
          document.mime_type?.startsWith('image/') ? 'image' : 'file',
          document.file_name ?? `file-${message.message_id}`,
          document.mime_type ?? null,
          document.file_size ?? null,
        ),
      )
    }
    const words = (message.text ?? message.caption ?? '').trim()
    if (!words && files.length === 0) return
    this.events.message({
      sender: { id: String(message.from.id), name: nameOf(message.from) },
      chatId: String(message.chat.id),
      direct: message.chat.type === 'private',
      text: words,
      files,
      replyTo: message.reply_to_message ? String(message.reply_to_message.message_id) : null,
    })
  }

  private file(
    fileId: string,
    kind: 'image' | 'file',
    name: string,
    mimeType: string | null,
    size: number | null,
  ): InboundFile {
    return {
      kind,
      name,
      mimeType,
      size,
      read: async () => {
        const found = await this.call<{ file_path?: string }>('getFile', { file_id: fileId })
        if (!found.file_path) throw new PlatformError('Telegram gave no file (over 20 MB?)')
        const answer = await httpRequest(
          this.route,
          `${API}/file/bot${this.token}/${found.file_path}`,
          {
            maxBytes: MAX_FILE_BYTES,
            timeoutMs: 120_000,
          },
        )
        if (answer.status !== 200)
          throw new PlatformError(`Telegram answered ${answer.status} for a file`)
        return answer.body
      },
    }
  }

  async send(target: ChatTarget, message: OutboundMessage): Promise<string | null> {
    if (message.file) {
      const { file } = message
      const photo =
        file.mimeType.startsWith('image/') &&
        file.mimeType !== 'image/svg+xml' &&
        file.bytes.length <= 10 * 1024 * 1024
      const form = multipart([
        { name: 'chat_id', value: target.chatId },
        {
          name: photo ? 'photo' : 'document',
          value: { bytes: file.bytes, fileName: file.name, mimeType: file.mimeType },
        },
      ])
      const answer = await httpRequest(
        this.route,
        this.address(photo ? 'sendPhoto' : 'sendDocument'),
        {
          method: 'POST',
          headers: { 'Content-Type': form.contentType },
          body: form.body,
          timeoutMs: 180_000,
        },
      )
      let data: TgAnswer<{ message_id: number }> | null
      try {
        data = JSON.parse(answer.body.toString('utf8')) as TgAnswer<{ message_id: number }>
      } catch {
        data = null
      }
      return String(this.result('sendDocument', answer.status, data).message_id)
    }
    const keyboard = message.buttons?.length
      ? {
          reply_markup: {
            inline_keyboard: message.buttons.map((row) =>
              row.map((button) => ({ text: button.label, callback_data: button.data })),
            ),
          },
        }
      : {}
    const base = {
      chat_id: target.chatId,
      link_preview_options: { is_disabled: true },
      ...keyboard,
    }
    try {
      const sent = await this.call<{ message_id: number }>('sendMessage', {
        ...base,
        text: toTelegramHtml(message.markdown),
        parse_mode: 'HTML',
      })
      return String(sent.message_id)
    } catch (error) {
      // HTML Telegram could not read, as a reply that cuts a tag in two: the words alone then.
      if (
        !(error instanceof PlatformError) ||
        !/parse entities|can't find end/i.test(error.message)
      )
        throw error
      const sent = await this.call<{ message_id: number }>('sendMessage', {
        ...base,
        text: toPlainText(message.markdown),
      })
      return String(sent.message_id)
    }
  }
}
