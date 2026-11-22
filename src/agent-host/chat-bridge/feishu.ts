// Huli: Feishu's bot over its long connection (长连接), which an app made in Feishu's open platform
// (企业自建应用) opens from this computer, so no public address is needed:
// https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case
// The frames are the official SDKs' (feishu-frame.ts); events and card callbacks come over the
// connection as plain JSON, which needs no decryption or signature check, and each is acknowledged
// within Feishu's 3 s. Messages go out as JSON 2.0 cards, whose buttons call back over the same
// connection. See tools/huli/README.md (Chat apps).

import { CREDENTIAL_FIELDS } from '@shared/chat-bridge'
import { addLogSecret } from '@shared/log/process-log'
import type { WebSocket } from 'ws'
import {
  decodeFrame,
  encodeFrame,
  FrameParts,
  header,
  METHOD_CONTROL,
  METHOD_DATA,
  type Frame,
} from './feishu-frame'
import { aborted, Lifeline, PlatformError } from './lifeline'
import { withoutEscapes } from './markdown'
import {
  httpRequest,
  jsonRequest,
  MAX_FILE_BYTES,
  multipart,
  NetError,
  openSocket,
  type Route,
} from './net'
import { RateLimited } from './pacing'
import { utf8Length } from './split'
import {
  CredentialsRejected,
  type AdapterEvents,
  type ChatAdapter,
  type ChatButton,
  type ChatCaps,
  type ChatTarget,
  type InboundFile,
  type OutboundMessage,
} from './types'

const API = 'https://open.feishu.cn'
/** Feishu's defaults when the endpoint names none, in seconds. */
const DEFAULT_PING_S = 120
/** A token is renewed this long before it ends. */
const TOKEN_MARGIN_MS = 5 * 60_000
/** Events already handled, by id; Feishu sends one again when its acknowledgement was late. */
const SEEN = 500

export const FEISHU_CAPS: ChatCaps = {
  buttons: true,
  files: true,
  // A card's request may hold 30 KB; JSON's escapes and the card around the text take some.
  limit: 18_000,
  measure: utf8Length,
}

/** Feishu's limits: 5 messages a second to one user, 50 a second for the app. */
export const FEISHU_PACE = { chatGapMs: 250, chatPerMinute: 0, gapMs: 25 }

interface ApiAnswer {
  code?: number
  msg?: string
  data?: Record<string, unknown>
}

interface Envelope {
  schema?: string
  header?: { event_id?: string; event_type?: string }
  event?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The words of a rich-text post, with its pictures as files. */
function postContent(content: Record<string, unknown>): { text: string; images: string[] } {
  const lines: string[] = []
  const images: string[] = []
  if (text(content.title)) lines.push(text(content.title))
  const paragraphs = Array.isArray(content.content) ? content.content : []
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue
    let line = ''
    for (const element of paragraph) {
      if (!isRecord(element)) continue
      const tag = text(element.tag)
      if (tag === 'text' || tag === 'md') line += text(element.text)
      else if (tag === 'a') line += text(element.text) || text(element.href)
      else if (tag === 'code_block')
        line += `\n\`\`\`${text(element.language).toLowerCase()}\n${text(element.text)}\n\`\`\`\n`
      else if (tag === 'img' && text(element.image_key)) images.push(text(element.image_key))
    }
    lines.push(line)
  }
  return { text: lines.join('\n').trim(), images }
}

/** A row of buttons as card JSON 2.0 lays them out. */
function buttonRow(row: readonly ChatButton[]): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: row.map((button) => ({
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: button.label },
          type:
            button.style === 'danger'
              ? 'danger'
              : button.style === 'primary'
                ? 'primary'
                : 'default',
          behaviors: [{ type: 'callback', value: { k: button.data } }],
        },
      ],
    })),
  }
}

export function feishuCard(markdown: string, buttons?: ChatButton[][]): string {
  const elements: Record<string, unknown>[] = []
  if (markdown.trim()) elements.push({ tag: 'markdown', content: withoutEscapes(markdown, true) })
  for (const row of buttons ?? []) elements.push(buttonRow(row))
  return JSON.stringify({ schema: '2.0', config: { update_multi: true }, body: { elements } })
}

const FILE_TYPES: Readonly<Record<string, string>> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  xls: 'xls',
  xlsx: 'xls',
  ppt: 'ppt',
  pptx: 'ppt',
}

