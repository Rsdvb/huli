// Huli: `chat-bridge.json`, the chat bridges' bot credentials and bound accounts, encrypted by the
// system as the Marketplace's keys are, in a file only the user can read. Main keeps it and the
// binding under way, gives the agent host all of it, and gives a window only what
// `ChatBridgeView` holds: which credentials are set, a secret's last characters, the accounts and
// each connection's state. An account is added only when the agent host reports the binding's
// code from it and that code is the one main made. See tools/huli/README.md (Chat apps).

import { randomInt } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BINDING_CODE_DIGITS,
  BINDING_TTL_MS,
  CHAT_PLATFORMS,
  CREDENTIAL_FIELDS,
  credentialProblem,
  credentialsReady,
  credentialView,
  isChatPlatform,
  MAX_CHAT_ACCOUNTS,
  OFF_STATUS,
  parseChatAccount,
  parsePlatformConfig,
  type ChatBinding,
  type ChatBridgeConfig,
  type ChatBridgeStatus,
  type ChatBridgeView,
  type ChatPlatform,
  type ChatPlatformConfig,
  type ChatPlatformPatch,
} from '@shared/chat-bridge'
import { quarantineFile, readJsonFile, writeFileAtomic } from './json-file'
import type { Logger } from './log'
import type { IdentityCipher } from './remote-identity'

const VERSION = 1
const FILE_MODE = 0o600
const MAX_SEALED_CHARS = 1024 * 1024
const STATES = new Set(['off', 'connecting', 'connected', 'error'])
const PROBLEMS = new Set([
  'credentials',
  'rejected',
  'network',
  'conflict',
  'unsupported',
  'failed',
])

export function chatBridgeFile(dataPath: string): string {
  return join(dataPath, 'chat-bridge.json')
}

/** A refusal, with the code a window is answered. */
export class ChatBridgeError extends Error {
  constructor(
    readonly code: 'invalid_params' | 'unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'ChatBridgeError'
  }
}

const invalid = (message: string) => new ChatBridgeError('invalid_params', message)

type Platforms = Partial<Record<ChatPlatform, ChatPlatformConfig>>

interface StoredFile {
  version: number
  encrypted: boolean
  /** The system's encryption of the platforms' JSON in base64, or the platforms themselves. */
  contents: string | Platforms
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePlatforms(value: unknown): Platforms | null {
  if (!isRecord(value)) return null
  const platforms: Platforms = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!isChatPlatform(key)) continue
    const parsed = parsePlatformConfig(key, raw)
    if (!parsed) return null
    platforms[key] = parsed
  }
  return platforms
}

/** A connection's state as the agent host reports it; null when it is not one. */
export function parseStatus(value: unknown): ChatBridgeStatus | null {
  if (!isRecord(value)) return null
  const { state, problem, detail, errorAt, connectedAt, botName } = value
  const time = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v))
  const words = (v: unknown, max: number) =>
    v === null || (typeof v === 'string' && v.length <= max)
  if (typeof state !== 'string' || !STATES.has(state)) return null
  if (problem !== null && (typeof problem !== 'string' || !PROBLEMS.has(problem))) return null
  if (!words(detail, 400) || !words(botName, 64) || !time(errorAt) || !time(connectedAt)) {
    return null
  }
  return {
    state: state as ChatBridgeStatus['state'],
    problem: problem as ChatBridgeStatus['problem'],
    detail: detail as string | null,
    errorAt: errorAt as number | null,
    connectedAt: connectedAt as number | null,
    botName: botName as string | null,
  }
}

export interface ChatBridgeOptions {
  file: string
  cipher: IdentityCipher
  /** The configuration changed, for the agent host, which is sent it whole. */
  pushed(config: ChatBridgeConfig): void
  /** What a window shows changed. */
  changed(view: ChatBridgeView): void
  log: Logger
  now?: () => number
}

