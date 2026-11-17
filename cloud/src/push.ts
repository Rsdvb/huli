// The push gateway: POST /v1/push as src/shared/remote/push.ts has hosts send it. It checks the
// account's access token, the host's Ed25519 signature over the request, the time and that the
// request is new, then hands the sealed content to Apple. It never sees what a notification says.
//
// The APNs payloads below are Huli's own contract with its iOS app:
//   alert:        aps.alert (a placeholder the Notification Service Extension replaces after it
//                 opens `sealed`), aps.mutable-content = 1, collapse id = the request's collapse
//   background:   aps.content-available = 1 and `sealed`
//   liveactivity: aps.content-state = { sealed }; on start also aps.attributes = { sealed } of
//                 type HuliActivityAttributes

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  HOST_KEY_HEADER,
  MAX_CLOCK_SKEW_MS,
  MAX_PUSH_BODY,
  parsePushRequest,
  pushRequestText,
  SIGNATURE_HEADER,
  type PushRefusal,
  type PushRequest,
} from '@shared/remote/push'
import { decodeRelayBytes, relayHostId, verifyRelaySignature } from '@shared/remote/relay'
import type { ApnsMessage, ApnsSender } from './apns'
import type { Auth } from './auth'
import { clientAddress, Limiter, readBody, sendJson, TooBig } from './http'
import { sha256Hex } from './secrets'

const STATUS: Record<PushRefusal, number> = {
  malformed: 400,
  unauthorized: 401,
  signed_out: 403,
  unregistered: 410,
  too_big: 413,
  too_many: 429,
  apns: 502,
  unavailable: 503,
}

const PLACEHOLDER = { title: 'Huli', body: '有新动态' }

export interface PushGatewayOptions {
  auth: Auth
  origin: string
  trustProxy: boolean
  /** Null while no APNs key is set up: every push answers `apns`. */
  apns: { send: ApnsSender; topic: string } | null
  now?: () => number
  log?: (line: string) => void
}

/** The APNs message for a push request. */
export function apnsMessage(request: PushRequest, topic: string, nowMs: number): ApnsMessage {
  const base = { environment: request.environment, token: request.token }
  const expiration = String(Math.floor(nowMs / 1000) + 24 * 60 * 60)
  const { push } = request
  switch (push.type) {
    case 'alert':
      return {
        ...base,
        headers: {
          'apns-topic': topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-collapse-id': push.collapse,
          'apns-expiration': expiration,
        },
        payload: {
          aps: { alert: PLACEHOLDER, 'mutable-content': 1, sound: 'default' },
          sealed: push.sealed,
        },
      }
    case 'background':
      return {
        ...base,
        headers: {
          'apns-topic': topic,
          'apns-push-type': 'background',
          'apns-priority': '5',
          'apns-expiration': expiration,
        },
        payload: { aps: { 'content-available': 1 }, sealed: push.sealed },
      }
    case 'liveactivity': {
      const timestamp = Math.floor(nowMs / 1000)
      const aps: Record<string, unknown> = {
        timestamp,
        event: push.event,
        'content-state': { sealed: push.sealed },
      }
      if (push.event === 'start') {
        aps['attributes-type'] = 'HuliActivityAttributes'
        aps.attributes = { sealed: push.attributes }
        aps.alert = PLACEHOLDER
      }
      if (push.event === 'end') aps['dismissal-date'] = timestamp
      return {
        ...base,
        headers: {
          'apns-topic': `${topic}.push-type.liveactivity`,
          'apns-push-type': 'liveactivity',
          'apns-priority': '10',
        },
        payload: { aps },
      }
    }
  }
}

export class PushGateway {
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly seen = new Map<string, number>()
  private readonly perHost: Limiter
  private readonly perAccount: Limiter
  private readonly perAddress: Limiter

  constructor(private readonly options: PushGatewayOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.warn(line))
    this.perHost = new Limiter(60_000, 60, this.now)
    this.perAccount = new Limiter(60_000, 300, this.now)
    this.perAddress = new Limiter(60_000, 300, this.now)
  }

  private refuse(response: ServerResponse, reason: PushRefusal): void {
    sendJson(response, this.options.origin.startsWith('https:'), STATUS[reason], { error: reason })
  }

  /** Whether a signature was seen within the clock window; remembers it either way. */
  private replayed(signature: string): boolean {
    const now = this.now()
    for (const [key, at] of this.seen) if (at <= now - 2 * MAX_CLOCK_SKEW_MS) this.seen.delete(key)
    const key = sha256Hex(signature)
    if (this.seen.has(key)) return true
    this.seen.set(key, now)
    return false
  }

  /** POST /v1/push */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = clientAddress(request, this.options.trustProxy)
    if (!this.perAddress.hit(address)) return this.refuse(response, 'too_many')
    let body: string
    try {
      body = (await readBody(request, MAX_PUSH_BODY)).toString('utf8')
    } catch (error) {
      if (error instanceof TooBig) return this.refuse(response, 'too_big')
      throw error
    }
    if (!this.options.auth.accessFamily(request)) return this.refuse(response, 'signed_out')

    const keyHeader = request.headers[HOST_KEY_HEADER.toLowerCase()]
    const signatureHeader = request.headers[SIGNATURE_HEADER.toLowerCase()]
    const key = typeof keyHeader === 'string' ? decodeRelayBytes(keyHeader) : null
    const signature = typeof signatureHeader === 'string' ? decodeRelayBytes(signatureHeader) : null
    if (!key || key.length !== 32 || !signature || signature.length !== 64) {
      return this.refuse(response, 'unauthorized')
    }
    const id = await relayHostId(key)
    const signed = pushRequestText(this.options.origin, id, body)
    if (!(await verifyRelaySignature(key, signature, signed))) {
      return this.refuse(response, 'unauthorized')
    }
    const parsed = parsePushRequest(body)
    if (!parsed) return this.refuse(response, 'malformed')
    if (Math.abs(this.now() - parsed.time) > MAX_CLOCK_SKEW_MS) {
      return this.refuse(response, 'unauthorized')
    }
    if (this.replayed(signatureHeader as string)) return this.refuse(response, 'unauthorized')
    if (!this.perHost.hit(id) || !this.perAccount.hit('account')) {
      return this.refuse(response, 'too_many')
    }
    const apns = this.options.apns
    if (!apns) return this.refuse(response, 'apns')
    const result = await apns.send(apnsMessage(parsed, apns.topic, this.now()))
    if (result.ok) return sendJson(response, this.options.origin.startsWith('https:'), 200, {})
    this.log(`huli-cloud: APNs refused a push: ${result.status} ${result.reason}`)
    this.refuse(response, result.gone ? 'unregistered' : 'apns')
  }
}
