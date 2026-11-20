// Huli: what resetting an agent's environment removes, and what it keeps, by each agent's own
// rules. Every path and key below was read from the agent's code (Claude Code 2.1.326, Codex
// 0.171, agy 1.5.13, Pi 1.5.2, Cline 3.0.74, DimCode 0.5.29, OpenCode 2.3); tools/huli/README.md
// (Agent reset) says where. Nothing here touches the disk but `realpath`.

import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { AgentResetCategory } from '@shared/agent-reset'
import type { Platform } from '@shared/platform'
import type { HarnessId } from '@shared/thread'

/** An entry of the system's credential store. */
export type SecretRef =
  | { store: 'keychain'; service: string; account?: string }
  /** `parts`: the entry was split, the rest under the same name with `#` and a suffix. */
  | { store: 'credential-manager'; target: string; parts?: boolean }
  | { store: 'secret-service'; attributes: Record<string, string> }

export type ResetEntry =
  /** A file or a folder, whichever is there. */
  | { category: AgentResetCategory; kind: 'path'; path: string }
  /** What in `folder` has a name `match` takes. */
  | { category: AgentResetCategory; kind: 'children'; folder: string; match: RegExp }
  /** Top-level keys of a JSON file, which keeps the rest. */
  | { category: AgentResetCategory; kind: 'keys'; file: string; keys: readonly string[] }
  /** The same keys of each file in `folder` whose name `match` takes, such as its backups. */
  | {
      category: AgentResetCategory
      kind: 'keys-in'
      folder: string
      match: RegExp
      keys: readonly string[]
    }
  | { category: AgentResetCategory; kind: 'secret'; secret: SecretRef }

/** What a reset keeps: `whole` keeps everything inside a folder too. */
export interface KeptPath {
  path: string
  whole: boolean
}

export interface ResetPlan {
  folder: string | null
  known: AgentResetCategory[]
  entries: ResetEntry[]
  /** The agent's history and settings, which no removal may reach. */
  keep: KeptPath[]
  /** The folders every removal lies inside. */
  roots: string[]
  /** Who else uses what the reset removes; see `AgentResetPreview.shared`. */
  shared: 'program' | 'app' | null
}

export interface ResetContext {
  platform: Platform
  home: string
  getEnv(name: string): string | undefined
  /** The folder picked in Settings, which Kite gives the agent in its variable. */
  chosen: string | null
  /** A path with its links resolved, as the system has it; Codex hashes it for its keyring. */
  realpath?(target: string): Promise<string>
}

const ALL: AgentResetCategory[] = ['credentials', 'identifiers', 'caches']

// Claude Code's `.claude.json` keys. Account: what `/logout` clears or leaves of the sign-in.
const CLAUDE_ACCOUNT_KEYS = ['oauthAccount', 'primaryApiKey', 'customApiKeyResponses'] as const
// Ids it makes on its first start: `userID`, `machineID`, `firstStartTime`... (chunk-rshy9806).
const CLAUDE_ID_KEYS = [
  'userID',
  'anonymousId',
  'machineID',
  'firstStartTime',
  'firstStartVersion',
  'remoteControlMachineId',
] as const
// Its feature flag caches, and the account's answers it caches, which it fetches again.
const CLAUDE_CACHE_KEYS = [
  'cachedFeatureFlags',
  'cachedFeatureFlagsAt',
  'cachedGrowthBookFeatures',
  'cachedGrowthBookFeaturesAt',
  'cachedExperimentFeatures',
  'cachedExperimentData',
  'cachedStatsigGates',
  'cachedDynamicConfigs',
  'additionalModelOptionsCache',
  'additionalModelOptionsAnsweredAt',
  'additionalModelCostsCache',
  'modelAccessCache',
  'orgModelDefaultCache',
  'cachedArtifactRoster',
  'artifactRosterDenied',
  'lastSeenOrgDefaultUpdatedAt',
  'clientDataCache',
  'clientDataCacheSlots',
  'autoCompactWindowsCache',
  'cachedUsageUtilization',
  'metricsStatusCache',
  'metricsStatusCacheByPrincipal',
  'githubWebConnectionStatusCache',
  'unusedLimitResetStatusCache',
  'promoCreditCheck',
  'startupPrefetchedAt',
  'penguinModeOrgEnabled',
  'groveConfigCache',
  'passesEligibilityCache',
  'cachedExtraUsageDisabledReason',
  'claudeCodeFirstTokenDate',
  'gitForWindowsLauncher',
] as const
// Folders and files of its own folder that it writes again: logs, snapshots, caches.
const CLAUDE_CACHE_PATHS = [
  'statsig',
  'todos',
  'shell-snapshots',
  'session-env',
  'debug',
  'telemetry',
  'logs',
  'access-audit',
  'image-cache',
  'traces',
  'startup-perf',
  'mcp-discovery-cache',
  'stats-cache.json',
  'mcp-needs-auth-cache.json',
  'gh-pr-status-cache.json',
  'state/mcp-discover-verdicts.json',
] as const
const CLAUDE_KEEP = [
  'projects',
  'history.jsonl',
  'paste-cache',
  'file-history',
  'tasks',
  'plans',
  'uploads',
  'settings.json',
  'settings.local.json',
  'CLAUDE.md',
  'keybindings.json',
  'skills',
  'agents',
  'commands',
  'output-styles',
  'hooks',
  'rules',
  'themes',
  'workflows',
  'plugins',
  'agent-memory',
  'jobs',
  'teams',
  'sessions',
  'backups',
  'state',
  'cache/model-catalog',
] as const

