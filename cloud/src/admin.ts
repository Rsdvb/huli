// The owner's account management, one request at a time, from the `huli-cloud` commands run on the
// server and from the owner's web page. A command sends its request over a Unix socket in the data
// folder (mode 0600, in a folder only the service's user opens) to the running service, which
// applies it to the state it holds, the one copy that is written, and at once drops on the relay
// whatever it ended; with the service stopped, the command applies it to state.json itself.
// Passwords and TOTP secrets travel only as what the command made of them at the server's own
// terminal, never as its arguments.

import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'
import { errorTrace } from './http'
import {
  MAX_INVITE_DAYS,
  normalizeUsername,
  type Credentials,
  type InviteStatus,
  type Store,
} from './store'

const MAX_MESSAGE = 64 * 1024
const TIMEOUT_MS = 15_000

export type AdminRequest =
  | { op: 'list' }
  | { op: 'invite'; days: number }
  | { op: 'uninvite'; id: string }
  | { op: 'disable' | 'enable' | 'remove' | 'signout'; username: string }
  | { op: 'reset'; username: string; days: number }
  | {
      op: 'init'
      force: boolean
      username: string
      email: string
      name: string | null
      credentials: Credentials
    }
  | { op: 'passwd'; password: string }
  | { op: 'totp'; totp: string; totpLastStep: number; recovery: string[] }

export interface AccountRow {
  username: string
  email: string
  owner: boolean
  state: 'active' | 'disabled' | 'reset'
  createdAt: number
  devices: number
  computers: number
  pushTargets: number
}

export interface InviteRow {
  id: string
  /** The username of the account it resets; null for a new account. */
  resets: string | null
  status: InviteStatus
  createdAt: number
  expiresAt: number
  usedAt: number | null
  usedBy: string | null
}

export interface AdminAnswer {
  accounts?: AccountRow[]
  invites?: InviteRow[]
  /** A new invite code, shown once. */
  code?: string
  invite?: InviteRow
  signedOut?: number
}

export type AdminResponse = { ok: true; answer: AdminAnswer } | { ok: false; error: string }

export interface AdminContext {
  store: Store
  /** Something of an account ended: its hosts and devices leave the relay now. */
  kicked(): void
}

const isText = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length <= max
const isHashList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 32 && value.every((v) => isText(v, 128))
const isDays = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_INVITE_DAYS

function isCredentials(value: unknown): value is Credentials {
  const c = value as Partial<Credentials> | null
  return (
    typeof c === 'object' &&
    c !== null &&
    isText(c.password) &&
    c.password.startsWith('scrypt$') &&
    isText(c.totp, 128) &&
    typeof c.totpLastStep === 'number' &&
    isHashList(c.recovery)
  )
}

/** A request as it came over the socket; null for anything that is not one. */
export function parseAdminRequest(value: unknown): AdminRequest | null {
  const r = value as Record<string, unknown> | null
  if (typeof r !== 'object' || r === null) return null
  switch (r.op) {
    case 'list':
      return { op: 'list' }
    case 'invite':
      return isDays(r.days) ? { op: 'invite', days: r.days } : null
    case 'uninvite':
      return isText(r.id, 64) ? { op: 'uninvite', id: r.id } : null
    case 'disable':
    case 'enable':
    case 'remove':
    case 'signout':
      return isText(r.username, 64) ? { op: r.op, username: r.username } : null
    case 'reset':
      return isText(r.username, 64) && isDays(r.days)
        ? { op: 'reset', username: r.username, days: r.days }
        : null
    case 'init':
      return typeof r.force === 'boolean' &&
        isText(r.username, 64) &&
        isText(r.email) &&
        (r.name === null || isText(r.name)) &&
        isCredentials(r.credentials)
        ? {
            op: 'init',
            force: r.force,
            username: r.username,
            email: r.email,
            name: r.name,
            credentials: r.credentials,
          }
        : null
    case 'passwd':
      return isText(r.password) && r.password.startsWith('scrypt$')
        ? { op: 'passwd', password: r.password }
        : null
    case 'totp':
      return isText(r.totp, 128) && typeof r.totpLastStep === 'number' && isHashList(r.recovery)
        ? { op: 'totp', totp: r.totp, totpLastStep: r.totpLastStep, recovery: r.recovery }
        : null
    default:
      return null
  }
}

/** The account rows and invite rows of the account list. */
export function listAccounts(store: Store): Required<Pick<AdminAnswer, 'accounts' | 'invites'>> {
  const accounts = store.accounts().map((account): AccountRow => ({
    username: account.username,
    email: account.email,
    owner: account.owner,
    state: account.disabledAt !== null ? 'disabled' : account.password ? 'active' : 'reset',
    createdAt: account.createdAt,
    ...store.holdings(account.id),
  }))
  return { accounts, invites: store.invites().map((invite) => inviteRow(store, invite.id)!) }
}

function inviteRow(store: Store, id: string): InviteRow | null {
  const invite = store.invites().find((i) => i.id === id)
  if (!invite) return null
  const name = (account: string | null) =>
    account === null ? null : (store.account(account)?.username ?? null)
  return {
    id: invite.id,
    resets: name(invite.account),
    status: store.inviteStatus(invite),
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    usedAt: invite.usedAt,
    usedBy: name(invite.usedBy),
  }
}

