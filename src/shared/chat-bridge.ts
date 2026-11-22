// Huli: driving the agents from chat apps (Settings › 聊天软件). Each platform's bot connects out
// from this computer, over a long connection or long polling, so no public address is needed.
// Main keeps the bots' credentials and the bound accounts encrypted (`chat-bridge.json`) and gives
// the agent host them whole; a window sees which credentials are set and their last characters,
// never the values. See tools/huli/README.md (Chat apps).

export const CHAT_PLATFORMS = ['feishu', 'dingtalk', 'wecom', 'qq', 'telegram'] as const
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number]

export function isChatPlatform(value: unknown): value is ChatPlatform {
  return typeof value === 'string' && (CHAT_PLATFORMS as readonly string[]).includes(value)
}

/** A credential a platform's bot needs: an id shown as typed, or a secret shown by its end alone. */
export interface CredentialField {
  key: string
  secret: boolean
}

/** What each platform's console gives the user to paste, in the order the page asks for it. */
export const CREDENTIAL_FIELDS: Readonly<Record<ChatPlatform, readonly CredentialField[]>> = {
  feishu: [
    { key: 'appId', secret: false },
    { key: 'appSecret', secret: true },
  ],
  dingtalk: [
    { key: 'clientId', secret: false },
    { key: 'clientSecret', secret: true },
  ],
  wecom: [
    { key: 'botId', secret: false },
    { key: 'secret', secret: true },
  ],
  qq: [
    { key: 'appId', secret: false },
    { key: 'appSecret', secret: true },
  ],
  telegram: [{ key: 'token', secret: true }],
}

/** The longest credential kept, in characters; every platform's are far shorter. */
export const MAX_CREDENTIAL_CHARS = 512
/** The most accounts one platform's bot may be bound to. */
export const MAX_CHAT_ACCOUNTS = 10
/** How long a binding code is good for. */
export const BINDING_TTL_MS = 10 * 60_000
/** The digits of a binding code. */
export const BINDING_CODE_DIGITS = 6
export const MAX_ACCOUNT_ID_CHARS = 128
export const MAX_ACCOUNT_NAME_CHARS = 64

/** A chat account allowed to drive the agents: the platform's id for the user, and where to write. */
export interface ChatAccount {
  /** The platform's id for the user: Telegram's user id, Feishu's open_id, DingTalk's staff id. */
  id: string
  /** The name the platform gave with the message that bound it. */
  name: string
  /** Where the bot writes to them first: their direct chat's id, when it differs from `id`. */
  chatId: string | null
  boundAt: number
}

export interface ChatPlatformConfig {
  enabled: boolean
  /** By the keys `CREDENTIAL_FIELDS` names; one not set is absent. */
  credentials: Record<string, string>
  accounts: ChatAccount[]
}

/** A binding the user started: the code their account sends the bot, and until when. */
export interface ChatBinding {
  platform: ChatPlatform
  code: string
  expiresAt: number
}

/** What main gives the agent host: every platform's credentials and accounts, and a binding. */
export interface ChatBridgeConfig {
  platforms: Partial<Record<ChatPlatform, ChatPlatformConfig>>
  binding: ChatBinding | null
}

export type ChatConnectionState = 'off' | 'connecting' | 'connected' | 'error'

/** Why a bridge is not connected, said in the page's words; `detail` is the platform's message. */
export type ChatBridgeProblem =
  'credentials' | 'rejected' | 'network' | 'conflict' | 'unsupported' | 'failed'

export interface ChatBridgeStatus {
  state: ChatConnectionState
  problem: ChatBridgeProblem | null
  /** The platform's own message for the last error, without any credential. */
  detail: string | null
  /** When the last error happened, in ms since the epoch. */
  errorAt: number | null
  /** When the connection last came up. */
  connectedAt: number | null
  /** The bot's own name, once the platform said it. */
  botName: string | null
}

export const OFF_STATUS: ChatBridgeStatus = {
  state: 'off',
  problem: null,
  detail: null,
  errorAt: null,
  connectedAt: null,
  botName: null,
}

/** A credential as a window sees it: an id as typed, a secret by its last characters. */
export type CredentialView = { set: false } | { set: true; shown: string }

export interface ChatPlatformView {
  enabled: boolean
  credentials: Record<string, CredentialView>
  /** Every credential the platform needs is set. */
  ready: boolean
  accounts: ChatAccount[]
  status: ChatBridgeStatus
}

/** Settings › 聊天软件's state: each platform's, the binding under way, and why nothing is kept. */
export interface ChatBridgeView {
  platforms: Record<ChatPlatform, ChatPlatformView>
  binding: ChatBinding | null
  /** Why the credentials cannot be kept on this computer now, such as no system encryption. */
  unavailable: string | null
}

