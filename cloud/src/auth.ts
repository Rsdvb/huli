// Sign-in as Kettu's clients speak it: the browser sign-in with PKCE and a loopback redirect
// (RFC 6749, 7636, 8252), device codes (RFC 8628), refresh with rotation, revocation (RFC 7009)
// and /api/v1/me; the web pages a person signs in to with a username and a password, and then a
// one-time code for an account with two-step verification (the owner's always); and signing up
// with an invite code the owner made, with a username and a password alone, inside the same
// browser sign-in, so that the client that opened it ends up signed in to the new account.
//
// Nothing tells whether an account exists, or has two-step verification, before its password is
// right: a username nobody has is checked and counted as an account would be, and every wrong
// password gets the same answer. Only a right one leads to the code's page.
//
// Every code, device code and web session names the account it was signed in to, and none is
// taken once that account is disabled or removed. Failed sign-ins, wrong passwords and wrong codes
// alike, are counted per address and account (or per username nobody has): five for one account
// from one address, ten from one address in all. One account's failures never block another's
// sign-in from elsewhere, and no limit holds for all addresses together, as anyone with a few
// addresses could use it to lock an account out. Password checks (scrypt, 32 MiB each) run two
// at a time per account, so a flood aimed at one account leaves the others' room. Invite codes
// are tried at most five times per address in 15 minutes and thirty times in all in an hour; a
// code is long enough that this never gets near one.

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
  codePage,
  consentPage,
  describeClient,
  deviceConfirmPage,
  devicePage,
  devicesPage,
  loginPage,
  messagePage,
  printable,
  signupPage,
} from './pages'
import {
  checkTotp,
  hashPassword,
  normalizeRecovery,
  PKCE_CHALLENGE,
  PKCE_VERIFIER,
  pkceChallenge,
  randomToken,
  sameText,
  sha256Hex,
  verifyPassword,
} from './secrets'
import { needsCode, normalizeUsername, passwordOnly, type Account, type Store } from './store'

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
/**
 * Password checks and hashes at once, in all and for one account (or for no account: a username
 * nobody has, and sign-ups): each takes 32 MiB and tens of milliseconds of the thread pool.
 */
const MAX_VERIFYING = 8
const MAX_VERIFYING_EACH = 2
/** Sign-ins between their right password and their one-time code, at once; how long each waits. */
const MAX_CODE_STEPS = 100
const CODE_STEP_MS = 5 * 60 * 1000
const MAX_CODE_TRIES = 5
export const MIN_PASSWORD = 12
const MAX_PASSWORD = 1024
const SWEEP_MS = 60_000
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
/** What attempts that name no account are counted under. */
const NO_ACCOUNT = '-'
/**
 * The hash a password is checked against for a username no account has, or an account waiting for
 * its reset, so that the answer takes as long as for one that has: scrypt of a random password no
 * one kept.
 */
const NO_PASSWORD =
  'scrypt$15$8$1$xgVQIS4rwZv3rd9FiVxPwA$mw727ttbzZ69ss3LLCTTkFIDG5qettd1lHUuufDcjEOO-m4I2x0O1h0C-REh3dgtjJeuTTsY1-Ec80UcIvZcLw'

/** The one answer to every wrong password, whether or not the account exists or has a code. */
const WRONG_LOGIN = '用户名或密码不对。'
const WRONG_CODE = '验证码不对：看验证器里这个账号最新的验证码，或输入一个没用过的恢复码。'
const TOO_MANY = '尝试次数太多，请过一会儿再试。'
const DISABLED = '这个账号已停用，请联系机主。'
const STEP_EXPIRED = '这次登录已过期，请重新输入密码。'

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

/**
 * What a code, an approved device code and a web session hold of their account: its id, and its
 * password's hash as it was then, so that none of them outlives a reset or a password change.
 */
interface Grant {
  account: string
  credential: string
}

interface Code extends Grant {
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
  /** The account that approved it. */
  grant: Grant | null
}

interface Session extends Grant {
  csrf: string
  expiresAt: number
}

