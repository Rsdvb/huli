// Huli: a DingTalk app's bot in Stream mode, which connects out from this computer, so no public
// address is needed: https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description
// (the frames as github.com/open-dingtalk/dingtalk-stream-sdk-nodejs, MIT, speaks them). Only the
// bot's message callback is subscribed, since other events count against the free plan's quota.
// A reply goes to the message's session webhook while it lasts, else through the robot API; the
// user answers with text commands, since buttons that call back need a card template of the
// user's own. See tools/huli/README.md (Chat apps).

import { CREDENTIAL_FIELDS } from '@shared/chat-bridge'
import { addLogSecret } from '@shared/log/process-log'
import { aborted, Lifeline, PlatformError } from './lifeline'
import { toPlainText, withoutEscapes } from './markdown'
import { httpRequest, jsonRequest, MAX_FILE_BYTES, multipart, openSocket, type Route } from './net'
import { RateLimited } from './pacing'
import { utf8Length } from './split'
import {
  CredentialsRejected,
  type AdapterEvents,
  type ChatAdapter,
  type ChatCaps,
  type ChatTarget,
  type InboundFile,
  type OutboundMessage,
} from './types'

const API = 'https://api.dingtalk.com'
const OAPI = 'https://oapi.dingtalk.com'
const BOT_TOPIC = '/v1.0/im/bot/messages/get'
const TOKEN_MARGIN_MS = 5 * 60_000
/** A session webhook is not used this close to its end. */
const WEBHOOK_MARGIN_MS = 60_000

export const DINGTALK_CAPS: ChatCaps = {
  buttons: false,
  files: true,
  // A message's parameters may hold 15,000 bytes; JSON's escapes take some.
  limit: 12_000,
  measure: utf8Length,
}

/** DingTalk names no per-chat limit for an app's bot; this stays well under a custom bot's 20. */
export const DINGTALK_PACE = { chatGapMs: 1_000, chatPerMinute: 20, gapMs: 100 }

interface Frame {
  specVersion?: string
  type?: string
  headers?: Record<string, string>
  data?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** DingTalk's Markdown: lines end with a hard break, which its renderer needs to keep them apart. */
export function dingTalkMarkdown(markdown: string): string {
  const out: string[] = []
  let code = false
  for (const line of withoutEscapes(markdown, false).split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) code = !code
    out.push(code || line.trim() === '' ? line : `${line}  `)
  }
  return out.join('\n')
}

function titleOf(markdown: string): string {
  const first =
    toPlainText(markdown)
      .split('\n')
      .find((line) => line.trim()) ?? 'Kite'
  return first.trim().slice(0, 30)
}

export class DingTalkAdapter implements ChatAdapter {
  readonly platform = 'dingtalk' as const
  readonly caps = DINGTALK_CAPS
  private readonly lifeline: Lifeline
  private readonly clientId: string
  private readonly clientSecret: string
  private robotCode: string
  private token: { value: string; until: number } | null = null
  /** Each user's last message's webhook, which answers in that chat for a while. */
  private readonly webhooks = new Map<string, { url: string; until: number }>()
  private readonly seen = new Set<string>()