/** A change from the page: credentials to set or (null) clear, and the switch. */
export interface ChatPlatformPatch {
  credentials?: Record<string, string | null>
  enabled?: boolean
}

/** How many of a secret's last characters a window sees. */
const SHOWN_CHARS = 4

export function credentialView(field: CredentialField, value: string | undefined): CredentialView {
  if (value === undefined || value === '') return { set: false }
  if (!field.secret) return { set: true, shown: value }
  const tail = value.length > SHOWN_CHARS * 3 ? value.slice(-SHOWN_CHARS) : ''
  return { set: true, shown: `••••${tail}` }
}

/** Whether every credential the platform needs is there. */
export function credentialsReady(
  platform: ChatPlatform,
  credentials: Readonly<Record<string, string>>,
): boolean {
  return CREDENTIAL_FIELDS[platform].every(({ key }) => (credentials[key] ?? '') !== '')
}

/** Why a credential's value cannot be kept, or null when it can. */
export function credentialProblem(value: string): 'empty' | 'long' | 'characters' | null {
  if (value.length === 0) return 'empty'
  if (value.length > MAX_CREDENTIAL_CHARS) return 'long'
  // Every platform's ids and secrets are printable ASCII; anything else is a paste gone wrong.
  if (!/^[\x21-\x7e]+$/.test(value)) return 'characters'
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/** An account as a file or a message holds it; null when it is not one. */
export function parseChatAccount(value: unknown): ChatAccount | null {
  if (!isRecord(value)) return null
  const { id, name, chatId, boundAt } = value
  if (!isText(id, MAX_ACCOUNT_ID_CHARS)) return null
  if (typeof name !== 'string' || name.length > MAX_ACCOUNT_NAME_CHARS) return null
  if (chatId !== null && !isText(chatId, MAX_ACCOUNT_ID_CHARS)) return null
  if (typeof boundAt !== 'number' || !Number.isFinite(boundAt)) return null
  return { id, name, chatId, boundAt }
}

/** Whether `value` is a binding code: its digits alone. */
export function isBindingCode(value: string): boolean {
  return value.length === BINDING_CODE_DIGITS && /^\d+$/.test(value)
}

/** A platform's part as a file or main's message holds it; null when it is not one. */
export function parsePlatformConfig(
  platform: ChatPlatform,
  value: unknown,
): ChatPlatformConfig | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return null
  if (!isRecord(value.credentials) || !Array.isArray(value.accounts)) return null
  const credentials: Record<string, string> = {}
  for (const { key } of CREDENTIAL_FIELDS[platform]) {
    const credential = value.credentials[key]
    if (credential === undefined) continue
    if (typeof credential !== 'string' || credentialProblem(credential) !== null) return null
    credentials[key] = credential
  }
  if (value.accounts.length > MAX_CHAT_ACCOUNTS) return null
  const accounts: ChatAccount[] = []
  for (const raw of value.accounts) {
    const account = parseChatAccount(raw)
    if (!account || accounts.some((each) => each.id === account.id)) return null
    accounts.push(account)
  }
  return { enabled: value.enabled, credentials, accounts }
}

/** What main sends the agent host, checked as any message across processes; null if not one. */
export function parseChatBridgeConfig(value: unknown): ChatBridgeConfig | null {
  if (!isRecord(value) || !isRecord(value.platforms)) return null
  const platforms: Partial<Record<ChatPlatform, ChatPlatformConfig>> = {}
  for (const [key, raw] of Object.entries(value.platforms)) {
    if (!isChatPlatform(key)) return null
    const parsed = parsePlatformConfig(key, raw)
    if (!parsed) return null
    platforms[key] = parsed
  }
  let binding: ChatBinding | null = null
  if (value.binding !== null && value.binding !== undefined) {
    const raw = value.binding
    if (
      !isRecord(raw) ||
      !isChatPlatform(raw.platform) ||
      typeof raw.code !== 'string' ||
      !isBindingCode(raw.code) ||
      typeof raw.expiresAt !== 'number'
    ) {
      return null
    }
    binding = { platform: raw.platform, code: raw.code, expiresAt: raw.expiresAt }
  }
  return { platforms, binding }
}

/** Whether a configuration has a bridge to run: one turned on with its credentials. */
export function anyBridgeOn(config: ChatBridgeConfig): boolean {
  return CHAT_PLATFORMS.some((platform) => {
    const part = config.platforms[platform]
    return part?.enabled === true && credentialsReady(platform, part.credentials)
  })
}
