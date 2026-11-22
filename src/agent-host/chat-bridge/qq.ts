// Huli: a QQ bot of QQ's open platform over its WebSocket gateway, which needs no public address
// and which the platform recommends for one computer (https://bot.q.qq.com/wiki/ §8.1; the
// protocol: https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html).
// Only one-to-one chats (C2C) are read. A reply goes as a passive one to the user's last message
// while QQ allows it, else as an active message, which QQ counts per user and day. Buttons need
// QQ's approval for a keyboard, so the user answers with text commands. See tools/huli/README.md
// (Chat apps).

import { CREDENTIAL_FIELDS } from '@shared/chat-bridge'
import { addLogSecret } from '@shared/log/process-log'
import { aborted, Lifeline, PlatformError } from './lifeline'
import { toPlainText, withoutEscapes } from './markdown'
import { httpRequest, jsonRequest, MAX_FILE_BYTES, openSocket, type Route } from './net'
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

const API = 'https://api.bot.qq.com'
/** One-to-one and group events; the bridge reads the one-to-one ones. */
const INTENTS = 1 << 25
/** A passive reply's window and count, by QQ's message rules for C2C. */
const PASSIVE_MS = 55 * 60_000
const PASSIVE_REPLIES = 4
const TOKEN_MARGIN_MS = 2 * 60_000

export const QQ_CAPS: ChatCaps = { buttons: false, files: false, limit: 2000, measure: utf16Length }

/** QQ's limits on active messages: 20 a minute to one user. */
export const QQ_PACE = { chatGapMs: 400, chatPerMinute: 20, gapMs: 120 }

interface Payload {
  op: number
  d?: unknown
  s?: number | null
  t?: string | null
  id?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Close codes after which connecting again cannot help: the bot was taken down or banned. */
const FATAL_CLOSES = new Set([4914, 4915])
/** Close codes after which the session cannot be resumed. */
const FRESH_CLOSES = new Set([
  4006, 4007, 4009, 4900, 4901, 4902, 4903, 4904, 4905, 4906, 4907, 4908, 4909, 4910, 4911, 4912,
  4913,
])

export class QqAdapter implements ChatAdapter {
  readonly platform = 'qq' as const
  readonly caps = QQ_CAPS
  private readonly lifeline: Lifeline
  private readonly appId: string
  private readonly secret: string
  private token: { value: string; until: number } | null = null
  private gateway: string | null = null
  private resume: { sessionId: string; seq: number } | null = null
  /** Each user's last message, which passive replies answer. */
  private readonly lastFrom = new Map<string, { msgId: string; at: number; replies: number }>()
  private readonly seen = new Set<string>()

  constructor(
    credentials: Readonly<Record<string, string>>,
    private readonly route: Route,
    private readonly events: AdapterEvents,
  ) {
    const [id, secret] = CREDENTIAL_FIELDS.qq
    this.appId = credentials[id!.key] ?? ''
    this.secret = credentials[secret!.key] ?? ''
    addLogSecret(this.secret)
    this.lifeline = new Lifeline((signal) => this.session(signal), events)
  }

  start(): void {
    this.lifeline.start()
  }

  stop(): void {
    this.lifeline.stop()
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value
    const { data } = await jsonRequest<{
      access_token?: string
      expires_in?: string | number
      code?: number
      message?: string
    }>(this.route, `${API}/app/getAppAccessToken`, {
      method: 'POST',
      json: { appId: this.appId, clientSecret: this.secret },
    })
    if (!data?.access_token) {
      const code = data?.code
      if (code === 100007 || code === 100016 || code === 10004) {
        throw new CredentialsRejected(
          `QQ refused the bot's credentials (${code}: ${data?.message ?? ''})`,
        )
      }
      if (code === 100001) throw new RateLimited(60_000)
      throw new PlatformError(`QQ gave no token (${code ?? '?'}: ${data?.message ?? ''})`)
    }
    addLogSecret(data.access_token)
    const ttl = Number(data.expires_in ?? 7200) * 1000
    this.token = {
      value: data.access_token,
      until: Date.now() + Math.max(ttl - TOKEN_MARGIN_MS, 60_000),
    }
    return data.access_token
  }

  private async api<T>(method: 'GET' | 'POST', address: string, json?: unknown): Promise<T> {
    const token = await this.accessToken()
    const { status, data } = await jsonRequest<T & { code?: number; message?: string }>(
      this.route,
      `${API}${address}`,
      {
        method,
        headers: { Authorization: `QQBot ${token}` },
        ...(json === undefined ? {} : { json }),
      },
    )
    if (status === 401) this.token = null
    if (status === 429 || data?.code === 40034100) throw new RateLimited(60_000)
    if (status < 200 || status > 299 || (typeof data?.code === 'number' && data.code !== 0)) {
      throw new PlatformError(`QQ answered ${data?.code ?? status}: ${data?.message ?? ''}`)
    }
    return data as T
  }

