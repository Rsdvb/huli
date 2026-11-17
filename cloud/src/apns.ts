// Apple's push service over HTTP/2 with a token-based (.p8) key: one connection per environment,
// opened when first needed and opened again after it closes, and a JWT signed with ES256 that is
// reused for 50 minutes, as Apple asks.

import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import type { ApnsEnvironment } from '@shared/remote/push'
import type { ApnsConfig } from './config'

const HOSTS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}
const JWT_MS = 50 * 60 * 1000
const TIMEOUT_MS = 15_000

export interface ApnsMessage {
  environment: ApnsEnvironment
  token: string
  headers: Record<string, string>
  payload: unknown
}

export type ApnsResult = { ok: true } | { ok: false; status: number; reason: string; gone: boolean }

/** What sends a message to Apple; tests give their own. */
export type ApnsSender = (message: ApnsMessage) => Promise<ApnsResult>

const GONE = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic', 'ExpiredToken'])

export class Apns {
  private readonly key: KeyObject
  private jwt: { value: string; madeAt: number } | null = null
  private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>()

  constructor(private readonly config: ApnsConfig) {
    this.key = createPrivateKey(readFileSync(config.keyFile, 'utf8'))
  }

  get topic(): string {
    return this.config.topic
  }

  private token(): string {
    const now = Date.now()
    if (this.jwt && now - this.jwt.madeAt < JWT_MS) return this.jwt.value
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const head = encode({ alg: 'ES256', kid: this.config.keyId })
    const claims = encode({ iss: this.config.teamId, iat: Math.floor(now / 1000) })
    const signature = sign('sha256', Buffer.from(`${head}.${claims}`), {
      key: this.key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    this.jwt = { value: `${head}.${claims}.${signature}`, madeAt: now }
    return this.jwt.value
  }

  private session(environment: ApnsEnvironment): ClientHttp2Session {
    const open = this.sessions.get(environment)
    if (open && !open.closed && !open.destroyed) return open
    const session = connect(HOSTS[environment])
    const forget = () => {
      if (this.sessions.get(environment) === session) this.sessions.delete(environment)
    }
    session.on('close', forget)
    session.on('error', forget)
    session.on('goaway', forget)
    session.setTimeout(10 * 60 * 1000, () => session.close())
    this.sessions.set(environment, session)
    return session
  }

  readonly send: ApnsSender = (message) =>
    new Promise((resolve) => {
      let request
      try {
        request = this.session(message.environment).request({
          [constants.HTTP2_HEADER_METHOD]: 'POST',
          [constants.HTTP2_HEADER_PATH]: `/3/device/${message.token}`,
          authorization: `bearer ${this.token()}`,
          ...message.headers,
        })
      } catch (error) {
        resolve({ ok: false, status: 0, reason: (error as Error).message, gone: false })
        return
      }
      let status = 0
      let body = ''
      request.setEncoding('utf8')
      request.setTimeout(TIMEOUT_MS, () => request.close(constants.NGHTTP2_CANCEL))
      request.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0)
      })
      request.on('data', (chunk: string) => {
        if (body.length < 4096) body += chunk
      })
      request.on('error', (error) =>
        resolve({ ok: false, status: 0, reason: error.message, gone: false }),
      )
      request.on('close', () => {
        if (status === 200) return resolve({ ok: true })
        let reason = 'unknown'
        try {
          reason = String((JSON.parse(body) as { reason?: string }).reason ?? reason)
        } catch {
          // Apple's answer had no JSON body.
        }
        resolve({ ok: false, status, reason, gone: status === 410 || GONE.has(reason) })
      })
      request.end(JSON.stringify(message.payload))
    })

  close(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
}
