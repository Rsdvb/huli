// Huli: a WeCom (企业微信) AI bot (智能机器人) in API mode over its long connection, which
// connects out from this computer, so no public address is needed:
// https://developer.work.weixin.qq.com/document/path/101463 (the frames as WeCom's own
// @wecom/aibot-node-sdk, MIT, speaks them). The bot writes to a user with `aibot_send_msg` once
// they wrote to it; buttons are a button card, whose presses come back over the connection. Files
// the user sends come encrypted, each with a key of its own. See tools/huli/README.md (Chat apps).

import { createDecipheriv, randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import { CREDENTIAL_FIELDS } from '@shared/chat-bridge'
import { addLogSecret } from '@shared/log/process-log'
import { aborted, Lifeline, PlatformError } from './lifeline'
import { withoutEscapes } from './markdown'
import { httpRequest, MAX_FILE_BYTES, openSocket, type Route } from './net'
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

const ENDPOINT = 'wss://openws.work.weixin.qq.com'
/** WeCom asks for a heartbeat every 30 s. */
const PING_MS = 30_000
const ACK_TIMEOUT_MS = 15_000
/** A file goes up in pieces of this many bytes, at most 100 of them. */
const CHUNK_BYTES = 512 * 1024
/** A button card holds at most six buttons. */
const CARD_BUTTONS = 6

export const WECOM_CAPS: ChatCaps = {
  buttons: true,
  files: true,
  // A Markdown message may hold 20,480 bytes.
  limit: 18_000,
  measure: utf8Length,
}

/** WeCom's limits: 30 messages a minute and 1000 an hour in one conversation. */
export const WECOM_PACE = { chatGapMs: 600, chatPerMinute: 25, gapMs: 100 }

interface WsFrame {
  cmd?: string
  headers?: { req_id?: string }
  body?: Record<string, unknown>
  errcode?: number
  errmsg?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * A file WeCom encrypted: AES-256-CBC with the message's key, whose first 16 bytes are the IV,
 * padded as PKCS#7 to 32 bytes, as WeCom's documentation and SDK say.
 */
export function decryptWeComFile(encrypted: Buffer, aesKey: string): Buffer {
  const key = Buffer.from(aesKey, 'base64')
  if (key.length !== 32) throw new Error('The file key is not 32 bytes')
  if (encrypted.length === 0 || encrypted.length % 16 !== 0)
    throw new Error('The file is not whole')
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
  const pad = plain[plain.length - 1]!
  if (pad < 1 || pad > 32 || pad > plain.length) throw new Error('The file does not decrypt')
  for (let i = plain.length - pad; i < plain.length; i++) {
    if (plain[i] !== pad) throw new Error('The file does not decrypt')
  }
  return plain.subarray(0, plain.length - pad)
}

function reqId(cmd: string): string {
  return `${cmd}_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`
}

export class WeComAdapter implements ChatAdapter {
  readonly platform = 'wecom' as const
  readonly caps = WECOM_CAPS
  private readonly lifeline: Lifeline
  private readonly botId: string
  private readonly secret: string
  private socket: WebSocket | null = null
  private readonly acks = new Map<
    string,
    { resolve: (frame: WsFrame) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private readonly seen = new Set<string>()

  constructor(
    credentials: Readonly<Record<string, string>>,
    private readonly route: Route,
    private readonly events: AdapterEvents,
  ) {
    const [id, secret] = CREDENTIAL_FIELDS.wecom
    this.botId = credentials[id!.key] ?? ''
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

  /** Sends a command and resolves with WeCom's answer to it, matched by its request id. */
  private request(cmd: string, body?: Record<string, unknown>): Promise<WsFrame> {
    const socket = this.socket
    if (!socket) return Promise.reject(new PlatformError('Not connected to WeCom', 'network'))
    const id = reqId(cmd)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(id)
        reject(new PlatformError('WeCom did not answer in time', 'network'))
      }, ACK_TIMEOUT_MS)
      this.acks.set(id, { resolve, reject, timer })
      socket.send(
        JSON.stringify({ cmd, headers: { req_id: id }, ...(body ? { body } : {}) }),
        (error) => {
          if (!error) return
          clearTimeout(timer)
          this.acks.delete(id)
          reject(new PlatformError(error.message, 'network'))
        },
      )
    })
  }

  private async checked(cmd: string, body?: Record<string, unknown>): Promise<WsFrame> {
    const answer = await this.request(cmd, body)
    const code = answer.errcode ?? 0
    if (code === 0) return answer
    if (code === 45009 || code === 45033 || code === 846607) throw new RateLimited(60_000)
    throw new PlatformError(`WeCom answered ${code}: ${answer.errmsg ?? ''}`)
  }

  private async session(signal: AbortSignal): Promise<void> {
    const socket = await openSocket(this.route, ENDPOINT)
    this.socket = socket
    let pinger: NodeJS.Timeout | null = null
    let missed = 0
    socket.on('message', (raw, binary) => {
      if (binary) return
      let frame: WsFrame
      try {
        frame = JSON.parse(raw.toString()) as WsFrame
      } catch {
        return
      }
      const id = frame.headers?.req_id ?? ''
      if (!frame.cmd) {
        const waiting = this.acks.get(id)
        if (waiting) {
          this.acks.delete(id)
          clearTimeout(waiting.timer)
          waiting.resolve(frame)
        }
        if (id.startsWith('ping')) missed = 0
        return
      }
      if (frame.cmd === 'aibot_msg_callback' && frame.body) this.received(frame.body)
      else if (frame.cmd === 'aibot_event_callback' && frame.body) this.event(frame.body, socket)
    })
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    try {
      const subscribed = await Promise.race([
        this.request('aibot_subscribe', { bot_id: this.botId, secret: this.secret }),
        closed.then((): WsFrame => ({ errcode: -1, errmsg: 'WeCom closed the connection' })),
      ])
      if ((subscribed.errcode ?? 0) !== 0) {
        if (subscribed.errcode === -1) throw new PlatformError(subscribed.errmsg ?? '', 'network')
        throw new CredentialsRejected(
          `WeCom refused the bot's credentials (${subscribed.errcode}: ${subscribed.errmsg ?? ''})`,
        )
      }
      this.events.status('connected')
      const ping = () => {
        if (missed >= 2) {
          socket.terminate()
          return
        }
        missed++
        void this.request('ping').catch(() => {})
        pinger = setTimeout(ping, PING_MS)
      }
      pinger = setTimeout(ping, PING_MS)
      await Promise.race([aborted(signal), closed])
    } finally {
      if (pinger) clearTimeout(pinger)
      this.socket = null
      for (const [, waiting] of this.acks) {
        clearTimeout(waiting.timer)
        waiting.reject(new PlatformError('The connection closed', 'network'))
      }
      this.acks.clear()
      socket.removeAllListeners('message')
      socket.close()
    }
  }

  private first(id: string): boolean {
    if (!id) return true
    if (this.seen.has(id)) return false
    this.seen.add(id)
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!)
    return true
  }

  private file(url: string, aesKey: string, kind: 'image' | 'file', name: string): InboundFile {
    return {
      kind,
      name,
      mimeType: kind === 'image' ? 'image/png' : null,
      size: null,
      read: async () => {
        const answer = await httpRequest(this.route, url, {
          maxBytes: MAX_FILE_BYTES + 64,
          timeoutMs: 120_000,
        })
        if (answer.status !== 200)
          throw new PlatformError(`WeCom answered ${answer.status} for a file`)
        return aesKey ? decryptWeComFile(answer.body, aesKey) : answer.body
      },
    }
  }

  private received(body: Record<string, unknown>): void {
    if (!this.first(text(body.msgid))) return
    const from = isRecord(body.from) ? body.from : {}
    const userId = text(from.userid)
    if (!userId) return
    const files: InboundFile[] = []
    let words = ''
    const media = (item: Record<string, unknown>, kind: 'image' | 'file', name: string) => {
      const url = text(item.url)
      if (url.startsWith('https://')) files.push(this.file(url, text(item.aeskey), kind, name))
    }
    switch (text(body.msgtype)) {
      case 'text':
        words = text(isRecord(body.text) ? body.text.content : '')
        break
      case 'voice':
        // WeCom's own transcript of a voice message.
        words = text(isRecord(body.voice) ? body.voice.content : '')
        break
      case 'image':
        if (isRecord(body.image)) media(body.image, 'image', 'image.png')
        break
      case 'file':
        if (isRecord(body.file)) media(body.file, 'file', text(body.file.filename) || 'file')
        break
      case 'mixed': {
        const mixed = isRecord(body.mixed) ? body.mixed : {}
        for (const item of Array.isArray(mixed.msg_item) ? mixed.msg_item : []) {
          if (!isRecord(item)) continue
          if (text(item.msgtype) === 'text' && isRecord(item.text)) words += text(item.text.content)
          if (text(item.msgtype) === 'image' && isRecord(item.image)) {
            media(item.image, 'image', `image-${files.length + 1}.png`)
          }
        }
        break
      }
      default:
        return
    }
    // A group's message names the bot first.
    words = words.replace(/^@\S+\s*/, '').trim()
    if (!words && files.length === 0) return
    const single = text(body.chattype) === 'single'
    this.events.message({
      sender: { id: userId, name: '' },
      chatId: single ? userId : text(body.chatid),
      direct: single,
      text: words,
      files,
      replyTo: null,
    })
  }

  private event(body: Record<string, unknown>, socket: WebSocket): void {
    const event = isRecord(body.event) ? body.event : {}
    const type = text(event.eventtype)
    if (type === 'disconnected_event') {
      // Another connection of the same bot took over; WeCom closes this one.
      this.events.status('error', 'conflict', 'Another program connected with this bot')
      socket.close()
      return
    }
    if (type !== 'template_card_event' || !this.first(text(body.msgid))) return
    const nested = isRecord(event.template_card_event) ? event.template_card_event : {}
    const key = text(event.event_key) || text(nested.event_key)
    const from = isRecord(body.from) ? body.from : {}
    const userId = text(from.userid)
    if (!key || !userId) return
    const single = text(body.chattype) !== 'group'
    this.events.action({
      sender: { id: userId, name: '' },
      chatId: single ? userId : text(body.chatid),
      direct: single,
      data: key,
    })
  }

  private card(markdown: string, buttons: readonly ChatButton[]): Record<string, unknown> {
    const title = markdown.split('\n').find((line) => line.trim()) ?? 'Kite'
    return {
      card_type: 'button_interaction',
      main_title: { title: title.replace(/[*_`\\]/g, '').slice(0, 26) },
      button_list: buttons.slice(0, CARD_BUTTONS).map((button) => ({
        text: button.label.slice(0, 10),
        style: button.style === 'danger' ? 3 : button.style === 'primary' ? 1 : 2,
        key: button.data,
      })),
      task_id: `kite_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`,
    }
  }

  async send(target: ChatTarget, message: OutboundMessage): Promise<string | null> {
    const chatid = target.userId
    if (message.file) {
      const { file } = message
      const image =
        /^image\/(png|jpe?g|gif)$/.test(file.mimeType) && file.bytes.length <= 10 * 1024 * 1024
      const chunks = Math.ceil(file.bytes.length / CHUNK_BYTES)
      if (chunks === 0 || chunks > 100) throw new PlatformError('The file is too large for WeCom')
      const init = await this.checked('aibot_upload_media_init', {
        type: image ? 'image' : 'file',
        filename: file.name,
        total_size: file.bytes.length,
        total_chunks: chunks,
      })
      const uploadId = text(init.body?.upload_id)
      if (!uploadId) throw new PlatformError('WeCom gave no upload')
      for (let i = 0; i < chunks; i++) {
        await this.checked('aibot_upload_media_chunk', {
          upload_id: uploadId,
          chunk_index: i,
          base64_data: file.bytes
            .subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)
            .toString('base64'),
        })
      }
      const done = await this.checked('aibot_upload_media_finish', { upload_id: uploadId })
      const mediaId = text(done.body?.media_id)
      if (!mediaId) throw new PlatformError('WeCom kept no file')
      const type = image ? 'image' : 'file'
      await this.checked('aibot_send_msg', { chatid, msgtype: type, [type]: { media_id: mediaId } })
      return null
    }
    if (message.markdown.trim()) {
      await this.checked('aibot_send_msg', {
        chatid,
        msgtype: 'markdown',
        markdown: { content: withoutEscapes(message.markdown, false) },
      })
    }
    const buttons = message.buttons?.flat() ?? []
    // More choices than a card holds are answered with the commands the message lists.
    if (buttons.length > 0 && buttons.length <= CARD_BUTTONS) {
      await this.checked('aibot_send_msg', {
        chatid,
        msgtype: 'template_card',
        template_card: this.card(message.markdown, buttons),
      })
    }
    return null
  }
}