/** Applies one request to the store; what it did, or why not. */
export function runAdmin(context: AdminContext, request: AdminRequest): AdminResponse {
  const { store } = context
  const fail = (error: string): AdminResponse => ({ ok: false, error })
  const done = (answer: AdminAnswer = {}): AdminResponse => ({ ok: true, answer })
  const named = (username: string) => {
    const name = normalizeUsername(username)
    return name ? (store.accounts().find((a) => a.username === name) ?? null) : null
  }
  switch (request.op) {
    case 'list':
      return done(listAccounts(store))
    case 'invite': {
      const made = store.createInvite(request.days)
      if (!made) return fail('未使用的邀请码太多了，先撤销几个。')
      return done({ code: made.code, invite: inviteRow(store, made.invite.id)! })
    }
    case 'uninvite':
      return store.revokeInvite(request.id) ? done() : fail('没有这个未使用的邀请码。')
    case 'init': {
      const before = store.owner()
      if (before && !request.force) {
        return fail('账号已经存在。要重建机主账号请加 --force（机主的所有设备都会退出登录）。')
      }
      const name = normalizeUsername(request.username)
      const clash = name && store.accounts().find((a) => a.username === name && !a.owner)
      if (!name || clash) return fail('这个用户名不能用，或已经是别的账号的。')
      store.setOwner({
        username: name,
        email: request.email,
        name: request.name,
        credentials: request.credentials,
      })
      context.kicked()
      return done()
    }
    case 'passwd':
    case 'totp': {
      const owner = store.owner()
      if (!owner) return fail('还没有账号，先运行 init。')
      store.updateAccount(
        owner.id,
        request.op === 'passwd'
          ? { password: request.password }
          : { totp: request.totp, totpLastStep: request.totpLastStep, recovery: request.recovery },
      )
      return done()
    }
  }
  const account = named(request.username)
  if (!account) return fail(`没有账号 ${request.username}。`)
  switch (request.op) {
    case 'signout': {
      const signedOut = store.signOutAccount(account.id)
      context.kicked()
      return done({ signedOut })
    }
    case 'disable':
    case 'enable':
      if (account.owner) return fail('机主账号不能停用。')
      store.setDisabled(account.id, request.op === 'disable')
      context.kicked()
      return done()
    case 'remove': {
      if (account.owner) return fail('机主账号不能删除（要重建用 init --force）。')
      const { devices } = store.holdings(account.id)
      store.removeAccount(account.id)
      context.kicked()
      return done({ signedOut: devices })
    }
    case 'reset': {
      if (account.owner) return fail('机主账号用 passwd 和 totp 修改。')
      const made = store.resetAccount(account.id, request.days)
      if (!made) return fail(`没有账号 ${request.username}。`)
      context.kicked()
      return done({
        code: made.code,
        invite: inviteRow(store, made.invite.id)!,
        signedOut: made.signedOut,
      })
    }
  }
}

/** Where the service listens for the commands: a socket in the data folder (a pipe on Windows). */
export function adminSocketPath(dataDir: string): string {
  if (process.platform !== 'win32') return path.join(dataDir, 'admin.sock')
  const tag = createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16)
  return `\\\\.\\pipe\\huli-cloud-admin-${tag}`
}

/** Reads one line of at most MAX_MESSAGE bytes from a socket. */
function readLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      text += chunk
      const end = text.indexOf('\n')
      if (end >= 0) return resolve(text.slice(0, end))
      if (text.length > MAX_MESSAGE) reject(new Error('too long'))
    })
    socket.on('end', () => resolve(text))
    socket.on('error', reject)
  })
}

/** Listens for the commands' requests and answers each with what `handle` made of it. */
export function listenAdmin(
  socketPath: string,
  handle: (request: AdminRequest) => AdminResponse,
  log: (line: string) => void,
): Server {
  if (process.platform !== 'win32') {
    try {
      // What a service before left behind; anything else at that name is not ours to remove.
      if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath)
    } catch {
      // Nothing there.
    }
  }
  const server = createServer((socket) => {
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy())
    readLine(socket)
      .then((line) => {
        let request: AdminRequest | null
        try {
          request = parseAdminRequest(JSON.parse(line))
        } catch {
          request = null
        }
        const answer: AdminResponse = request
          ? handle(request)
          : { ok: false, error: '看不懂这个请求。' }
        if (request && answer.ok) log(`huli-cloud: account command ${request.op}`)
        socket.end(`${JSON.stringify(answer)}\n`)
      })
      .catch((error: unknown) => {
        log(`huli-cloud: account command failed: ${errorTrace(error)}`)
        socket.destroy()
      })
  })
  server.on('error', (error) => log(`huli-cloud: account commands: ${errorTrace(error)}`))
  server.listen(socketPath, () => {
    if (process.platform !== 'win32') chmodSync(socketPath, 0o600)
  })
  return server
}

/**
 * Sends a request to the running service; null when none listens, as when it is stopped. Any other
 * failure throws: the service may be running, and its state is not to be written behind its back.
 */
export function callAdmin(
  socketPath: string,
  request: AdminRequest,
): Promise<AdminResponse | null> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('The service did not answer')))
    let connected = false
    socket.on('connect', () => {
      connected = true
      socket.write(`${JSON.stringify(request)}\n`)
      readLine(socket)
        .then((line) => resolve(JSON.parse(line) as AdminResponse))
        .catch(reject)
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (!connected && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) {
        return resolve(null)
      }
      reject(error)
    })
  })
}