  private async session(signal: AbortSignal): Promise<void> {
    const token = await this.accessToken()
    // The gateway's address may be asked twice a minute; it stays the same between connections.
    if (!this.gateway) {
      this.gateway = text((await this.api<{ url?: string }>('GET', '/gateway')).url) || null
    }
    if (!this.gateway) throw new PlatformError('QQ gave no gateway', 'network')
    const socket = await openSocket(this.route, this.gateway)
    let heartbeat: NodeJS.Timeout | null = null
    let seq: number | null = this.resume?.seq ?? null
    let closeCode = 0
    const send = (payload: Payload) => {
      try {
        socket.send(JSON.stringify(payload))
      } catch {
        // Closing; the close says what happened.
      }
    }
    socket.on('message', (raw, binary) => {
      if (binary) return
      let payload: Payload
      try {
        payload = JSON.parse(raw.toString()) as Payload
      } catch {
        return
      }
      if (typeof payload.s === 'number') seq = payload.s
      switch (payload.op) {
        case 10: {
          const interval = isRecord(payload.d) ? Number(payload.d.heartbeat_interval) : 45_000
          const beat = () => {
            send({ op: 1, d: seq })
            heartbeat = setTimeout(
              beat,
              Number.isFinite(interval) && interval > 1000 ? interval : 45_000,
            )
          }
          heartbeat = setTimeout(
            beat,
            Number.isFinite(interval) && interval > 1000 ? interval : 45_000,
          )
          if (this.resume) {
            send({
              op: 6,
              d: {
                token: `QQBot ${token}`,
                session_id: this.resume.sessionId,
                seq: this.resume.seq,
              },
            })
          } else {
            send({
              op: 2,
              d: { token: `QQBot ${token}`, intents: INTENTS, shard: [0, 1], properties: {} },
            })
          }
          return
        }
        case 0:
          this.dispatch(payload)
          if (payload.t === 'READY' || payload.t === 'RESUMED') {
            if (payload.t === 'READY' && isRecord(payload.d)) {
              this.resume = { sessionId: text(payload.d.session_id), seq: seq ?? 0 }
              const user = isRecord(payload.d.user) ? payload.d.user : {}
              if (text(user.username)) this.events.botName(text(user.username))
            }
            this.events.status('connected')
          }
          if (this.resume && seq !== null) this.resume.seq = seq
          return
        case 7:
          socket.close(4000)
          return
        case 9:
          this.resume = null
          socket.close(4000)
          return
        default:
          return
      }
    })
    try {
      await Promise.race([
        aborted(signal),
        new Promise<void>((resolve) =>
          socket.once('close', (code) => {
            closeCode = code
            resolve()
          }),
        ),
      ])
    } finally {
      if (heartbeat) clearTimeout(heartbeat)
      socket.removeAllListeners('message')
      socket.close()
    }
    if (FATAL_CLOSES.has(closeCode)) {
      throw new CredentialsRejected(`QQ closed the bot's connection for good (${closeCode})`)
    }
    if (FRESH_CLOSES.has(closeCode)) this.resume = null
    if (closeCode === 4004) this.token = null
    if (closeCode === 4013 || closeCode === 4014) {
      throw new PlatformError(`QQ refused the bot's events (${closeCode})`, 'rejected')
    }
  }

  private dispatch(payload: Payload): void {
    if (payload.t !== 'C2C_MESSAGE_CREATE' || !isRecord(payload.d)) return
    const d = payload.d
    const msgId = text(d.id)
    const author = isRecord(d.author) ? d.author : {}
    const openId = text(author.user_openid)
    if (!msgId || !openId) return
    if (this.seen.has(msgId)) return
    this.seen.add(msgId)
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!)
    this.lastFrom.set(openId, { msgId, at: Date.now(), replies: 0 })
    const files: InboundFile[] = []
    for (const [i, item] of (Array.isArray(d.attachments) ? d.attachments : []).entries()) {
      if (!isRecord(item)) continue
      let url = text(item.url)
      if (url.startsWith('//')) url = `https:${url}`
      if (!url.startsWith('https://')) continue
      const type = text(item.content_type)
      const image = type.startsWith('image/')
      files.push({
        kind: image ? 'image' : 'file',
        name: text(item.filename) || `file-${i + 1}`,
        mimeType: image ? type : null,
        size: typeof item.size === 'number' ? item.size : null,
        read: async () => {
          const answer = await httpRequest(this.route, url, {
            maxBytes: MAX_FILE_BYTES,
            timeoutMs: 120_000,
          })
          if (answer.status !== 200)
            throw new PlatformError(`QQ answered ${answer.status} for a file`)
          return answer.body
        },
      })
    }
    this.events.message({
      sender: { id: openId, name: text(author.username) },
      chatId: openId,
      direct: true,
      text: text(d.content).trim(),
      files,
      replyTo: null,
    })
  }

  async send(target: ChatTarget, message: OutboundMessage): Promise<string | null> {
    if (message.file) throw new PlatformError('QQ files are not sent', 'unsupported')
    const last = this.lastFrom.get(target.userId)
    const passive =
      last && Date.now() - last.at < PASSIVE_MS && last.replies < PASSIVE_REPLIES ? last : null
    if (passive) passive.replies++
    const reply = passive ? { msg_id: passive.msgId, msg_seq: passive.replies } : {}
    const address = `/v2/users/${encodeURIComponent(target.userId)}/messages`
    try {
      const sent = await this.api<{ id?: string }>('POST', address, {
        msg_type: 2,
        markdown: { content: withoutEscapes(message.markdown, false) },
        ...reply,
      })
      return text(sent.id) || null
    } catch (error) {
      if (error instanceof RateLimited) throw error
      // Markdown QQ did not take, or a reply window that closed: plain text, as an active message.
      const sent = await this.api<{ id?: string }>('POST', address, {
        msg_type: 0,
        content: toPlainText(message.markdown),
      })
      return text(sent.id) || null
    }
  }
}