  constructor(
    credentials: Readonly<Record<string, string>>,
    private readonly route: Route,
    private readonly events: AdapterEvents,
  ) {
    const [id, secret] = CREDENTIAL_FIELDS.dingtalk
    this.clientId = credentials[id!.key] ?? ''
    this.clientSecret = credentials[secret!.key] ?? ''
    // An internal app's bot has the app's Client ID for its robot code.
    this.robotCode = this.clientId
    addLogSecret(this.clientSecret)
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
    const { status, data } = await jsonRequest<{
      accessToken?: string
      expireIn?: number
      code?: string
      message?: string
    }>(this.route, `${API}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      json: { appKey: this.clientId, appSecret: this.clientSecret },
    })
    if (!data?.accessToken) {
      if (status === 400 || status === 401 || status === 403) {
        throw new CredentialsRejected(
          `DingTalk refused the app's credentials (${data?.code ?? status})`,
        )
      }
      throw new PlatformError(
        `DingTalk gave no token (${data?.code ?? status}: ${data?.message ?? ''})`,
      )
    }
    addLogSecret(data.accessToken)
    this.token = {
      value: data.accessToken,
      until: Date.now() + (data.expireIn ?? 7200) * 1000 - TOKEN_MARGIN_MS,
    }
    return data.accessToken
  }

  private async api<T>(address: string, json: unknown): Promise<T> {
    const token = await this.accessToken()
    const { status, data } = await jsonRequest<T & { code?: string; message?: string }>(
      this.route,
      `${API}${address}`,
      { method: 'POST', headers: { 'x-acs-dingtalk-access-token': token }, json },
    )
    if (status === 401) this.token = null
    const code = typeof data?.code === 'string' ? data.code : ''
    if (status === 429 || /tooFast|too\.fast|qps\.exceed|Throttling/i.test(code))
      throw new RateLimited(60_000)
    if (status < 200 || status > 299) {
      throw new PlatformError(`DingTalk answered ${code || status}: ${data?.message ?? ''}`)
    }
    return data as T
  }

  private async session(signal: AbortSignal): Promise<void> {
    await this.accessToken()
    const { status, data } = await jsonRequest<{
      endpoint?: string
      ticket?: string
      code?: string
      message?: string
    }>(this.route, `${API}/v1.0/gateway/connections/open`, {
      method: 'POST',
      json: {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        subscriptions: [{ type: 'CALLBACK', topic: BOT_TOPIC }],
        ua: 'kite-chat-bridge/1',
      },
    })
    if (!data?.endpoint || !data.ticket) {
      if (status === 401 || status === 403)
        throw new CredentialsRejected('DingTalk refused the Stream connection')
      throw new PlatformError(
        `DingTalk gave no connection (${data?.code ?? status}: ${data?.message ?? ''})`,
        'network',
      )
    }
    addLogSecret(data.ticket)
    const socket = await openSocket(
      this.route,
      `${data.endpoint}?ticket=${encodeURIComponent(data.ticket)}`,
    )
    this.events.status('connected')
    let alive = true
    // DingTalk names no keepalive; a WebSocket ping each minute finds a connection that died.
    const keepalive = setInterval(() => {
      if (!alive) {
        socket.terminate()
        return
      }
      alive = false
      socket.ping()
    }, 60_000)
    socket.on('pong', () => (alive = true))
    socket.on('message', (raw, binary) => {
      alive = true
      if (binary) return
      let frame: Frame
      try {
        frame = JSON.parse(raw.toString()) as Frame
      } catch {
        return
      }
      const headers = frame.headers ?? {}
      const ack = (data: string) =>
        socket.send(
          JSON.stringify({
            code: 200,
            headers: { contentType: 'application/json', messageId: headers.messageId ?? '' },
            message: 'OK',
            data,
          }),
        )
      if (frame.type === 'SYSTEM') {
        if (headers.topic === 'ping') ack(frame.data ?? '')
        else if (headers.topic === 'disconnect') socket.close()
        return
      }
      if (frame.type === 'CALLBACK') {
        // Acknowledged at once, so DingTalk does not send it again.
        ack(JSON.stringify({ response: {} }))
        if (headers.topic === BOT_TOPIC) this.received(frame.data ?? '')
        return
      }
      if (frame.type === 'EVENT') ack(JSON.stringify({ status: 'SUCCESS', message: 'success' }))
    })
    try {
      await Promise.race([
        aborted(signal),
        new Promise<void>((resolve) => socket.once('close', () => resolve())),
      ])
    } finally {
      clearInterval(keepalive)
      socket.removeAllListeners('message')
      socket.close()
    }
  }

  private file(downloadCode: string, kind: 'image' | 'file', name: string): InboundFile {
    return {
      kind,
      name,
      mimeType: kind === 'image' ? 'image/png' : null,
      size: null,
      read: async () => {
        const { downloadUrl } = await this.api<{ downloadUrl?: string }>(
          '/v1.0/robot/messageFiles/download',
          {
            downloadCode,
            robotCode: this.robotCode,
          },
        )
        if (!downloadUrl) throw new PlatformError('DingTalk gave no file')
        const answer = await httpRequest(this.route, downloadUrl, {
          maxBytes: MAX_FILE_BYTES,
          timeoutMs: 120_000,
        })
        if (answer.status !== 200)
          throw new PlatformError(`DingTalk answered ${answer.status} for a file`)
        return answer.body
      },
    }
  }

  private received(data: string): void {
    let body: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(data)
      if (!isRecord(parsed)) return
      body = parsed
    } catch {
      return
    }
    const msgId = text(body.msgId)
    if (msgId) {
      if (this.seen.has(msgId)) return
      this.seen.add(msgId)
      if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!)
    }
    const userId = text(body.senderStaffId) || text(body.senderId)
    if (!userId) return
    if (text(body.robotCode)) this.robotCode = text(body.robotCode)
    const webhook = text(body.sessionWebhook)
    const until = Number(body.sessionWebhookExpiredTime)
    if (webhook.startsWith('https://') && Number.isFinite(until))
      this.webhooks.set(userId, { url: webhook, until })
    const content = isRecord(body.content) ? body.content : {}
    const files: InboundFile[] = []
    let words = ''
    switch (text(body.msgtype)) {
      case 'text':
        words = text(isRecord(body.text) ? body.text.content : '')
        break
      case 'richText':
        for (const item of Array.isArray(content.richText) ? content.richText : []) {
          if (!isRecord(item)) continue
          if (text(item.text)) words += text(item.text)
          if (text(item.downloadCode))
            files.push(this.file(text(item.downloadCode), 'image', `image-${files.length + 1}.png`))
        }
        break
      case 'picture':
        if (text(content.downloadCode))
          files.push(this.file(text(content.downloadCode), 'image', 'image.png'))
        break
      case 'file':
        if (text(content.downloadCode)) {
          files.push(
            this.file(text(content.downloadCode), 'file', text(content.fileName) || 'file'),
          )
        }
        break
      case 'audio':
        // DingTalk's own transcript of a voice message.
        words = text(content.recognition)
        break
      default:
        return
    }
    if (!words.trim() && files.length === 0) return
    this.events.message({
      sender: { id: userId, name: text(body.senderNick) },
      chatId: text(body.conversationId) || userId,
      direct: text(body.conversationType) === '1',
      text: words.trim(),
      files,
      replyTo: null,
    })
  }

  async send(target: ChatTarget, message: OutboundMessage): Promise<string | null> {
    if (message.file) return this.sendFile(target, message.file)
    const markdown = dingTalkMarkdown(message.markdown)
    const title = titleOf(message.markdown)
    const hook = this.webhooks.get(target.userId)
    if (hook && Date.now() < hook.until - WEBHOOK_MARGIN_MS) {
      const { status, data } = await jsonRequest<{ errcode?: number; errmsg?: string }>(
        this.route,
        hook.url,
        {
          method: 'POST',
          json: { msgtype: 'markdown', markdown: { title, text: markdown } },
        },
      )
      if (status === 200 && (data?.errcode ?? 0) === 0) return null
      if (data?.errcode === 130101 || status === 429) throw new RateLimited(60_000)
      this.webhooks.delete(target.userId)
    }
    await this.toUser(target, 'sampleMarkdown', { title, text: markdown })
    return null
  }

  private async toUser(target: ChatTarget, msgKey: string, param: unknown): Promise<void> {
    const sent = await this.api<{
      flowControlledStaffIdList?: string[]
      invalidStaffIdList?: string[]
    }>('/v1.0/robot/oToMessages/batchSend', {
      robotCode: this.robotCode,
      userIds: [target.userId],
      msgKey,
      msgParam: JSON.stringify(param),
    })
    if (sent.flowControlledStaffIdList?.length) throw new RateLimited(60_000)
    if (sent.invalidStaffIdList?.length)
      throw new PlatformError('DingTalk does not know this user', 'rejected')
  }

  private async sendFile(
    target: ChatTarget,
    file: NonNullable<OutboundMessage['file']>,
  ): Promise<string | null> {
    const image = /^image\/(png|jpe?g|gif|bmp)$/.test(file.mimeType)
    const token = await this.accessToken()
    const form = multipart([
      { name: 'media', value: { bytes: file.bytes, fileName: file.name, mimeType: file.mimeType } },
    ])
    const answer = await httpRequest(
      this.route,
      `${OAPI}/media/upload?access_token=${encodeURIComponent(token)}&type=${image ? 'image' : 'file'}`,
      {
        method: 'POST',
        headers: { 'Content-Type': form.contentType },
        body: form.body,
        timeoutMs: 180_000,
      },
    )
    let uploaded: { errcode?: number; errmsg?: string; media_id?: string } = {}
    try {
      uploaded = JSON.parse(answer.body.toString('utf8')) as typeof uploaded
    } catch {
      // Said below.
    }
    if (!uploaded.media_id) {
      throw new PlatformError(
        `DingTalk kept no file (${uploaded.errcode ?? answer.status}: ${uploaded.errmsg ?? ''})`,
      )
    }
    if (image) await this.toUser(target, 'sampleImageMsg', { photoURL: uploaded.media_id })
    else {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? 'file'
      await this.toUser(target, 'sampleFile', {
        mediaId: uploaded.media_id,
        fileName: file.name,
        fileType: extension,
      })
    }
    return null
  }
}
