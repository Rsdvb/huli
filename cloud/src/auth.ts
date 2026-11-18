// Sign-in as Kettu's clients speak it: the browser sign-in with PKCE and a loopback redirect
// (RFC 6749, 7636, 8252), device codes (RFC 8628), refresh with rotation, revocation (RFC 7009)
// and /api/v1/me; and the web pages a person signs in to with a password and a one-time code.

import { randomInt } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { clientInfo, DAEMON_CLIENT, DESKTOP_CLIENT, WEB_CLIENT } from '@shared/account-api'
import {
  MOBILE_CLIENT,
  MOBILE_REDIRECT,
  WEB_CALLBACK_PATH,
  type HuliClientInfo,
} from '@shared/huli-cloud'
import {
  bearer,
  clientAddress,
  cookies,
  Limiter,
  pageCsp,
  readForm,
  redirect,
  sendError,
  sendHtml,
  sendJson,
  sessionCookie,
} from './http'
import {
  consentPage,
  describeClient,
  deviceConfirmPage,
  devicePage,
  devicesPage,
  loginPage,
  messagePage,
  printable,
} from './pages'
import {
  checkTotp,
  normalizeRecovery,
  PKCE_CHALLENGE,
  PKCE_VERIFIER,
  pkceChallenge,
  randomToken,
  sameText,
  sha256Hex,
  verifyPassword,
} from './secrets'
import type { Store } from './store'

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const SESSION_COOKIE = 'huli_session'
const SESSION_MS = 12 * 60 * 60 * 1000
const TICKET_MS = 10 * 60 * 1000
const CODE_MS = 60 * 1000
const DEVICE_MS = 10 * 60 * 1000
const DEVICE_INTERVAL_S = 5
const MAX_TICKET_TRIES = 5
/** Sign-in pages open at once, from one address and in all; the oldest goes first. */
const MAX_TICKETS_PER_ADDRESS = 20
const MAX_TICKETS = 1000
/** Device sign-ins waiting at once; each address may start only so many an hour besides. */
const MAX_DEVICE_GRANTS = 1000
/** Password checks at once: each takes 32 MiB and tens of milliseconds of the thread pool. */
const MAX_VERIFYING = 2
const SWEEP_MS = 60_000
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

/** Clients that use device codes; those that sign in through the browser are `redirectFor`'s. */
const DEVICE_CLIENTS = new Set([DAEMON_CLIENT])

interface Ticket {
  params: AuthorizeParams
  address: string
  expiresAt: number
  tries: number
}

interface AuthorizeParams {
  clientId: string
  redirectUri: string
  challenge: string
  state: string
  info: HuliClientInfo | null
}

interface Code {
  clientId: string
  redirectUri: string
  challenge: string
  info: HuliClientInfo | null
  expiresAt: number
}

interface DeviceGrant {
  userCode: string
  clientId: string
  info: HuliClientInfo | null
  /** Where the device sign-in was started from, and when, for the page that approves it. */
  address: string
  startedAt: number
  expiresAt: number
  interval: number
  lastPoll: number
  status: 'pending' | 'approved' | 'denied'
}

interface Session {
  csrf: string
  expiresAt: number
}

interface LoginFailure {
  status: 401 | 429
  message: string
}

export interface AuthOptions {
  store: Store
  origin: string
  trustProxy: boolean
  /** The hosted web client's origin; without one `kettu-web` cannot sign in. */
  webOrigin?: string | null
  /** Whether one of the account's computers is on the relay now, for the account page. */
  online?: (id: string) => boolean
  /** A device was signed out: its hosts and connections leave the relay now. */
  revoked?: () => void
  now?: () => number
  log?: (line: string) => void
}

/**
 * The redirect URI a client that signs in through the browser may name, as it must be named:
 * the desktop app's loopback server, the hosted web client's callback page at its origin alone,
 * or the phone app's own URL. Null for any other, and for a client that does not sign in so.
 */
export function redirectFor(
  clientId: string,
  uri: string,
  webOrigin: string | null,
): string | null {
  switch (clientId) {
    case DESKTOP_CLIENT:
      return loopbackRedirect(uri)
    case WEB_CLIENT:
      return webOrigin && uri === `${webOrigin}${WEB_CALLBACK_PATH}` ? uri : null
    case MOBILE_CLIENT:
      return uri === MOBILE_REDIRECT ? uri : null
    default:
      return null
  }
}