/**
 * A sign-in whose password was right, waiting for the one-time or recovery code of its account,
 * which has two-step verification. It holds the password's hash as it was, as a grant does, so a
 * reset or a new password in between ends it.
 */
interface CodeStep extends Grant {
  /** The browser sign-in it is part of; null for the web pages' sign-in. */
  ticket: string | null
  /** Where the web pages' sign-in goes on to. */
  next: string
  username: string
  expiresAt: number
  tries: number
}

type Refused = { kind: 'failed'; status: 400 | 401 | 403 | 429; message: string }

/** The password checked: signed in, or a code to ask for next, or refused. */
type PasswordResult =
  { kind: 'done'; account: Account } | { kind: 'code'; account: Account } | Refused

/** The code checked: signed in, or another try at it, or refused and the password asked again. */
type CodeResult = { kind: 'done'; account: Account } | { kind: 'again'; message: string } | Refused

export interface AuthOptions {
  store: Store
  origin: string
  trustProxy: boolean
  /** The hosted web client's origin; without one `kettu-web` cannot sign in. */
  webOrigin?: string | null
  /** Whether one of the account's computers is on the relay now, for the account page. */
  online?: (id: string) => boolean
  /** A device was signed out, or an account reset: its hosts and connections leave the relay now. */
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
  private readonly codeSteps = new Map<string, CodeStep>()
  /** Failed sign-ins by address and account, and by address alone. */
  private readonly failedByAccount: Limiter
  private readonly failedByAddress: Limiter
  /** Invite codes refused, by address and in all. */
  private readonly signupsByAddress: Limiter
  private readonly signups: Limiter
  private readonly deviceStarts: Limiter
  /** Password checks running, by account (or NO_ACCOUNT), and in all. */
  private readonly verifying = new Map<string, number>()
  private verifyingAll = 0
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
    this.failedByAccount = new Limiter(15 * 60 * 1000, 5, this.now)
    this.failedByAddress = new Limiter(15 * 60 * 1000, 10, this.now)
    this.signupsByAddress = new Limiter(15 * 60 * 1000, 5, this.now)
    this.signups = new Limiter(60 * 60 * 1000, 30, this.now)
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
    for (const [k, v] of this.codeSteps) if (v.expiresAt <= now) this.codeSteps.delete(k)
    for (const [k, v] of this.devices) {
      if (v.expiresAt <= now) {
        this.devices.delete(k)
        this.userCodes.delete(v.userCode)
      }
    }
  }

  /** Takes one of the password checks an account (or NO_ACCOUNT) may run at once; false if none. */
  private takeSlot(bucket: string): boolean {
    const mine = this.verifying.get(bucket) ?? 0
    if (this.verifyingAll >= MAX_VERIFYING || mine >= MAX_VERIFYING_EACH) return false
    this.verifying.set(bucket, mine + 1)
    this.verifyingAll++
    return true
  }

  private releaseSlot(bucket: string): void {
    const left = (this.verifying.get(bucket) ?? 1) - 1
    if (left > 0) this.verifying.set(bucket, left)
    else this.verifying.delete(bucket)
    this.verifyingAll--
  }

  // ---- Web sessions -------------------------------------------------------------------------

  /** The request's web session and its account, while the session lasts and the account is active. */
  webSession(request: IncomingMessage): { session: Session; account: Account } | null {
    const id = cookies(request).get(SESSION_COOKIE)
    if (!id) return null
    const session = this.sessions.get(sha256Hex(id))
    if (!session || session.expiresAt <= this.now()) return null
    const account = this.granted(session)
    return account ? { session, account } : null
  }

  /** The account of a grant, while it is active and its password the one the grant was made under. */
  private granted(grant: Grant): Account | null {
    const account = this.store.activeAccount(grant.account)
    return account && account.password === grant.credential ? account : null
  }

  private grantOf(account: Account): Grant {
    return { account: account.id, credential: account.password ?? '' }
  }

  /** Whether a form posted from a page of `session` carries its CSRF token. */
  csrfOk(form: URLSearchParams, session: Session): boolean {
    return sameText(form.get('csrf') ?? '', session.csrf)
  }

  private startSession(account: Account): { cookie: string; session: Session } {
    const id = randomToken()
    const session = {
      csrf: randomToken(18),
      expiresAt: this.now() + SESSION_MS,
      ...this.grantOf(account),
    }
    this.sessions.set(sha256Hex(id), session)
    return { cookie: sessionCookie(SESSION_COOKIE, id, SESSION_MS / 1000, this.secure), session }
  }

  private endSession(request: IncomingMessage): string {
    const id = cookies(request).get(SESSION_COOKIE)
    if (id) this.sessions.delete(sha256Hex(id))
    return sessionCookie(SESSION_COOKIE, '', 0, this.secure)
  }

  /**
   * The first step of signing in: a username (empty for the owner) and a password, failures
   * counted by address and account. A username nobody has, or an account waiting for its reset,
   * is checked against NO_PASSWORD, and one nobody has counted under its own name as an account is
   * under its id, so that neither the answer, its time nor the limits tell whether it exists.
   * Only once the password is right does it matter whether the account takes a code.
   */
  private async checkPassword(
    request: IncomingMessage,
    login: string,
    password: string,
  ): Promise<PasswordResult> {
    const address = clientAddress(request, this.options.trustProxy)
    const found = login.length <= 256 ? this.store.findAccount(login) : null
    const bucket = found?.id ?? NO_ACCOUNT
    const key = `${address} ${found?.id ?? `?${login.trim().toLowerCase().slice(0, 256)}`}`
    if (this.failedByAddress.blocked(address) || this.failedByAccount.blocked(key)) {
      this.log(`huli-cloud: login blocked from ${address}`)
      return { kind: 'failed', status: 401, message: TOO_MANY }
    }
    if (!this.takeSlot(bucket)) {
      return { kind: 'failed', status: 429, message: '正在验证别的登录，请过几秒再试。' }
    }
    // Counted before the password is checked, so that requests sent at once cannot all pass the
    // check above while the first wait for scrypt; taken back when the password is right.
    this.failedByAddress.hit(address)
    this.failedByAccount.hit(key)
    const fail = (): PasswordResult => {
      this.log(`huli-cloud: login failed from ${address}`)
      return { kind: 'failed', status: 401, message: WRONG_LOGIN }
    }
    const checked = found?.password ?? null
    let passwordOk: boolean
    try {
      if (password.length > MAX_PASSWORD) return fail()
      passwordOk = await verifyPassword(password, checked ?? NO_PASSWORD)
    } finally {
      this.releaseSlot(bucket)
    }
    // As it is now: its password may have changed, or it been reset, while scrypt ran.
    const account = found && this.store.account(found.id)
    if (!account || !passwordOk || checked === null || account.password !== checked) {
      return fail()
    }
    this.failedByAddress.undo(address)
    this.failedByAccount.undo(key)
    // A disabled account says so only to whoever also has its code, when it takes one.
    if (needsCode(account)) return { kind: 'code', account }
    if (account.disabledAt !== null) return { kind: 'failed', status: 403, message: DISABLED }
    return { kind: 'done', account }
  }

  /** The second step begins, for an account whose password was right just now; the step's id. */
  private startCodeStep(account: Account, ticket: string | null, next: string): string {
    const id = randomToken(18)
    for (const old of this.codeSteps.keys()) {
      if (this.codeSteps.size < MAX_CODE_STEPS) break
      this.codeSteps.delete(old)
    }
    this.codeSteps.set(sha256Hex(id), {
      ...this.grantOf(account),
      ticket,
      next,
      username: account.username,
      expiresAt: this.now() + CODE_STEP_MS,
      tries: 0,
    })
    return id
  }

  /**
   * The second step of signing in: a one-time code, which works once, or a recovery code, used up.
   * A wrong one counts as a failed sign-in, as a wrong password does; MAX_CODE_TRIES end the step,
   * and the password is asked again.
   */
  private takeCode(
    request: IncomingMessage,
    key: string,
    step: CodeStep,
    code: string,
  ): CodeResult {
    const account = this.store.account(step.account)
    if (!account || account.password !== step.credential) {
      this.codeSteps.delete(key)
      return { kind: 'failed', status: 400, message: STEP_EXPIRED }
    }
    const address = clientAddress(request, this.options.trustProxy)
    const limit = `${address} ${account.id}`
    if (this.failedByAddress.blocked(address) || this.failedByAccount.blocked(limit)) {
      this.log(`huli-cloud: login blocked from ${address}`)
      this.codeSteps.delete(key)
      return { kind: 'failed', status: 401, message: TOO_MANY }
    }
    this.failedByAddress.hit(address)
    this.failedByAccount.hit(limit)
    if (!this.useCode(account, code.trim())) {
      this.log(`huli-cloud: login failed from ${address}`)
      if (++step.tries < MAX_CODE_TRIES) return { kind: 'again', message: WRONG_CODE }
      this.codeSteps.delete(key)
      return { kind: 'failed', status: 401, message: '验证码错了太多次，请重新登录。' }
    }
    this.failedByAddress.undo(address)
    this.failedByAccount.undo(limit)
    this.codeSteps.delete(key)
    if (account.disabledAt !== null) return { kind: 'failed', status: 403, message: DISABLED }
    return { kind: 'done', account }
  }

  /** Spends `code` as the account's one-time code or one of its recovery codes; false if neither. */
  private useCode(account: Account, code: string): boolean {
    if (code.length > 64) return false
    const step = account.totp
      ? checkTotp(account.totp, code, this.now(), account.totpLastStep)
      : null
    if (step !== null) {
      this.store.updateAccount(account.id, { totpLastStep: step })
      return true
    }
    const recovery = sha256Hex(normalizeRecovery(code))
    if (!account.recovery.includes(recovery)) return false
    this.store.updateAccount(account.id, {
      recovery: account.recovery.filter((r) => r !== recovery),
    })
    this.log('huli-cloud: a recovery code was used')
    return true
  }

  // ---- Browser sign-in ----------------------------------------------------------------------

  /** GET /signin/app/; `mode=register` opens on signing up with an invite code. */
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
    if (q.get('mode') === 'register') return this.signupForm(response, ticket)
    const web = this.webSession(request)
    const client = describeClient(params.info)
    if (web) {
      return sendHtml(
        response,
        this.secure,
        200,
        consentPage({
          action: '/signin/app/',
          fields: { ticket, csrf: web.session.csrf },
          client,
          username: web.account.username,
        }),
        this.signInHeaders,
      )
    }
    this.loginForm(response, ticket, params)
  }

  private loginForm(
    response: ServerResponse,
    ticket: string,
    params: AuthorizeParams,
    status = 200,
    failure: { error: string; username: string } | null = null,
    headers: Record<string, string> = {},
  ): void {
    sendHtml(
      response,
      this.secure,
      status,
      loginPage({
        action: '/signin/app/',
        fields: { ticket },
        purpose: `登录 ${describeClient(params.info)}`,
        ...(failure ?? {}),
      }),
      { ...this.signInHeaders, ...headers },
    )
  }

  private signupForm(
    response: ServerResponse,
    ticket: string,
    status = 200,
    failure: { error: string; username: string } | null = null,
  ): void {
    sendHtml(
      response,
      this.secure,
      status,
      signupPage({ ticket, ...(failure ?? {}) }),
      this.signInHeaders,
    )
  }

  /**
   * The page that asks for the code, its form posting the step's id back: to the browser sign-in
   * of `where`'s ticket, or to the web pages' sign-in going on to `where`'s next.
   */
  private codeForm(
    response: ServerResponse,
    step: string,
    where: { ticket: string } | { next: string },
    username: string,
    error?: string,
  ): void {
    const browser = 'ticket' in where
    sendHtml(
      response,
      this.secure,
      error ? 401 : 200,
      codePage({
        action: browser ? '/signin/app/' : '/web/login',
        fields: { ...where, step },
        username,
        cancel: browser,
        ...(error ? { error } : {}),
      }),
      browser ? this.signInHeaders : {},
    )
  }

  /** A failed try on a sign-in page; MAX_TICKET_TRIES of them end it. */
  private failedTry(ticketId: string, ticket: Ticket): void {
    if (++ticket.tries >= MAX_TICKET_TRIES) this.tickets.delete(ticketId)
  }

  /** The browser sign-in ends as `account`: a code for its client, on the client's redirect. */
  private finish(
    response: ServerResponse,
    ticketId: string,
    params: AuthorizeParams,
    account: Account,
    headers: Record<string, string> = {},
  ): void {
    this.tickets.delete(ticketId)
    const code = randomToken()
    this.codes.set(sha256Hex(code), {
      ...this.grantOf(account),
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      challenge: params.challenge,
      info: params.info,
      expiresAt: this.now() + CODE_MS,
    })
    this.log(`huli-cloud: signed in ${describeClient(params.info)} as ${account.username}`)
    redirect(
      response,
      this.secure,
      withQuery(params.redirectUri, { code, state: params.state }),
      headers,
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
    switch (form.get('action')) {
      case 'deny':
        this.tickets.delete(ticketId)
        return redirect(
          response,
          this.secure,
          withQuery(params.redirectUri, { error: 'access_denied', state: params.state }),
        )
      case 'signup':
        return this.signupForm(response, ticketId)
      case 'login':
        return this.loginForm(response, ticketId, params)
      case 'switch':
        return this.loginForm(response, ticketId, params, 200, null, {
          'set-cookie': this.endSession(request),
        })
      case 'signup-submit':
        return await this.signUp(request, response, ticketId, ticket, form)
      case 'code':
        return this.codeSubmit(request, response, ticketId, ticket, form)
    }
    const web = this.webSession(request)
    if (web) {
      if (!this.csrfOk(form, web.session)) {
        return sendHtml(response, this.secure, 403, messagePage('无法登录', '页面已过期，请重试。'))
      }
      return this.finish(response, ticketId, params, web.account)
    }
    const username = form.get('username') ?? ''
    const result = await this.checkPassword(request, username, form.get('password') ?? '')
    switch (result.kind) {
      case 'failed':
        if (result.status !== 429) this.failedTry(ticketId, ticket)
        return this.loginForm(response, ticketId, params, result.status, {
          error: result.message,
          username: username.slice(0, 256),
        })
      case 'code': {
        ticket.expiresAt = this.now() + TICKET_MS
        const step = this.startCodeStep(result.account, ticketId, '')
        return this.codeForm(response, step, { ticket: ticketId }, result.account.username)
      }
      case 'done':
        return this.finish(response, ticketId, params, result.account, {
          'set-cookie': this.startSession(result.account).cookie,
        })
    }
  }

  /** The code's page of the browser sign-in posted. */
  private codeSubmit(
    request: IncomingMessage,
    response: ServerResponse,
    ticketId: string,
    ticket: Ticket,
    form: URLSearchParams,
  ): void {
    const id = form.get('step') ?? ''
    const key = sha256Hex(id)
    const step = this.live(this.codeSteps, key)
    if (!step || step.ticket !== ticketId) {
      return this.loginForm(response, ticketId, ticket.params, 400, {
        error: STEP_EXPIRED,
        username: '',
      })
    }
    const result = this.takeCode(request, key, step, form.get('code') ?? '')
    switch (result.kind) {
      case 'again':
        this.failedTry(ticketId, ticket)
        return this.codeForm(response, id, { ticket: ticketId }, step.username, result.message)
      case 'failed':
        if (result.status !== 400) this.failedTry(ticketId, ticket)
        return this.loginForm(response, ticketId, ticket.params, result.status, {
          error: result.message,
          username: step.username,
        })
      case 'done':
        return this.finish(response, ticketId, ticket.params, result.account, {
          'set-cookie': this.startSession(result.account).cookie,
        })
    }
  }

  // ---- Signing up with an invite code -------------------------------------------------------

  /**
   * The sign-up form posted: an invite code, which is counted against the address and in all
   * unless it is one that can be used, a username and a password. The invite is used then, once,
   * the account made or reset with the password alone, and the sign-in goes on as that account.
   */
  private async signUp(
    request: IncomingMessage,
    response: ServerResponse,
    ticketId: string,
    ticket: Ticket,
    form: URLSearchParams,
  ): Promise<void> {
    const address = clientAddress(request, this.options.trustProxy)
    const typed = (form.get('username') ?? '').slice(0, 32)
    const again = (error: string, status = 400) =>
      this.signupForm(response, ticketId, status, { error, username: typed })
    if (this.signupsByAddress.blocked(address) || this.signups.blocked(NO_ACCOUNT)) {
      this.log(`huli-cloud: signup blocked from ${address}`)
      return again(TOO_MANY, 429)
    }
    this.signupsByAddress.hit(address)
    this.signups.hit(NO_ACCOUNT)
    const invite = this.store.openInvite((form.get('invite') ?? '').slice(0, 64))
    if (!invite) {
      this.log(`huli-cloud: signup failed from ${address}`)
      this.failedTry(ticketId, ticket)
      return again('邀请码不对、已经用过或已经过期。', 401)
    }
    this.signupsByAddress.undo(address)
    this.signups.undo(NO_ACCOUNT)
    ticket.expiresAt = this.now() + TICKET_MS
    const username = normalizeUsername(typed)
    if (!username) {
      return again('用户名要 2 到 32 位：字母、数字或 . _ -，以字母或数字开头。')
    }
    if (invite.account !== null) {
      const target = this.store.account(invite.account)
      if (target?.username !== username) {
        return again(`这个邀请码用来重设账号「${target?.username ?? ''}」，用户名要填它。`)
      }
    } else if (!this.store.usernameFree(username)) {
      return again('这个用户名已经有人用了，换一个。')
    }
    const password = form.get('password') ?? ''
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      return again(`密码至少 ${MIN_PASSWORD} 位。`)
    }
    if (password !== form.get('password2')) return again('两次输入的密码不一样。')
    if (!this.takeSlot(NO_ACCOUNT)) return again('正在验证别的登录，请过几秒再试。', 429)
    let hash: string
    try {
      hash = await hashPassword(password)
    } finally {
      this.releaseSlot(NO_ACCOUNT)
    }
    // The sign-in may have ended, or gone on as another form posted at once, while scrypt ran.
    if (this.live(this.tickets, ticketId) !== ticket) {
      return sendHtml(response, this.secure, 400, messagePage('登录已过期', '回到纸鸢重新点登录。'))
    }
    // Checked once more as it is used: the invite may have been used or revoked since.
    const result = this.store.redeemInvite(invite.id, username, passwordOnly(hash))
    if (!result.ok) {
      const error = {
        invite: '邀请码刚刚被用掉或撤销了。',
        username: '这个用户名刚刚被别人用了，换一个。',
        full: '账号已经满了，请联系机主。',
      }[result.reason]
      return again(error, 409)
    }
    const { account, reset } = result
    this.log(`huli-cloud: ${reset ? 'reset' : 'signed up'} account ${account.username}`)
    // Whatever was signed in to a reset account is out, on the relay too.
    if (reset) this.options.revoked?.()
    if (account.disabledAt !== null) {
      return sendHtml(
        response,
        this.secure,
        200,
        messagePage('账号已重设', '这个账号目前停用中，请联系机主。'),
      )
    }
    this.finish(response, ticketId, ticket.params, account, {
      'set-cookie': this.startSession(account).cookie,
    })
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
      // Its account may have been disabled, removed or reset within the minute.
      const tokens = this.granted(code)
        ? this.store.issue(code.account, code.clientId, code.info)
        : null
      if (!tokens) return fail(400, 'invalid_grant', 'The code is not valid.')
      return sendJson(response, this.secure, 200, tokens)
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
      const tokens =
        device.status === 'approved' && device.grant && this.granted(device.grant)
          ? this.store.issue(device.grant.account, device.clientId, device.info)
          : null
      if (!tokens) return fail(400, 'access_denied', 'The sign-in was refused.')
      return sendJson(response, this.secure, 200, tokens)
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
      grant: null,
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
    const web = this.webSession(request)
    if (!web) {
      return sendHtml(
        response,
        this.secure,
        200,
        loginPage({ action: '/web/login', fields: { next: '/device' }, purpose: '登录后确认设备' }),
      )
    }
    sendHtml(response, this.secure, 200, devicePage({ csrf: web.session.csrf }))
  }

  /** POST /device */
  async deviceSubmit(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const web = this.webSession(request)
    if (!web || !this.csrfOk(form, web.session)) {
      return redirect(response, this.secure, '/device')
    }
    const { session, account } = web
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
          username: account.username,
        }),
      )
    }
    device.status = action === 'allow' ? 'approved' : 'denied'
    if (device.status === 'approved') {
      device.grant = this.grantOf(account)
      this.log(`huli-cloud: approved ${describeClient(device.info)} as ${account.username}`)
    }
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

  private webLoginForm(
    response: ServerResponse,
    next: string,
    failure: Refused & { username: string },
  ): void {
    sendHtml(
      response,
      this.secure,
      failure.status,
      loginPage({
        action: '/web/login',
        fields: { next },
        purpose: '登录',
        username: failure.username,
        error: failure.message,
      }),
    )
  }

  /** POST /web/login: the password, and then, for an account that takes one, the code. */
  async webLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const next = this.safeNext(form.get('next'))
    const id = form.get('step')
    if (id !== null) {
      const key = sha256Hex(id)
      const step = this.live(this.codeSteps, key)
      if (!step || step.ticket !== null) {
        return this.webLoginForm(response, next, {
          kind: 'failed',
          status: 400,
          message: STEP_EXPIRED,
          username: '',
        })
      }
      const result = this.takeCode(request, key, step, form.get('code') ?? '')
      switch (result.kind) {
        case 'again':
          return this.codeForm(response, id, { next: step.next }, step.username, result.message)
        case 'failed':
          return this.webLoginForm(response, step.next, { ...result, username: step.username })
        case 'done':
          return redirect(response, this.secure, step.next, {
            'set-cookie': this.startSession(result.account).cookie,
          })
      }
    }
    const username = form.get('username') ?? ''
    const result = await this.checkPassword(request, username, form.get('password') ?? '')
    switch (result.kind) {
      case 'failed':
        return this.webLoginForm(response, next, { ...result, username: username.slice(0, 256) })
      case 'code': {
        const step = this.startCodeStep(result.account, null, next)
        return this.codeForm(response, step, { next }, result.account.username)
      }
      case 'done':
        return redirect(response, this.secure, next, {
          'set-cookie': this.startSession(result.account).cookie,
        })
    }
  }

  /** GET /account/ and /account/devices/ */
  accountPage(request: IncomingMessage, response: ServerResponse): void {
    const web = this.webSession(request)
    if (!web) {
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
    const { session, account } = web
    sendHtml(
      response,
      this.secure,
      200,
      devicesPage({
        csrf: session.csrf,
        families: this.store.families(account.id),
        computers: this.store
          .computers(account.id)
          .map((c) => ({ ...c, online: this.options.online?.(c.id) ?? false })),
        account,
      }),
    )
  }

  /** POST /account/devices/revoke: a device of the session's own account alone. */
  async revokeDevice(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const web = this.webSession(request)
    if (web && this.csrfOk(form, web.session)) {
      const family = form.get('family') ?? ''
      if (this.store.families(web.account.id).some((f) => f.id === family)) {
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
    const web = this.webSession(request)
    const headers: Record<string, string> = {}
    if (web && this.csrfOk(form, web.session)) {
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

  /** The family behind the request's bearer token, while it is live and its account active. */
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

  /** GET /api/v1/me: the account the token was signed in to. */
  me(request: IncomingMessage, response: ServerResponse): void {
    const family = this.authorize(request, response)
    if (!family) return
    const account = this.store.activeAccount(family.account)
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