const CODEX_CREDENTIAL_PATHS = [
  'auth.json',
  '.credentials.json',
  'secrets/codex_auth.age',
  'secrets/mcp_oauth.age',
  'secrets/gateway_oauth.age',
  'secrets/gateway_oauth.json',
] as const
const CODEX_CACHE_PATHS = [
  'log',
  'cache',
  'shell_snapshots',
  'tmp',
  'version.json',
  '.tmp/plugins',
  '.tmp/plugins.sha',
] as const
const CODEX_KEEP = [
  'sessions',
  'archived_sessions',
  'session_index.jsonl',
  'history.jsonl',
  'config.toml',
  'AGENTS.md',
  'rules',
  'skills',
  'plugins',
  'prompts',
  'memories',
  'memories_v2',
  'visualizations',
  'sqlite',
  'secrets',
  // The secrets that share the passphrase with the sign-in's, and the Windows sandbox's state.
  'secrets/local.age',
  '.sandbox/setup_marker.json',
  '.sandbox/deny_read_acl_state.json',
  '.codex-global-state.json',
  '.sandbox_migration',
  '.sandbox',
  '.sandbox-bin',
  '.sandbox-secrets',
  'cap_sid',
  '.tmp/marketplaces',
  '.tmp/bundled-marketplaces',
] as const
// Codex's databases of threads, goals and queues, which nothing rebuilds.
const CODEX_KEPT_DATABASE = /^(state|thread_history|goals|queue|memories|memories_v2)_\d+\.sqlite/

const AGY_CACHE_PATHS = [
  'log',
  'cli.log',
  'crashes',
  'updater',
  'last_check.timestamp',
  'builtin',
  'scratch',
  'bin/agentapi.bat',
  'cache/conversation_metadata.json',
  'cache/antigravity-keyring-unavailable',
] as const
const AGY_KEEP = [
  'conversations',
  'brain',
  'annotations',
  'implicit',
  'conversation_summaries.db',
  'jetbox_summaries_proto.pb',
  'jetski_state.pbtxt',
  'settings.json',
  'keybindings.json',
  'skills',
  'mcp',
  'cache/projects.json',
  'cache/default_project_id.txt',
] as const

const PI_KEEP = [
  'sessions',
  'settings.json',
  'keybindings.json',
  'mcp.json',
  'models.json',
  'models-store.json',
  'trust.json',
  'AGENTS.md',
  'SYSTEM.md',
  'APPEND_SYSTEM.md',
  'extensions',
  'skills',
  'prompts',
  'themes',
  'tools',
  'npm',
  'git',
  'bin',
] as const