/** Owns `chat-bridge.json`. Every change runs in turn, so none is lost to another. */
export class ChatBridgeStore {
  private queue: Promise<unknown>
  private platforms: Platforms = {}
  /** Why the file is not written this run, as when this system cannot decrypt it now. */
  private readOnly: string | null = null
  private binding: ChatBinding | null = null
  private bindingTimer: NodeJS.Timeout | null = null
  private readonly statuses = new Map<ChatPlatform, ChatBridgeStatus>()
  private readonly now: () => number

  /**
   * Reads the file in the background, off the start's path: until it is read the host is given
   * no bridge, and once it is, the bridges that were on are pushed to it.
   */
  constructor(private readonly options: ChatBridgeOptions) {
    this.now = options.now ?? Date.now
    this.queue = this.load().then(
      () => {
        if (Object.keys(this.platforms).length > 0) this.options.pushed(this.configForHost())
      },
      (error: unknown) => {
        this.readOnly = 'Kite could not read its chat bridges file'
        options.log.error(`Could not read ${options.file}`, error)
      },
    )
  }

  private async load(): Promise<void> {
    const { file, cipher, log } = this.options
    const read = await readJsonFile(file)
    const quarantine = async (reason: string) => {
      log.warn(`${file} is invalid: ${reason}`)
      try {
        log.warn(`Moved the invalid file to ${await quarantineFile(file)}`)
      } catch (error) {
        log.error(`Could not move the invalid ${file} aside`, error)
        this.readOnly = 'Kite could not read its chat bridges file'
      }
    }
    if (read.kind === 'unreadable') {
      // The parser's message quotes the text, which holds credentials.
      await quarantine(read.reason.startsWith('Invalid JSON') ? 'not JSON' : read.reason)
      return
    }
    if (read.kind !== 'ok') return
    const raw = read.value
    if (isRecord(raw) && typeof raw.version === 'number' && raw.version > VERSION) {
      log.warn(`${file} comes from a newer version of Kite; its bridges are not used`)
      this.readOnly = 'The chat bridges were saved by a newer version of Kite'
    } else if (!isRecord(raw) || raw.version !== VERSION || typeof raw.encrypted !== 'boolean') {
      await quarantine('not a chat bridges file')
    } else if (!raw.encrypted) {
      const parsed = parsePlatforms(raw.contents)
      if (parsed) this.platforms = parsed
      else await quarantine('the bridges are not valid')
    } else if (!(await cipher.available())) {
      log.warn(`${file} is encrypted, which this system cannot undo now; its bridges are off`)
      this.readOnly = 'This system cannot decrypt the chat bridges now'
    } else {
      try {
        if (typeof raw.contents !== 'string' || raw.contents.length > MAX_SEALED_CHARS) {
          throw new Error('the bridges are not sealed')
        }
        const { result } = await cipher.decrypt(Buffer.from(raw.contents, 'base64'))
        let decrypted: unknown
        try {
          decrypted = JSON.parse(result)
        } catch {
          throw new Error('the bridges do not decrypt to JSON')
        }
        const parsed = parsePlatforms(decrypted)
        if (!parsed) throw new Error('the bridges are not valid')
        this.platforms = parsed
      } catch (error) {
        await quarantine((error as Error)?.message ?? String(error))
      }
    }
  }

  /** The view once the file is read. */
  state(): Promise<ChatBridgeView> {
    return this.run(async () => this.view())
  }

  /** Everything the agent host is given: credentials, accounts and the binding under way. */
  configForHost(): ChatBridgeConfig {
    const binding = this.binding && this.binding.expiresAt > this.now() ? this.binding : null
    return { platforms: this.platforms, binding }
  }

  /** What a window may see. */
  view(): ChatBridgeView {
    const platforms = Object.fromEntries(
      CHAT_PLATFORMS.map((platform) => {
        const stored = this.platforms[platform]
        const credentials = Object.fromEntries(
          CREDENTIAL_FIELDS[platform].map((field) => [
            field.key,
            credentialView(field, stored?.credentials[field.key]),
          ]),
        )
        return [
          platform,
          {
            enabled: stored?.enabled ?? false,
            credentials,
            ready: credentialsReady(platform, stored?.credentials ?? {}),
            accounts: stored?.accounts ?? [],
            status: this.statuses.get(platform) ?? OFF_STATUS,
          },
        ]
      }),
    ) as ChatBridgeView['platforms']
    const binding = this.binding && this.binding.expiresAt > this.now() ? this.binding : null
    return { platforms, binding, unavailable: this.readOnly }
  }