export class FeishuAdapter implements ChatAdapter {
  readonly platform = 'feishu' as const
  readonly caps = FEISHU_CAPS
  private readonly lifeline: Lifeline
  private token: { value: string; until: number } | null = null
  private readonly seen = new Set<string>()
  private readonly appId: string
  private readonly appSecret: string

  constructor(
    credentials: Readonly<Record<string, string>>,
    private readonly route: Route,
    private readonly events: AdapterEvents,
  ) {
    const [id, secret] = CREDENTIAL_FIELDS.feishu
    this.appId = credentials[id!.key] ?? ''
    this.appSecret = credentials[secret!.key] ?? ''
    addLogSecret(this.appSecret)
    this.lifeline = new Lifeline((signal) => this.session(signal), events)
  }

  start(): void {
    this.lifeline.start()
  }

  stop(): void {
    this.lifeline.stop()
  }

  // ---- The API

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.until) return this.token.value
    const { data } = await jsonRequest<{
      code?: number
      msg?: string
      tenant_access_token?: string
      expire?: number
    }>(this.route, `${API}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      json: { app_id: this.appId, app_secret: this.appSecret },
    })
    if (data?.code !== 0 || !data.tenant_access_token) {
      // 10003: no such app; 10014: the secret is wrong.
      throw new CredentialsRejected(
        `Feishu refused the app's credentials (${data?.code ?? '?'}: ${data?.msg ?? ''})`,
      )
    }
    addLogSecret(data.tenant_access_token)
    const ttl = (data.expire ?? 7200) * 1000
    this.token = { value: data.tenant_access_token, until: Date.now() + ttl - TOKEN_MARGIN_MS }
    return data.tenant_access_token
  }

  /** One call of Feishu's API, again with a new token once when it said the token expired. */
  private async api(
    method: 'GET' | 'POST' | 'PATCH',
    address: string,
    body?: { json: unknown } | { form: { body: Buffer; contentType: string } },
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(attempt > 0)
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
      const answer =
        body && 'form' in body
          ? await httpRequest(this.route, `${API}${address}`, {
              method,
              headers: { ...headers, 'Content-Type': body.form.contentType },
              body: body.form.body,
              timeoutMs: 120_000,
            }).then((response) => ({
              status: response.status,
              headers: response.headers,
              data: JSON.parse(response.body.toString('utf8') || '{}') as ApiAnswer,
            }))
          : await jsonRequest<ApiAnswer>(this.route, `${API}${address}`, {
              method,
              headers,
              ...(body ? { json: body.json } : {}),
            })
      const code = answer.data?.code
      if (code === 0) return answer.data?.data ?? {}
      if ((code === 99991663 || code === 99991661) && attempt === 0) continue
      if (answer.status === 429 || code === 99991400 || code === 230020) {
        const reset = Number(answer.headers['x-ogw-ratelimit-reset'])
        throw new RateLimited(Number.isFinite(reset) && reset > 0 ? reset * 1000 : 1000)
      }
      throw new PlatformError(`Feishu answered ${code ?? answer.status}: ${answer.data?.msg ?? ''}`)
    }
  }

  async send(target: ChatTarget, message: OutboundMessage): Promise<string | null> {
    if (message.file) {
      const { file } = message
      const image = file.mimeType.startsWith('image/') && file.bytes.length <= 10 * 1024 * 1024
      if (!image && file.bytes.length > 30 * 1024 * 1024)
        throw new PlatformError('The file is over 30 MB')
      const form = image
        ? multipart([
            { name: 'image_type', value: 'message' },
            {
              name: 'image',
              value: { bytes: file.bytes, fileName: file.name, mimeType: file.mimeType },
            },
          ])
        : multipart([
            {
              name: 'file_type',
              value: FILE_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'stream',
            },
            { name: 'file_name', value: file.name },
            {
              name: 'file',
              value: { bytes: file.bytes, fileName: file.name, mimeType: file.mimeType },
            },
          ])
      const uploaded = await this.api(
        'POST',
        image ? '/open-apis/im/v1/images' : '/open-apis/im/v1/files',
        {
          form,
        },
      )
      const key = text(image ? uploaded.image_key : uploaded.file_key)
      if (!key) throw new PlatformError('Feishu kept no file')
      return this.create(
        target,
        image ? 'image' : 'file',
        JSON.stringify(image ? { image_key: key } : { file_key: key }),
      )
    }
    return this.create(target, 'interactive', feishuCard(message.markdown, message.buttons))
  }

  private async create(target: ChatTarget, type: string, content: string): Promise<string | null> {
    const sent = await this.api('POST', `/open-apis/im/v1/messages?receive_id_type=open_id`, {
      json: { receive_id: target.userId, msg_type: type, content },
    })
    return text(sent.message_id) || null
  }

  private file(messageId: string, key: string, kind: 'image' | 'file', name: string): InboundFile {
    return {
      kind,
      name,
      mimeType: kind === 'image' ? 'image/png' : null,
      size: null,
      read: async () => {
        const token = await this.accessToken()
        const answer = await httpRequest(
          this.route,
          `${API}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}?type=${kind}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            maxBytes: MAX_FILE_BYTES,
            timeoutMs: 120_000,
          },
        )
        if (answer.status !== 200)
          throw new PlatformError(`Feishu answered ${answer.status} for a file`)
        return answer.body
      },
    }
  }

  // ---- The long connection

  private async session(signal: AbortSignal): Promise<void> {
    // The token's request says plainly whether the credentials are right; the endpoint's does not.
    await this.accessToken()
    const { data } = await jsonRequest<{
      code?: number
      msg?: string
      data?: { URL?: string; ClientConfig?: { PingInterval?: number } }
    }>(this.route, `${API}/callback/ws/endpoint`, {
      method: 'POST',
      headers: { locale: 'zh' },
      json: { AppID: this.appId, AppSecret: this.appSecret },
    })
    const address = data?.data?.URL
    if (data?.code !== 0 || !address) {
      if (data?.code === 1000040350)
        throw new PlatformError('Feishu has too many connections for the app', 'conflict')
      if (data?.code === 514 || data?.code === 403)
        throw new CredentialsRejected(`Feishu refused the connection (${data.code})`)
      throw new PlatformError(
        `Feishu gave no connection (${data?.code ?? '?'}: ${data?.msg ?? ''})`,
        'network',
      )
    }
    addLogSecret(address)
    const service = Number(new URL(address).searchParams.get('service_id') ?? '0')
    let pingMs = (data.data?.ClientConfig?.PingInterval ?? DEFAULT_PING_S) * 1000
    const socket = await openSocket(this.route, address)
    this.events.status('connected')
    void this.botInfo()
    const parts = new FrameParts()
    let lastHeard = Date.now()
    let pingTimer: NodeJS.Timeout | undefined
    const ping = () => {
      if (Date.now() - lastHeard > 2 * pingMs + 5_000) {
        socket.terminate()
        return
      }
      const frame: Frame = {
        seqId: 0n,
        logId: 0n,
        service,
        method: METHOD_CONTROL,
        headers: [{ key: 'type', value: 'ping' }],
      }
      socket.send(encodeFrame(frame))
      pingTimer = setTimeout(ping, pingMs)
    }
    pingTimer = setTimeout(ping, pingMs)
    socket.on('message', (raw, binary) => {
      lastHeard = Date.now()
      if (!binary || !Buffer.isBuffer(raw)) return
      let frame: Frame
      try {
        frame = decodeFrame(new Uint8Array(raw))
      } catch (error) {
        this.events.log('warn', `Feishu sent a frame that is not one: ${(error as Error).message}`)
        return
      }
      const type = header(frame, 'type')
      if (frame.method === METHOD_CONTROL) {
        if (type === 'pong' && frame.payload?.length) {
          try {
            const config = JSON.parse(Buffer.from(frame.payload).toString('utf8')) as {
              PingInterval?: number
            }
            if (typeof config.PingInterval === 'number' && config.PingInterval > 0) {
              pingMs = config.PingInterval * 1000
            }
          } catch {
            // A pong without a configuration keeps the one in use.
          }
        }
        return
      }
      if (frame.method !== METHOD_DATA) return
      const payload = parts.add(frame, Date.now())
      if (!payload) return
      const began = Date.now()
      const reply = this.dataFrame(payload)
      this.ack(socket, frame, reply, began)
    })
    try {
      await Promise.race([
        aborted(signal),
        new Promise<void>((resolve) => socket.once('close', () => resolve())),
      ])
    } finally {
      if (pingTimer) clearTimeout(pingTimer)
      socket.removeAllListeners('message')
      socket.close()
    }
  }

  private async botInfo(): Promise<void> {
    try {
      const token = await this.accessToken()
      const { data } = await jsonRequest<{ code?: number; bot?: { app_name?: string } }>(
        this.route,
        `${API}/open-apis/bot/v3/info`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (data?.code === 0 && data.bot?.app_name) this.events.botName(data.bot.app_name)
    } catch (error) {
      if (!(error instanceof NetError))
        this.events.log('warn', "Could not read the Feishu bot's name")
    }
  }

  /** Sends Feishu its frame back with the answer, as the SDKs do, so it does not send it again. */
  private ack(socket: WebSocket, frame: Frame, data: unknown, began: number): void {
    const body: Record<string, unknown> = { code: 200 }
    if (data !== undefined) body.data = Buffer.from(JSON.stringify(data)).toString('base64')
    const answer: Frame = {
      ...frame,
      headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - began) }],
      payload: new Uint8Array(Buffer.from(JSON.stringify(body))),
    }
    try {
      socket.send(encodeFrame(answer))
    } catch {
      // A socket that closed meanwhile is opened again; Feishu sends the event again.
    }
  }

  /** Handles an event or a callback; what a card's callback answers, if anything. */
  private dataFrame(payload: Uint8Array): unknown {
    let envelope: Envelope
    try {
      envelope = JSON.parse(Buffer.from(payload).toString('utf8')) as Envelope
    } catch {
      return undefined
    }
    const id = envelope.header?.event_id
    if (id) {
      if (this.seen.has(id)) return undefined
      this.seen.add(id)
      if (this.seen.size > SEEN) this.seen.delete(this.seen.values().next().value!)
    }
    const event = isRecord(envelope.event) ? envelope.event : null
    if (!event) return undefined
    switch (envelope.header?.event_type) {
      case 'im.message.receive_v1':
        this.received(event)
        return undefined
      case 'card.action.trigger':
        return this.pressed(event)
      default:
        return undefined
    }
  }

  private received(event: Record<string, unknown>): void {
    const sender = isRecord(event.sender) ? event.sender : {}
    const message = isRecord(event.message) ? event.message : {}
    if (text(sender.sender_type) !== 'user') return
    const ids = isRecord(sender.sender_id) ? sender.sender_id : {}
    const openId = text(ids.open_id)
    const messageId = text(message.message_id)
    if (!openId || !messageId) return
    let content: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text(message.content) || '{}')
      if (isRecord(parsed)) content = parsed
    } catch {
      return
    }
    const files: InboundFile[] = []
    let words = ''
    switch (text(message.message_type)) {
      case 'text':
        words = text(content.text).replace(/@_user_\d+\s*/g, '')
        break
      case 'post': {
        const post = postContent(content)
        words = post.text.replace(/@_user_\d+\s*/g, '')
        for (const [i, key] of post.images.entries())
          files.push(this.file(messageId, key, 'image', `image-${i + 1}.png`))
        break
      }
      case 'image':
        if (text(content.image_key))
          files.push(this.file(messageId, text(content.image_key), 'image', 'image.png'))
        break
      case 'file':
        if (text(content.file_key)) {
          files.push(
            this.file(messageId, text(content.file_key), 'file', text(content.file_name) || 'file'),
          )
        }
        break
      default:
        return
    }
    // The event names no sender; reading their name would need the contacts scope.
    this.events.message({
      sender: { id: openId, name: '' },
      chatId: text(message.chat_id),
      direct: text(message.chat_type) === 'p2p',
      text: words.trim(),
      files,
      replyTo: text(message.parent_id) || null,
    })
  }

  private pressed(event: Record<string, unknown>): unknown {
    const operator = isRecord(event.operator) ? event.operator : {}
    const action = isRecord(event.action) ? event.action : {}
    const value = isRecord(action.value) ? action.value : {}
    const context = isRecord(event.context) ? event.context : {}
    const openId = text(operator.open_id)
    const data = text(value.k)
    if (!openId || !data) return {}
    this.events.action({
      sender: { id: openId, name: '' },
      chatId: text(context.open_chat_id),
      // The bridge sends its cards to one user alone; a press is checked against the bound accounts.
      direct: true,
      data,
    })
    return { toast: { type: 'info', content: '✓' } }
  }
}