function pathsOf(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

function value(ctx: ResetContext, name: string): string | null {
  const found = ctx.getEnv(name)
  return found && found.trim() !== '' ? found : null
}

/**
 * The suffix Claude Code adds to its keychain services when its folder was moved: `-` and the
 * first 8 hex digits of the SHA-256 of the variable's value as it is, NFC-normalized
 * (chunk-acw9hx9m, `rke`). None when the folder is the default.
 */
export function claudeServiceSuffix(configDir: string | null, secureDir?: string): string {
  const none = secureDir !== undefined ? !secureDir : !configDir
  if (none) return ''
  const input = (secureDir ?? configDir ?? '').normalize('NFC')
  return `-${createHash('sha256').update(input).digest('hex').slice(0, 8)}`
}

/**
 * The account of Codex's keyring entries for a folder: `cli|` or `secrets|` and the first 16 hex
 * digits of the SHA-256 of the canonical folder (login/src/auth/storage.rs).
 */
export function codexAccount(prefix: 'cli' | 'secrets', canonical: string): string {
  return `${prefix}|${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
}

/**
 * The folder as Rust's `canonicalize` gives it, which Codex hashes: links resolved, and on Windows
 * with the `\\?\` prefix, `\\?\UNC\` for a share. The path as it is when it cannot be resolved.
 */
export async function codexCanonical(ctx: ResetContext, folder: string): Promise<string> {
  let resolved: string
  try {
    resolved = await (ctx.realpath ?? ((target: string) => realpath(target)))(folder)
  } catch {
    return folder
  }
  if (ctx.platform !== 'win32') return resolved
  if (resolved.startsWith('\\\\?\\')) return resolved
  if (resolved.startsWith('\\\\')) return `\\\\?\\UNC\\${resolved.slice(2)}`
  return `\\\\?\\${resolved}`
}

function claudePlan(ctx: ResetContext): ResetPlan {
  const p = pathsOf(ctx.platform)
  // The value Kite gives the agent as CLAUDE_CONFIG_DIR, which its keychain suffix hashes as it is.
  const moved = ctx.chosen ?? value(ctx, 'CLAUDE_CONFIG_DIR')
  const folder = moved ? p.resolve(ctx.home, moved) : p.join(ctx.home, '.claude')
  // `.claude.json` sits in the home folder unless the folder was moved (chunk-9rnn711s, `tlo`).
  const globalDir = moved ? folder : ctx.home
  const globalFile = p.join(globalDir, '.claude.json')
  const secure = ctx.getEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR')
  const credentialsDir =
    secure === undefined
      ? folder
      : secure === ''
        ? p.join(ctx.home, '.claude')
        : p.resolve(ctx.home, secure)
  const suffix = claudeServiceSuffix(moved, secure)
  const keyed = (category: AgentResetCategory, keys: readonly string[]): ResetEntry[] => [
    { category, kind: 'keys', file: globalFile, keys },
    // The file before `.claude.json`, which Claude Code still reads when it is there.
    { category, kind: 'keys', file: p.join(folder, '.config.json'), keys },
    // Its backups, five of each, and the copies of a file that did not parse.
    {
      category,
      kind: 'keys-in',
      folder: p.join(folder, 'backups'),
      match: /^\.(claude|config)\.json\.(backup|corrupted)\.\d+$/,
      keys,
    },
    // Older backups beside the file itself.
    {
      category,
      kind: 'keys-in',
      folder: globalDir,
      match: /^\.claude\.json\.backup(\.\d+)?$/,
      keys,
    },
  ]
  const secrets: ResetEntry[] =
    ctx.platform === 'darwin'
      ? [
          `Claude Code-credentials${suffix}`,
          // An API key from its console sign-in, which macOS keeps out of `.claude.json`.
          `Claude Code${suffix}`,
        ].map((service): ResetEntry => ({
          category: 'credentials',
          kind: 'secret',
          secret: { store: 'keychain', service },
        }))
      : ctx.platform === 'win32'
        ? [
            {
              category: 'credentials',
              kind: 'secret',
              // Bun.secrets names it `service/name`; Claude Code moves there behind a flag.
              secret: {
                store: 'credential-manager',
                target: `Claude Code-credentials${suffix}/claude-code-user`,
                parts: true,
              },
            },
          ]
        : []
  const cache = p.join(folder, 'cache')
  return {
    folder,
    known: ALL,
    entries: [
      { category: 'credentials', kind: 'path', path: p.join(credentialsDir, '.credentials.json') },
      ...keyed('credentials', CLAUDE_ACCOUNT_KEYS),
      ...secrets,
      ...keyed('identifiers', CLAUDE_ID_KEYS),
      ...keyed('caches', CLAUDE_CACHE_KEYS),
      ...CLAUDE_CACHE_PATHS.map((name): ResetEntry => ({
        category: 'caches',
        kind: 'path',
        path: p.join(folder, ...name.split(/[\\/]/)),
      })),
      { category: 'caches', kind: 'children', folder: cache, match: /^(?!model-catalog$)/ },
    ],
    keep: [
      ...CLAUDE_KEEP.map((name) => ({
        path: p.join(folder, ...name.split(/[\\/]/)),
        // Kite takes one cache out of `state`, beside the consents it keeps.
        whole: name !== 'state',
      })),
      { path: globalFile, whole: true },
      { path: p.join(folder, '.config.json'), whole: true },
    ],
    roots: [...new Set([folder, credentialsDir])],
    shared: moved ? null : 'program',
  }
}

async function codexPlan(ctx: ResetContext): Promise<ResetPlan> {
  const p = pathsOf(ctx.platform)
  const moved = ctx.chosen ?? value(ctx, 'CODEX_HOME')
  const folder = moved ? p.resolve(ctx.home, moved) : p.join(ctx.home, '.codex')
  const canonical = await codexCanonical(ctx, folder)
  const auth = codexAccount('cli', canonical)
  // `codex logout` clears the store config.toml names; this is the entry another one left.
  const leftover: SecretRef | null =
    ctx.platform === 'win32'
      ? { store: 'credential-manager', target: `${auth}.Codex Auth` }
      : ctx.platform === 'darwin'
        ? { store: 'keychain', service: 'Codex Auth', account: auth }
        : { store: 'secret-service', attributes: { service: 'Codex Auth', username: auth } }
  return {
    folder,
    known: ALL,
    entries: [
      ...CODEX_CREDENTIAL_PATHS.map((name): ResetEntry => ({
        category: 'credentials',
        kind: 'path',
        path: p.join(folder, ...name.split(/[\\/]/)),
      })),
      { category: 'credentials', kind: 'secret', secret: leftover },
      { category: 'identifiers', kind: 'path', path: p.join(folder, 'installation_id') },
      ...CODEX_CACHE_PATHS.map((name): ResetEntry => ({
        category: 'caches',
        kind: 'path',
        path: p.join(folder, ...name.split(/[\\/]/)),
      })),
      {
        category: 'caches',
        kind: 'children',
        folder,
        match: /^(logs_\d+\.sqlite(-wal|-shm)?|models_cache(\.[\w.-]+)?\.json)$/,
      },
      {
        category: 'caches',
        kind: 'children',
        folder: p.join(folder, '.sandbox'),
        match: /^sandbox.*\.log$/,
      },
    ],
    keep: CODEX_KEEP.map((name) => ({
      path: p.join(folder, ...name.split(/[\\/]/)),
      // Kite removes three of the secrets folder's files and keeps its passphrase's own.
      whole: name !== 'secrets' && name !== '.sandbox',
    })),
    roots: [folder],
    shared: moved ? null : 'program',
  }
}

function antigravityPlan(ctx: ResetContext): ResetPlan {
  const p = pathsOf(ctx.platform)
  const base = p.join(ctx.home, '.gemini')
  const folder = p.join(base, 'antigravity-cli')
  const at = (name: string): string => p.join(folder, ...name.split(/[\\/]/))
  // go-keyring's entry, service `gemini` and user `antigravity`, which the Antigravity app reads.
  const keyring: SecretRef =
    ctx.platform === 'win32'
      ? { store: 'credential-manager', target: 'gemini:antigravity' }
      : ctx.platform === 'darwin'
        ? { store: 'keychain', service: 'gemini', account: 'antigravity' }
        : { store: 'secret-service', attributes: { service: 'gemini', username: 'antigravity' } }
  return {
    folder,
    known: ALL,
    entries: [
      { category: 'credentials', kind: 'secret', secret: keyring },
      // The token's file where the keyring cannot be reached, as over SSH or in WSL.
      { category: 'credentials', kind: 'path', path: at('antigravity-oauth-token') },
      { category: 'credentials', kind: 'path', path: at('mcp_oauth_tokens.json') },
      { category: 'credentials', kind: 'path', path: at('cache/acp-auth-state.json') },
      { category: 'credentials', kind: 'path', path: at('cache/onboarding.json') },
      // The older sign-in's token, which the app shares.
      {
        category: 'credentials',
        kind: 'path',
        path: p.join(base, 'jetski-standalone-oauth-token'),
      },
      { category: 'identifiers', kind: 'path', path: at('installation_id') },
      ...AGY_CACHE_PATHS.map((name): ResetEntry => ({
        category: 'caches',
        kind: 'path',
        path: at(name),
      })),
    ],
    keep: [
      ...AGY_KEEP.map((name) => ({ path: at(name), whole: true })),
      { path: p.join(base, 'config'), whole: true },
      { path: p.join(base, 'antigravity'), whole: true },
      { path: p.join(base, 'GEMINI.md'), whole: true },
      { path: p.join(base, 'AGENTS.md'), whole: true },
    ],
    roots: [base],
    shared: 'app',
  }
}

function piPlan(ctx: ResetContext): ResetPlan {
  const p = pathsOf(ctx.platform)
  const moved = value(ctx, 'PI_CODING_AGENT_DIR')
  const expanded = moved?.startsWith('~') ? p.join(ctx.home, moved.slice(1)) : moved
  const folder = expanded ? p.resolve(ctx.home, expanded) : p.join(ctx.home, '.pi', 'agent')
  const settings = p.join(folder, 'settings.json')
  return {
    folder,
    known: ALL,
    entries: [
      { category: 'credentials', kind: 'path', path: p.join(folder, 'auth.json') },
      { category: 'credentials', kind: 'path', path: p.join(folder, 'mcp-auth.json') },
      // Its older files, which it moves into auth.json again when that is missing.
      { category: 'credentials', kind: 'path', path: p.join(folder, 'oauth.json') },
      { category: 'credentials', kind: 'keys', file: settings, keys: ['apiKeys'] },
      { category: 'identifiers', kind: 'keys', file: settings, keys: ['deviceId', 'trackingId'] },
      ...['pi-debug.log', 'crashes.json', 'mcp.log', 'tmp'].map((name): ResetEntry => ({
        category: 'caches',
        kind: 'path',
        path: p.join(folder, name),
      })),
    ],
    keep: PI_KEEP.map((name) => ({ path: p.join(folder, name), whole: true })),
    roots: [folder],
    shared: 'program',
  }
}

function clinePlan(ctx: ResetContext): ResetPlan {
  const p = pathsOf(ctx.platform)
  const root = p.resolve(ctx.home, value(ctx, 'CLINE_DIR') ?? p.join(ctx.home, '.cline'))
  const data = p.resolve(ctx.home, value(ctx, 'CLINE_DATA_DIR') ?? p.join(root, 'data'))
  const sessions = p.resolve(
    ctx.home,
    value(ctx, 'CLINE_SESSION_DATA_DIR') ?? p.join(data, 'sessions'),
  )
  return {
    folder: root,
    // Its keys share providers.json with the providers and models picked, so only a sign-out.
    known: ['identifiers', 'caches'],
    entries: [
      // Written only when the system's machine id cannot be read.
      { category: 'identifiers', kind: 'path', path: p.join(sessions, 'machine-id') },
      { category: 'caches', kind: 'path', path: p.join(data, 'logs') },
      { category: 'caches', kind: 'path', path: p.join(data, 'cache', 'feature-flags.json') },
    ],
    keep: [
      { path: sessions, whole: false },
      { path: p.join(data, 'db'), whole: true },
      { path: p.join(data, 'settings'), whole: true },
      { path: p.join(data, 'cache', 'user_input_history.jsonl'), whole: true },
      { path: p.join(data, 'locks'), whole: true },
      { path: p.join(data, 'workspaces'), whole: true },
      { path: p.join(data, 'teams'), whole: true },
    ],
    roots: [...new Set([root, data, sessions])],
    shared: 'program',
  }
}

function dimcodePlan(ctx: ResetContext): ResetPlan {
  const p = pathsOf(ctx.platform)
  const fixed = p.join(ctx.home, '.dimcode', 'v2')
  const moved = value(ctx, 'DIMCODE_HOME')
  // Its sign-in and device id use DIMCODE_HOME as it is; the rest a `v2` folder in it.
  const signIn = moved ? p.resolve(ctx.home, moved) : fixed
  const main = moved ? (/[\\/]v2$|^v2$/.test(signIn) ? signIn : p.join(signIn, 'v2')) : fixed
  const traces = moved ? p.join(signIn, 'tracelog') : p.join(ctx.home, '.dimcode', 'tracelog')
  return {
    folder: main,
    // `dimcode auth logout` also clears provider keys kept in its database with the sessions.
    known: ['identifiers', 'caches'],
    entries: [
      { category: 'identifiers', kind: 'path', path: p.join(signIn, 'device-id') },
      { category: 'identifiers', kind: 'path', path: p.join(fixed, 'remote-device-id') },
      { category: 'caches', kind: 'path', path: p.join(main, 'logs') },
      { category: 'caches', kind: 'path', path: p.join(main, 'cache') },
      { category: 'caches', kind: 'path', path: traces },
    ],
    keep: [
      'dimcode.sqlite',
      'data',
      'config.json',
      'providers.json',
      'mcp.json',
      'permissions.json',
      'skills',
      'plugins',
      'state',
      'remote',
    ].map((name) => ({ path: p.join(main, name), whole: true })),
    roots: [...new Set([signIn, main, fixed, p.dirname(traces)])],
    shared: 'program',
  }
}

function opencodePlan(ctx: ResetContext): ResetPlan {
  const p = pathsOf(ctx.platform)
  const xdg = (name: string, fallback: string[]): string =>
    p.resolve(ctx.home, value(ctx, name) ?? p.join(ctx.home, ...fallback))
  const data = p.join(xdg('XDG_DATA_HOME', ['.local', 'share']), 'opencode')
  const cache = p.join(xdg('XDG_CACHE_HOME', ['.cache']), 'opencode')
  return {
    folder: data,
    // Its sign-ins and its one id live in opencode.db, beside the sessions.
    known: ['caches'],
    entries: [
      // OpenCode's own uninstall removes the cache folder and nothing else.
      { category: 'caches', kind: 'path', path: cache },
      { category: 'caches', kind: 'path', path: p.join(data, 'log') },
    ],
    keep: [
      { path: p.join(data, 'opencode.db'), whole: true },
      { path: p.join(data, 'snapshot'), whole: true },
      { path: p.join(data, 'storage'), whole: true },
    ],
    roots: [p.dirname(cache), data],
    shared: 'program',
  }
}

/** What a reset of an agent on `harness` removes and keeps. */
export async function resetPlan(harness: HarnessId, ctx: ResetContext): Promise<ResetPlan> {
  switch (harness) {
    case 'claude-code':
      return claudePlan(ctx)
    case 'codex':
      return codexPlan(ctx)
    case 'antigravity':
      return antigravityPlan(ctx)
    case 'pi':
      return piPlan(ctx)
    case 'cline':
      return clinePlan(ctx)
    case 'dimcode':
      return dimcodePlan(ctx)
    case 'opencode':
      return opencodePlan(ctx)
    default:
      return { folder: null, known: [], entries: [], keep: [], roots: [], shared: null }
  }
}

/** The database files Codex keeps its threads in, which a reset never removes. */
export function keptCodexDatabase(name: string): boolean {
  return CODEX_KEPT_DATABASE.test(name)
}

function inside(parent: string, child: string, platform: Platform): boolean {
  const p = pathsOf(platform)
  const rel = p.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel)
}

function same(a: string, b: string, platform: Platform): boolean {
  const p = pathsOf(platform)
  const x = p.resolve(a)
  const y = p.resolve(b)
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * Why a reset may not remove `target`, or null when it may: it must lie inside one of the plan's
 * roots, and be neither something kept, nor hold one, nor lie inside a folder kept whole.
 */
export function refusal(plan: ResetPlan, target: string, platform: Platform): string | null {
  const within = (parent: string, child: string): boolean =>
    inside(
      platform === 'win32' ? parent.toLowerCase() : parent,
      platform === 'win32' ? child.toLowerCase() : child,
      platform,
    )
  if (!plan.roots.some((root) => within(root, target))) return 'outside the agent’s folders'
  for (const kept of plan.keep) {
    if (same(kept.path, target, platform) || within(target, kept.path)) return 'kept'
    if (kept.whole && within(kept.path, target)) return 'kept'
  }
  if (keptCodexDatabase(pathsOf(platform).basename(target))) return 'kept'
  return null
}