  /** Sets or clears credentials, or turns a bridge on or off, from an untrusted patch. */
  async save(platform: unknown, raw: unknown): Promise<ChatBridgeView> {
    if (!isChatPlatform(platform)) throw invalid('No such chat platform')
    const patch = parsePatch(platform, raw)
    return this.run(async () => {
      if (this.readOnly) throw new ChatBridgeError('unavailable', this.readOnly)
      const current: ChatPlatformConfig = this.platforms[platform] ?? {
        enabled: false,
        credentials: {},
        accounts: [],
      }
      const credentials = { ...current.credentials }
      for (const [key, value] of Object.entries(patch.credentials ?? {})) {
        if (value === null) delete credentials[key]
        else credentials[key] = value
      }
      // Another bot knows its users by ids of its own: the accounts bound to the one before go.
      const botKey = CREDENTIAL_FIELDS[platform][0]!.key
      const before = current.credentials[botKey]
      const otherBot = before !== undefined && credentials[botKey] !== before
      const next: ChatPlatformConfig = {
        enabled: patch.enabled ?? current.enabled,
        credentials,
        accounts: otherBot ? [] : current.accounts,
      }
      if (next.enabled && !credentialsReady(platform, next.credentials)) {
        throw invalid('Every credential must be set before the bridge is turned on')
      }
      if (!next.enabled && this.binding?.platform === platform) this.clearBinding()
      await this.commit({ ...this.platforms, [platform]: next })
      return this.view()
    })
  }

  /** Starts binding an account: the code the user sends the bot, good for a few minutes. */
  async startBinding(platform: unknown): Promise<ChatBridgeView> {
    if (!isChatPlatform(platform)) throw invalid('No such chat platform')
    return this.run(async () => {
      const stored = this.platforms[platform]
      if (!stored?.enabled || !credentialsReady(platform, stored.credentials)) {
        throw invalid('Turn the bridge on before binding an account')
      }
      if (stored.accounts.length >= MAX_CHAT_ACCOUNTS) {
        throw invalid(`A bridge keeps at most ${MAX_CHAT_ACCOUNTS} accounts`)
      }
      const code = String(randomInt(0, 10 ** BINDING_CODE_DIGITS)).padStart(
        BINDING_CODE_DIGITS,
        '0',
      )
      this.binding = { platform, code, expiresAt: this.now() + BINDING_TTL_MS }
      if (this.bindingTimer) clearTimeout(this.bindingTimer)
      this.bindingTimer = setTimeout(() => {
        this.bindingTimer = null
        this.clearBinding()
        this.publish()
      }, BINDING_TTL_MS)
      this.publish()
      return this.view()
    })
  }

  async cancelBinding(): Promise<ChatBridgeView> {
    return this.run(async () => {
      this.clearBinding()
      this.publish()
      return this.view()
    })
  }

  /**
   * The agent host heard the binding's code from an account. Kept only when the code is the one
   * under way, for its platform, in time; the binding ends either way it matched.
   */
  async bind(platform: unknown, code: unknown, account: unknown): Promise<boolean> {
    return this.run(async () => {
      const binding = this.binding
      if (
        !binding ||
        binding.platform !== platform ||
        binding.code !== code ||
        binding.expiresAt <= this.now() ||
        this.readOnly
      ) {
        this.options.log.warn('A binding code that is not the one under way came; ignored')
        return false
      }
      const parsed = parseChatAccount(
        isRecord(account) ? { ...account, boundAt: this.now() } : null,
      )
      const stored = this.platforms[binding.platform]
      if (!parsed || !stored) return false
      this.clearBinding()
      const accounts = [...stored.accounts.filter((each) => each.id !== parsed.id), parsed]
      if (accounts.length > MAX_CHAT_ACCOUNTS) return false
      await this.commit({ ...this.platforms, [binding.platform]: { ...stored, accounts } })
      this.options.log.info(`Bound an account to the ${binding.platform} bridge`)
      return true
    })
  }