/** A loopback redirect URI as RFC 8252 7.3 has it: http, a loopback host, any port, /callback. */
export function loopbackRedirect(uri: string): string | null {
  const parsed = URL.parse(uri)
  if (!parsed || parsed.protocol !== 'http:') return null
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return null
  if (parsed.username || parsed.password || parsed.hash || parsed.search) return null
  if (parsed.pathname !== '/callback' || !parsed.port) return null
  return parsed.href
}

function parseClientInfo(text: string | null): HuliClientInfo | null {
  if (!text || text.length > 2000) return null
  try {
    const value = JSON.parse(text) as Partial<HuliClientInfo>
    if (
      !['desktop', 'daemon', 'web', 'mobile'].includes(value.kind ?? '') ||
      typeof value.name !== 'string' ||
      typeof value.os !== 'string' ||
      typeof value.arch !== 'string'
    ) {
      return null
    }
    // The phone's kind is Huli's own; the rest of its description is cut as Kettu's are.
    // Control characters go before anything is kept or logged.
    const { kind } = value as HuliClientInfo
    const info = clientInfo({
      kind: kind === 'mobile' ? 'web' : kind,
      name: printable(value.name),
      os: printable(value.os),
      arch: printable(value.arch),
      version: typeof value.version === 'string' ? printable(value.version) : null,
      ...(typeof value.user === 'string' ? { user: printable(value.user) } : {}),
    })
    return { ...info, kind }
  } catch {
    return null
  }
}

function withQuery(uri: string, params: Record<string, string>): string {
  const url = new URL(uri)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.href
}

