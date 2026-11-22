// Huli: an agent's API provider profiles. A profile names a provider's address, its models and a
// key, and a session started with it gets them in place of the agent's own sign-in. Main keeps the
// profiles with their keys in the encrypted keys file; the agent host alone is sent the keys, and a
// client sees each profile without its key.

import { MAX_KEY_CHARS, MAX_MODEL_CHARS, MAX_URL_CHARS } from './api-key'
import type { ProviderBalance } from './agent-host'
import { harnessOf, type AgentId, type HarnessId } from './agents'

/** The harnesses whose sessions take a profile; each session of theirs runs its own process. */
export const PROFILE_HARNESSES: readonly HarnessId[] = ['claude-code']

export function takesProfiles(agentId: AgentId): boolean {
  return PROFILE_HARNESSES.includes(harnessOf(agentId))
}

export const PROVIDER_PRESET_IDS = [
  'anthropic',
  'zhipu',
  'zai',
  'kimi',
  'kimi-intl',
  'deepseek',
  'bailian',
  'ark',
  'minimax',
  'minimax-intl',
  'custom',
] as const
export type ProviderPresetId = (typeof PROVIDER_PRESET_IDS)[number]

export function isProviderPresetId(value: unknown): value is ProviderPresetId {
  return typeof value === 'string' && (PROVIDER_PRESET_IDS as readonly string[]).includes(value)
}

/** A vendor whose balance Kite reads with a profile's key, through its documented API. */
export type ProfileBalanceVendor = 'deepseek' | 'moonshot-cn' | 'moonshot-intl'

/**
 * What a preset fills in: the vendor's Anthropic-compatible address and the models its Claude Code
 * guide names, as that guide gives them. `env` holds the guide's other variables.
 */
export interface ProviderPreset {
  id: ProviderPresetId
  baseUrl: string
  /** Empty where Claude Code's own default models are right. */
  model: string
  /** The model for Claude Code's quick work (its Haiku slot), where the guide names another. */
  fastModel?: string
  env?: Readonly<Record<string, string>>
  /** The vendor's page where a key is made. */
  keyUrl: string
  balance?: ProfileBalanceVendor
  /**
   * The variable the key goes in: Anthropic's own API takes a Console key as `x-api-key`, which
   * Claude Code sends for `ANTHROPIC_API_KEY`; the others take it as a bearer token.
   */
  keyVar?: 'ANTHROPIC_API_KEY'
}

// Each as its vendor's Claude Code guide gives it, read on 2026-11-22:
// zhipu https://docs.bigmodel.cn/cn/coding-plan/tool/claude, zai https://docs.z.ai/devpack/tool/claude,
// kimi https://platform.kimi.com/docs/guide/claude-code-kimi and
// https://platform.kimi.ai/docs/guide/claude-code-kimi, with the balance at
// https://platform.kimi.com/docs/api/balance and https://platform.kimi.ai/docs/api/balance,
// deepseek https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code, with the
// balance at https://api-docs.deepseek.com/api/get-user-balance,
// bailian (Coding Plan) https://help.aliyun.com/zh/model-studio/claude-code,
// ark (Coding Plan) https://docs.volcengine.com/docs/82379/1928262,
// minimax https://platform.minimax.cn/docs/token-plan/claude-code and
// https://platform.minimax.io/docs/m-plan/claude-code.
// The effort a guide sets is left to the session's own menu.
const GLM_ENV = {
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
}
const KIMI_ENV = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' }
const MINIMAX_ENV = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '524288' }

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // A key of the Claude Console. One of the organization linked to a Max, Ultra or Team plan
  // spends the plan's monthly API credits first:
  // https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
  {
    id: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: '',
    keyUrl: 'https://platform.claude.com/settings/keys',
    keyVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5.3[1m]',
    fastModel: 'glm-5.3-flash[1m]',
    env: GLM_ENV,
    keyUrl: 'https://bigmodel.cn/apikey/coding-plan-per',
  },
  {
    id: 'zai',
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-5.3[1m]',
    fastModel: 'glm-5.3-flash[1m]',
    env: GLM_ENV,
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
  {
    id: 'kimi',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    model: 'kimi-k3[1m]',
    env: KIMI_ENV,
    keyUrl: 'https://platform.kimi.com/console/api-keys',
    balance: 'moonshot-cn',
  },
  {
    id: 'kimi-intl',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    model: 'kimi-k3[1m]',
    env: KIMI_ENV,
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
    balance: 'moonshot-intl',
  },
  {
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-flash[1m]',
    fastModel: 'deepseek-flash',
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432' },
    keyUrl: 'https://platform.deepseek.com/api_keys',
    balance: 'deepseek',
  },
  {
    id: 'bailian',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    model: 'qwen3.7-plus',
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/subscription/coding-plan',
  },
  {
    id: 'ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    model: 'ark-code-latest',
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    keyUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey',
  },
  {
    id: 'minimax',
    baseUrl: 'https://api.minimax.cn/anthropic',
    model: 'MiniMax-M3.1-Flash[1m]',
    env: MINIMAX_ENV,
    keyUrl: 'https://platform.minimax.cn/console/plan',
  },
  {
    id: 'minimax-intl',
    baseUrl: 'https://api.minimax.io/anthropic',
    model: 'MiniMax-M3.1-Flash[1m]',
    env: MINIMAX_ENV,
    keyUrl: 'https://platform.minimax.io/console/plan',
  },
]