  async unbind(platform: unknown, accountId: unknown): Promise<ChatBridgeView> {
    if (!isChatPlatform(platform)) throw invalid('No such chat platform')
    if (typeof accountId !== 'string' || accountId.length === 0) throw invalid('No such account')
    return this.run(async () => {
      if (this.readOnly) throw new ChatBridgeError('unavailable', this.readOnly)
      const stored = this.platforms[platform]
      if (!stored?.accounts.some((each) => each.id === accountId)) return this.view()
      const accounts = stored.accounts.filter((each) => each.id !== accountId)
      await this.commit({ ...this.platforms, [platform]: { ...stored, accounts } })
      return this.view()
    })
  }

  /** The agent host's report of its connections. */
  setStatuses(raw: unknown): void {
    if (!isRecord(raw)) return
    let changed = false
    for (const platform of CHAT_PLATFORMS) {
      const status = parseStatus(raw[platform])
      if (!status) continue
      this.statuses.set(platform, status)
      changed = true
    }
    if (changed) this.options.changed(this.view())
  }

  /** The agent host stopped: no bridge is connected until it says so again. */
  hostDown(): void {
    if (this.statuses.size === 0) return
    this.statuses.clear()
    this.options.changed(this.view())
  }

  async flush(): Promise<void> {
    await this.queue
  }

  private clearBinding(): void {
    this.binding = null
    if (this.bindingTimer) clearTimeout(this.bindingTimer)
    this.bindingTimer = null
  }

  private publish(): void {
    this.options.pushed(this.configForHost())
    this.options.changed(this.view())
  }

  private async commit(next: Platforms): Promise<void> {
    await this.write(next)
    this.platforms = next
    this.publish()
  }

  private async write(platforms: Platforms): Promise<void> {
    const { file, cipher } = this.options
    const empty = Object.values(platforms).every(
      (each) => !each || (Object.keys(each.credentials).length === 0 && each.accounts.length === 0),
    )
    if (empty) {
      await rm(file, { force: true })
      return
    }
    if (!(await cipher.available()) || cipher.plainText()) {
      throw new ChatBridgeError(
        'unavailable',
        'This system cannot encrypt credentials, so none are kept',
      )
    }
    const sealed = (await cipher.encrypt(JSON.stringify(platforms))).toString('base64')
    const stored: StoredFile = { version: VERSION, encrypted: true, contents: sealed }
    await writeFileAtomic(file, `${JSON.stringify(stored, null, 2)}\n`, FILE_MODE)
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.catch(() => {})
    return next
  }
}

/** A window's patch, checked: only the platform's own credentials, each a value it can keep. */
export function parsePatch(platform: ChatPlatform, raw: unknown): ChatPlatformPatch {
  if (!isRecord(raw)) throw invalid('The change must be an object')
  const extra = Object.keys(raw).find((key) => key !== 'credentials' && key !== 'enabled')
  if (extra) throw invalid(`Unknown field "${extra}"`)
  const patch: ChatPlatformPatch = {}
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw invalid('"enabled" must be true or false')
    patch.enabled = raw.enabled
  }
  if (raw.credentials !== undefined) {
    if (!isRecord(raw.credentials)) throw invalid('"credentials" must be an object')
    const keys = new Set(CREDENTIAL_FIELDS[platform].map((field) => field.key))
    const credentials: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(raw.credentials)) {
      if (!keys.has(key)) throw invalid(`The bridge has no credential "${key}"`)
      if (value === null) {
        credentials[key] = null
        continue
      }
      if (typeof value !== 'string') throw invalid(`"${key}" must be text, or null to clear it`)
      const trimmed = value.trim()
      const problem = credentialProblem(trimmed)
      if (problem)
        throw invalid(
          `"${key}" is ${problem === 'empty' ? 'empty' : problem === 'long' ? 'too long' : 'not a credential'}`,
        )
      credentials[key] = trimmed
    }
    patch.credentials = credentials
  }
  return patch
}