export class Auth {
  private readonly store: Store
  private readonly webOrigin: string | null
  private readonly signInHeaders: Record<string, string>
  private readonly secure: boolean
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly tickets = new Map<string, Ticket>()
  private readonly codes = new Map<string, Code>()
  private readonly devices = new Map<string, DeviceGrant>()
  private readonly userCodes = new Map<string, string>()
  private readonly sessions = new Map<string, Session>()
  // Sign-ins that did not succeed: five per address in 15 minutes. No limit holds for all
  // addresses together, as anyone with a few addresses could use it to lock the owner out.
  private readonly failedByAddress: Limiter
  private readonly deviceStarts: Limiter
  private verifying = 0
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(private readonly options: AuthOptions) {
    this.store = options.store
    this.webOrigin = options.webOrigin ?? null
    // The sign-in pages' forms answer with a redirect to the web client or the phone app too.
    this.signInHeaders = {
      'content-security-policy': pageCsp([
        ...(this.webOrigin ? [this.webOrigin] : []),
        `${new URL(MOBILE_REDIRECT).protocol}`,
      ]),
    }
    this.secure = options.origin.startsWith('https:')
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.warn(line))
    this.failedByAddress = new Limiter(15 * 60 * 1000, 5, this.now)
    this.deviceStarts = new Limiter(60 * 60 * 1000, 30, this.now)
    // On a timer rather than on each request, which anyone may send.
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS)
    this.sweeper.unref()
  }

  close(): void {
    clearInterval(this.sweeper)
  }

  /** The entry under `key` while it lasts; one past its time is dropped. */
  private live<T extends { expiresAt: number }>(map: Map<string, T>, key: string): T | undefined {
    const entry = map.get(key)
    if (!entry || entry.expiresAt > this.now()) return entry
    map.delete(key)
    return undefined
  }

  /** The device sign-in under `key` while it lasts, by its device code's hash. */
  private liveDevice(key: string | undefined): DeviceGrant | undefined {
    const device = key === undefined ? undefined : this.devices.get(key)
    if (!device || device.expiresAt > this.now()) return device
    this.devices.delete(key!)
    this.userCodes.delete(device.userCode)
    return undefined
  }

  /** Keeps a new ticket, dropping the oldest of its address's and of all over the caps. */
  private keepTicket(id: string, ticket: Ticket): void {
    const own = [...this.tickets].filter(([, kept]) => kept.address === ticket.address)
    for (const [old] of own.slice(0, Math.max(0, own.length + 1 - MAX_TICKETS_PER_ADDRESS))) {
      this.tickets.delete(old)
    }
    for (const old of this.tickets.keys()) {
      if (this.tickets.size < MAX_TICKETS) break
      this.tickets.delete(old)
    }
    this.tickets.set(id, ticket)
  }

  private sweep(): void {
    const now = this.now()
    for (const [k, v] of this.tickets) if (v.expiresAt <= now) this.tickets.delete(k)
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k)
    for (const [k, v] of this.sessions) if (v.expiresAt <= now) this.sessions.delete(k)
    for (const [k, v] of this.devices) {
      if (v.expiresAt <= now) {
        this.devices.delete(k)
        this.userCodes.delete(v.userCode)
      }
    }
  }

  // ---- Web sessions -------------------------------------------------------------------------

  private session(request: IncomingMessage): Session | null {
    const id = cookies(request).get(SESSION_COOKIE)
    if (!id) return null
    const session = this.sessions.get(sha256Hex(id))
    return session && session.expiresAt > this.now() ? session : null
  }

  private startSession(): { cookie: string; session: Session } {
    const id = randomToken()
    const session = { csrf: randomToken(18), expiresAt: this.now() + SESSION_MS }
    this.sessions.set(sha256Hex(id), session)
    return { cookie: sessionCookie(SESSION_COOKIE, id, SESSION_MS / 1000, this.secure), session }
  }

  private endSession(request: IncomingMessage): string {
    const id = cookies(request).get(SESSION_COOKIE)
    if (id) this.sessions.delete(sha256Hex(id))
    return sessionCookie(SESSION_COOKIE, '', 0, this.secure)
  }

  /**
   * Checks a password and a one-time or recovery code, counting failures; why it failed and the
   * status to answer, or null.
   */
  private async verifyLogin(
    request: IncomingMessage,
    password: string,
    code: string,
  ): Promise<LoginFailure | null> {
    const address = clientAddress(request, this.options.trustProxy)
    if (this.failedByAddress.blocked(address)) {
      this.log(`huli-cloud: login blocked from ${address}`)
      return { status: 401, message: '尝试次数太多，请过一会儿再试。' }
    }
    if (this.verifying >= MAX_VERIFYING) {
      return { status: 429, message: '正在验证别的登录，请过几秒再试。' }
    }
    // Counted before the password is checked, so that requests sent at once cannot all pass the
    // check above while the first wait for scrypt; taken back when the sign-in succeeds.
    this.failedByAddress.hit(address)
    const account = this.store.account
    const fail = (): LoginFailure => {
      this.log(`huli-cloud: login failed from ${address}`)
      return { status: 401, message: '密码或验证码不对。' }
    }
    const succeed = (): null => {
      this.failedByAddress.undo(address)
      return null
    }
    if (!account || password.length > 1024 || code.length > 64) return fail()
    this.verifying++
    try {
      if (!(await verifyPassword(password, account.password))) return fail()
    } finally {
      this.verifying--
    }
    const step = checkTotp(account.totp, code.trim(), this.now(), account.totpLastStep)
    if (step !== null) {
      this.store.updateAccount({ totpLastStep: step })
      return succeed()
    }
    const recovery = sha256Hex(normalizeRecovery(code))
    if (account.recovery.includes(recovery)) {
      this.store.updateAccount({ recovery: account.recovery.filter((r) => r !== recovery) })
      this.log('huli-cloud: a recovery code was used')
      return succeed()
    }
    return fail()
  }

  // ---- Browser sign-in ----------------------------------------------------------------------

  /** GET /signin/app/ */
  signInPage(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const q = url.searchParams
    if (q.get('done') === '1') {
      return sendHtml(
        response,
        this.secure,
        200,
        messagePage('已登录', '可以关掉这个页面，回到纸鸢了。'),
      )
    }
    if (q.get('cancelled') === '1') {
      return sendHtml(response, this.secure, 200, messagePage('已取消', '这次登录已取消。'))
    }
    const clientId = q.get('client_id') ?? ''
    const redirectUri = redirectFor(clientId, q.get('redirect_uri') ?? '', this.webOrigin)
    const challenge = q.get('code_challenge') ?? ''
    const state = q.get('state') ?? ''
    if (
      !redirectUri ||
      q.get('code_challenge_method') !== 'S256' ||
      !PKCE_CHALLENGE.test(challenge) ||
      !state ||
      state.length > 512
    ) {
      return sendHtml(
        response,
        this.secure,
        400,
        messagePage('无法登录', '这个登录请求不完整或不被接受。'),
      )
    }
    const params: AuthorizeParams = {
      clientId,
      redirectUri,
      challenge,
      state,
      info: parseClientInfo(q.get('client_info')),
    }
    const ticket = randomToken(18)
    this.keepTicket(ticket, {
      params,
      address: clientAddress(request, this.options.trustProxy),
      expiresAt: this.now() + TICKET_MS,
      tries: 0,
    })
    const session = this.session(request)
    const client = describeClient(params.info)
    if (session) {
      return sendHtml(
        response,
        this.secure,
        200,
        consentPage({ action: '/signin/app/', fields: { ticket, csrf: session.csrf }, client }),
        this.signInHeaders,
      )
    }
    sendHtml(
      response,
      this.secure,
      200,
      loginPage({ action: '/signin/app/', fields: { ticket }, purpose: `登录 ${client}` }),
      this.signInHeaders,
    )
  }

  /** POST /signin/app/ */
  async signInSubmit(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const ticketId = form.get('ticket') ?? ''
    const ticket = this.live(this.tickets, ticketId)
    if (!ticket) {
      return sendHtml(response, this.secure, 400, messagePage('登录已过期', '回到纸鸢重新点登录。'))
    }
    const { params } = ticket
    if (form.get('action') === 'deny') {
      this.tickets.delete(ticketId)
      return redirect(
        response,
        this.secure,
        withQuery(params.redirectUri, { error: 'access_denied', state: params.state }),
      )
    }
    const headers: Record<string, string> = {}
    const session = this.session(request)
    if (session) {
      if (!sameText(form.get('csrf') ?? '', session.csrf)) {
        return sendHtml(response, this.secure, 403, messagePage('无法登录', '页面已过期，请重试。'))
      }
    } else {
      const failure = await this.verifyLogin(
        request,
        form.get('password') ?? '',
        form.get('code') ?? '',
      )
      if (failure) {
        if (failure.status !== 429) ticket.tries++
        if (ticket.tries >= MAX_TICKET_TRIES) this.tickets.delete(ticketId)
        return sendHtml(
          response,
          this.secure,
          failure.status,
          loginPage({
            action: '/signin/app/',
            fields: { ticket: ticketId },
            purpose: `登录 ${describeClient(params.info)}`,
            error: failure.message,
          }),
          this.signInHeaders,
        )
      }
      headers['set-cookie'] = this.startSession().cookie
    }
    this.tickets.delete(ticketId)
    const code = randomToken()
    this.codes.set(sha256Hex(code), {
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      challenge: params.challenge,
      info: params.info,
      expiresAt: this.now() + CODE_MS,
    })
    this.log(`huli-cloud: signed in ${describeClient(params.info)}`)
    redirect(
      response,
      this.secure,
      withQuery(params.redirectUri, { code, state: params.state }),
      headers,
    )
  }

  // ---- Token endpoint -----------------------------------------------------------------------

  /** POST /api/oauth/token */
  async token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const grant = form.get('grant_type')
    const clientId = form.get('client_id') ?? ''
    const fail = (status: number, error: string, description: string, extra?: object) =>
      sendError(response, this.secure, status, error, description, extra as Record<string, unknown>)

    if (grant === 'authorization_code') {
      const codeText = form.get('code') ?? ''
      const key = sha256Hex(codeText)
      const code = this.live(this.codes, key)
      // A code is spent by its first use, whether that use succeeds or not.
      this.codes.delete(key)
      const verifier = form.get('code_verifier') ?? ''
      if (
        !code ||
        code.clientId !== clientId ||
        code.redirectUri !==
          redirectFor(clientId, form.get('redirect_uri') ?? '', this.webOrigin) ||
        !PKCE_VERIFIER.test(verifier) ||
        !sameText(pkceChallenge(verifier), code.challenge)
      ) {
        return fail(400, 'invalid_grant', 'The code is not valid.')
      }
      return sendJson(response, this.secure, 200, this.store.issue(code.clientId, code.info))
    }

    if (grant === 'refresh_token') {
      const result = this.store.refresh(clientId, form.get('refresh_token') ?? '')
      if (!result.ok) {
        if (result.reason === 'reused')
          this.log('huli-cloud: an old refresh token came back; signed that client out')
        return fail(400, 'invalid_grant', 'The refresh token is not valid.')
      }
      return sendJson(response, this.secure, 200, result.tokens)
    }

    if (grant === DEVICE_GRANT) {
      const key = sha256Hex(form.get('device_code') ?? '')
      const device = this.liveDevice(key)
      if (!device || device.clientId !== clientId) {
        return fail(400, 'expired_token', 'The device code has expired.')
      }
      const now = this.now()
      if (now - device.lastPoll < device.interval * 1000) {
        device.interval += 5
        device.lastPoll = now
        return fail(400, 'slow_down', 'Polling too fast.', { interval: device.interval })
      }
      device.lastPoll = now
      if (device.status === 'pending') {
        return fail(400, 'authorization_pending', 'Waiting for approval.')
      }
      this.devices.delete(key)
      this.userCodes.delete(device.userCode)
      if (device.status === 'denied') return fail(400, 'access_denied', 'The sign-in was refused.')
      return sendJson(response, this.secure, 200, this.store.issue(device.clientId, device.info))
    }

    fail(400, 'unsupported_grant_type', 'This grant type is not supported.')
  }

  // ---- Device codes -------------------------------------------------------------------------

  /** POST /api/oauth/device */
  async deviceStart(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const clientId = form.get('client_id') ?? ''
    if (!DEVICE_CLIENTS.has(clientId)) {
      return sendError(response, this.secure, 401, 'invalid_client', 'Unknown client.')
    }
    if (!this.deviceStarts.hit(clientAddress(request, this.options.trustProxy))) {
      return sendError(response, this.secure, 429, 'slow_down', 'Too many sign-ins started.')
    }
    const deviceCode = randomToken()
    let userCode: string
    do {
      let letters = ''
      for (let i = 0; i < 8; i++) {
        letters += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
      }
      userCode = `${letters.slice(0, 4)}-${letters.slice(4)}`
    } while (this.userCodes.has(userCode))
    const key = sha256Hex(deviceCode)
    for (const [old, grant] of this.devices) {
      if (this.devices.size < MAX_DEVICE_GRANTS) break
      this.devices.delete(old)
      this.userCodes.delete(grant.userCode)
    }
    this.devices.set(key, {
      userCode,
      clientId,
      info: parseClientInfo(form.get('client_info')),
      address: clientAddress(request, this.options.trustProxy),
      startedAt: this.now(),
      expiresAt: this.now() + DEVICE_MS,
      interval: DEVICE_INTERVAL_S,
      lastPoll: 0,
      status: 'pending',
    })
    this.userCodes.set(userCode, key)
    // No verification_uri_complete: a link with the code in it is what a phishing message sends.
    sendJson(response, this.secure, 200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${this.options.origin}/device`,
      expires_in: DEVICE_MS / 1000,
      interval: DEVICE_INTERVAL_S,
    })
  }

  private normalizeUserCode(text: string): string {
    const clean = text.toUpperCase().replace(/[^A-Z]/g, '')
    return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
  }

  /** GET /device: the code is typed in, never taken from the link. */
  devicePage(request: IncomingMessage, response: ServerResponse): void {
    const session = this.session(request)
    if (!session) {
      return sendHtml(
        response,
        this.secure,
        200,
        loginPage({ action: '/web/login', fields: { next: '/device' }, purpose: '登录后确认设备' }),
      )
    }
    sendHtml(response, this.secure, 200, devicePage({ csrf: session.csrf }))
  }

  /** POST /device */
  async deviceSubmit(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const session = this.session(request)
    if (!session || !sameText(form.get('csrf') ?? '', session.csrf)) {
      return redirect(response, this.secure, '/device')
    }
    const code = this.normalizeUserCode(form.get('user_code') ?? '')
    const device = this.liveDevice(this.userCodes.get(code))
    if (!device || device.status !== 'pending') {
      return sendHtml(
        response,
        this.secure,
        400,
        devicePage({ csrf: session.csrf, error: '验证码不对或已过期。' }),
      )
    }
    const action = form.get('action')
    if (action !== 'allow' && action !== 'deny') {
      // The code typed in: who asked for it, from where and when, before anything is allowed.
      return sendHtml(
        response,
        this.secure,
        200,
        deviceConfirmPage({
          csrf: session.csrf,
          code,
          client: describeClient(device.info),
          address: device.address,
          startedMsAgo: this.now() - device.startedAt,
        }),
      )
    }
    device.status = action === 'allow' ? 'approved' : 'denied'
    if (device.status === 'approved')
      this.log(`huli-cloud: approved ${describeClient(device.info)}`)
    sendHtml(
      response,
      this.secure,
      200,
      messagePage(
        device.status === 'approved' ? '已允许' : '已拒绝',
        device.status === 'approved' ? '回到命令行，它马上就会登录。' : '这台设备不会登录。',
      ),
    )
  }

  // ---- Web login for /device and /account ---------------------------------------------------

  private safeNext(next: string | null): string {
    return next && /^\/(device|account\/)/.test(next) && !next.startsWith('//')
      ? next
      : '/account/devices/'
  }

  /** POST /web/login */
  async webLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const next = this.safeNext(form.get('next'))
    const failure = await this.verifyLogin(
      request,
      form.get('password') ?? '',
      form.get('code') ?? '',
    )
    if (failure) {
      return sendHtml(
        response,
        this.secure,
        failure.status,
        loginPage({
          action: '/web/login',
          fields: { next },
          purpose: '登录',
          error: failure.message,
        }),
      )
    }
    redirect(response, this.secure, next, { 'set-cookie': this.startSession().cookie })
  }

  /** GET /account/ and /account/devices/ */
  accountPage(request: IncomingMessage, response: ServerResponse): void {
    const session = this.session(request)
    if (!session) {
      return sendHtml(
        response,
        this.secure,
        200,
        loginPage({
          action: '/web/login',
          fields: { next: '/account/devices/' },
          purpose: '登录后管理设备',
        }),
      )
    }
    sendHtml(
      response,
      this.secure,
      200,
      devicesPage({
        csrf: session.csrf,
        families: this.store.families(),
        computers: this.store
          .computers()
          .map((c) => ({ ...c, online: this.options.online?.(c.id) ?? false })),
        email: this.store.account?.email ?? '',
      }),
    )
  }

  /** POST /account/devices/revoke */
  async revokeDevice(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const session = this.session(request)
    if (session && sameText(form.get('csrf') ?? '', session.csrf)) {
      const family = form.get('family') ?? ''
      if (this.store.families().some((f) => f.id === family)) {
        this.store.revokeFamily(family)
        this.log('huli-cloud: a device was signed out from the web')
        this.options.revoked?.()
      }
    }
    redirect(response, this.secure, '/account/devices/')
  }

  /** POST /account/signout */
  async webSignOut(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const session = this.session(request)
    const headers: Record<string, string> = {}
    if (session && sameText(form.get('csrf') ?? '', session.csrf)) {
      headers['set-cookie'] = this.endSession(request)
    }
    redirect(response, this.secure, '/account/devices/', headers)
  }

  // ---- API --------------------------------------------------------------------------------

  /** POST /api/oauth/revoke: always 200, as RFC 7009 has it. */
  async revoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const token = form.get('token')
    if (token && token.length <= 4096) this.store.revokeToken(token)
    sendJson(response, this.secure, 200, {})
  }

  /** The family behind the request's bearer token, while it is live. */
  accessFamily(request: IncomingMessage): ReturnType<Store['checkAccess']> {
    const token = bearer(request)
    return token ? this.store.checkAccess(token) : null
  }

  /** The family behind the request's bearer token, or null after answering 401. */
  authorize(request: IncomingMessage, response: ServerResponse): ReturnType<Store['checkAccess']> {
    const family = this.accessFamily(request)
    if (!family) {
      sendError(response, this.secure, 401, 'unauthorized', 'The access token is not valid.')
      return null
    }
    return family
  }

  /** GET /api/v1/me */
  me(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorize(request, response)) return
    const account = this.store.account
    if (!account) {
      return sendError(response, this.secure, 401, 'unauthorized', 'No account.')
    }
    sendJson(response, this.secure, 200, {
      account: { id: account.id, email: account.email, name: account.name, avatarUrl: null },
      subscription: { status: 'active' },
      plan: null,
      usage: null,
      points: null,
    })
  }
}