/**
 * The vendor whose balance the profile's key reads: only for a profile that kept its preset's
 * address, so the key goes to the vendor it was made for.
 */
export function balanceVendor(profile: {
  preset: ProviderPresetId
  baseUrl: string
}): ProfileBalanceVendor | null {
  const preset = presetOf(profile.preset)
  return preset?.balance && sameAddress(preset.baseUrl, profile.baseUrl) ? preset.balance : null
}

function sameAddress(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.trim().replace(/\/+$/, '')
}

export function presetOf(id: ProviderPresetId): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null
}

export const MAX_PROFILES = 20
export const MAX_PROFILE_NAME_CHARS = 40
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

export function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_ID.test(value)
}

/** What a client sees of a profile: everything but its key, of which only the end shows. */
export interface ProviderProfileView {
  id: string
  name: string
  preset: ProviderPresetId
  baseUrl: string
  model: string | null
  fastModel: string | null
  /** The key's last four characters, for a key long enough that they give nothing away. */
  keyEnd: string | null
}

/** An agent's profiles; `defaultId` is the one new sessions start with, null for its own sign-in. */
export interface AgentProfiles {
  items: ProviderProfileView[]
  defaultId: string | null
}

/** A profile as it is saved: without `id` a new one, without `key` an existing one keeps its key. */
export interface ProfileDraft {
  agentId: AgentId
  id?: string
  name: string
  preset: ProviderPresetId
  baseUrl: string
  model?: string
  fastModel?: string
  key?: string
  /** New sessions start with it from now on. */
  makeDefault?: boolean
}

/** What a vendor last told of a profile's balance; `error` when the last read failed. */
export interface ProfileBalance {
  profileId: string
  balances: ProviderBalance[]
  observedAt: number
  error: string | null
}

/** Why a draft cannot be saved, as the dialog names it; null when it can. */
export type ProfileProblem = 'name' | 'preset' | 'baseUrl' | 'model' | 'key' | 'keyMissing'

export function profileProblem(draft: Omit<ProfileDraft, 'agentId'>): ProfileProblem | null {
  const name = draft.name.trim()
  if (name.length === 0 || [...name].length > MAX_PROFILE_NAME_CHARS || /\p{Cc}/u.test(name)) {
    return 'name'
  }
  if (!isProviderPresetId(draft.preset)) return 'preset'
  const baseUrl = draft.baseUrl.trim()
  const url = URL.parse(baseUrl)
  if (
    baseUrl.length > MAX_URL_CHARS ||
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    return 'baseUrl'
  }
  for (const model of [draft.model, draft.fastModel]) {
    const value = model?.trim()
    if (value && (value.length > MAX_MODEL_CHARS || /\s/.test(value))) return 'model'
  }
  if (draft.key === undefined) return draft.id === undefined ? 'keyMissing' : null
  const key = draft.key.trim()
  if (key.length === 0) return draft.id === undefined ? 'keyMissing' : 'key'
  if (key.length > MAX_KEY_CHARS || /\s/.test(key)) return 'key'
  return null
}

/** The end of a key a client may see: its last four characters, once it has at least twelve. */
export function keyEnd(key: string): string | null {
  return key.length >= 12 ? key.slice(-4) : null
}

// Claude Code's variables a profile sets. Those it leaves empty are set empty, so the agent's own
// settings.json, which outranks the process's environment, cannot fill them: no key of the agent's
// own reaches the profile's address, and no model of its own is asked of that provider.
const CLAUDE_MODEL_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const
const CLAUDE_CLEARED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const
export const CLAUDE_SECRET_VAR = 'ANTHROPIC_AUTH_TOKEN'

/** A profile with its key, as the agent host holds it. */
export interface StoredProfile {
  id: string
  name: string
  preset: ProviderPresetId
  baseUrl: string
  model?: string
  fastModel?: string
  key: string
}

/**
 * Claude Code's variables for a session with the profile: `plain` holds no secret and may go on a
 * command line, with both key variables set empty; `secret` holds the key in its preset's one.
 */
export function claudeProfileEnv(profile: StoredProfile): {
  plain: Record<string, string>
  secret: Record<string, string>
} {
  const preset = presetOf(profile.preset)
  const model = profile.model ?? ''
  const fast = profile.fastModel ?? model
  const plain: Record<string, string> = {
    ...(profile.preset === 'custom' ? {} : preset?.env),
    ...Object.fromEntries(CLAUDE_MODEL_VARS.map((name) => [name, ''])),
    ...Object.fromEntries(CLAUDE_CLEARED.map((name) => [name, ''])),
    ANTHROPIC_BASE_URL: profile.baseUrl,
    [CLAUDE_SECRET_VAR]: '',
  }
  if (model) {
    plain.ANTHROPIC_MODEL = model
    plain.ANTHROPIC_DEFAULT_OPUS_MODEL = model
    plain.ANTHROPIC_DEFAULT_SONNET_MODEL = model
    plain.ANTHROPIC_DEFAULT_FABLE_MODEL = model
    plain.CLAUDE_CODE_SUBAGENT_MODEL = model
  }
  if (fast) {
    plain.ANTHROPIC_DEFAULT_HAIKU_MODEL = fast
    plain.ANTHROPIC_SMALL_FAST_MODEL = fast
  }
  const keyVar = preset?.keyVar ?? CLAUDE_SECRET_VAR
  return { plain, secret: { [keyVar]: profile.key } }
}
