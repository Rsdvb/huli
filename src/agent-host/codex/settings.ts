// Huli: what a Codex agent's page edits in Codex's own configuration, read and written only
// through app-server's config API: `config/read` for the values and where each comes from,
// `experimentalFeature/list` and `permissionProfile/list` for what there is to pick, and
// `config/value/write`, one key at a time, which edits config.toml in place and keeps the user's
// comments. A Codex without one of the lists leaves that part out.

import type { CodexFeature, CodexSettingChange, CodexSettings } from '@shared/agent-host'
import { t } from '../i18n'
import type { CodexRequest } from '../marketplace/codex-plugins'

export const MEMORIES_FEATURE = 'memories'
const KEYS = {
  memories: `features.${MEMORIES_FEATURE}`,
  networkAccess: 'sandbox_workspace_write.network_access',
  permissionProfile: 'default_permissions',
} as const
/** A feature's key as `[features]` names them. */
const FEATURE_NAME = /^[a-z0-9][a-z0-9_]{0,63}$/
/** A profile's id: a built-in's starts with a colon. */
const PROFILE_ID = /^:?[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
/** The layers the user's config.toml cannot override. */
const MANAGED = new Set([
  'mdm',
  'system',
  'enterpriseManaged',
  'legacyManagedConfigTomlFromFile',
  'legacyManagedConfigTomlFromMdm',
])
const MAX_PAGES = 10

type Config = Record<string, unknown>
interface Read {
  config: Config
  origins?: Record<string, { name?: { type?: unknown } } | undefined>
}
interface Feature {
  name: string
  stage: string
  enabled: boolean
  defaultEnabled: boolean
  displayName?: string | null
  description?: string | null
}
interface Profile {
  id: string
  description?: string | null
  allowed: boolean
}

const isObject = (value: unknown): value is Config =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether app-server lacks a method, which an older Codex answers with an error naming it. */
function unknownMethod(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  return (
    code === -32601 || (typeof message === 'string' && /unknown variant|not found/i.test(message))
  )
}

/** Every page of a list, or null when this Codex has no such list. */
async function list<T>(request: CodexRequest, method: string): Promise<T[] | null> {
  const items: T[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    let answer: { data: T[]; nextCursor?: string | null }
    try {
      answer = await request(method, cursor ? { cursor } : {})
    } catch (error) {
      if (unknownMethod(error)) return null
      throw error
    }
    items.push(...answer.data)
    cursor = answer.nextCursor ?? null
    if (!cursor) break
  }
  return items
}

/** A `[features]` entry's value: a switch, or a table with its `enabled`. */
function featureOn(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return isObject(value) && typeof value.enabled === 'boolean' ? value.enabled : null
}

/** The user's `sandbox_workspace_write`, as a workspace turn of Kite's takes it. */
export function workspaceWrite(config: Config): {
  networkAccess: boolean
  writableRoots: string[]
} {
  const table = isObject(config.sandbox_workspace_write) ? config.sandbox_workspace_write : {}
  const roots = Array.isArray(table.writable_roots) ? table.writable_roots : []
  return {
    networkAccess: table.network_access === true,
    writableRoots: roots.filter((root): root is string => typeof root === 'string' && root !== ''),
  }
}

export async function readCodexSettings(request: CodexRequest): Promise<CodexSettings> {
  const [read, features, profiles] = await Promise.all([
    request<Read>('config/read', {}),
    list<Feature>(request, 'experimentalFeature/list'),
    list<Profile>(request, 'permissionProfile/list'),
  ])
  const { config } = read
  const featureTable = isObject(config.features) ? config.features : {}
  const memories =
    features?.find((feature) => feature.name === MEMORIES_FEATURE)?.enabled ??
    featureOn(featureTable[MEMORIES_FEATURE]) ??
    (features ? null : false)
  const locked = Object.entries(read.origins ?? {})
    .filter(([, origin]) => MANAGED.has(String(origin?.name?.type)))
    .map(([key]) => key)
  const profile = config.default_permissions
  return {
    memories,
    workspace: workspaceWrite(config),
    permissionProfile: typeof profile === 'string' && profile !== '' ? profile : null,
    profiles:
      profiles?.map((item) => ({
        id: item.id,
        description: item.description ?? null,
        allowed: item.allowed,
      })) ?? null,
    features:
      features
        ?.filter(
          (feature): feature is Feature & { displayName: string } =>
            feature.stage === 'beta' && feature.name !== MEMORIES_FEATURE && !!feature.displayName,
        )
        .map((feature): CodexFeature => ({
          name: feature.name,
          displayName: feature.displayName,
          description: feature.description ?? null,
          enabled: feature.enabled,
          defaultEnabled: feature.defaultEnabled,
        })) ?? null,
    locked,
  }
}

/** Checks a change's shape before anything is asked of Codex; the host's request validation. */
export function checkCodexChange(raw: unknown): CodexSettingChange {
  const change = isObject(raw) ? raw : {}
  const flag = (value: unknown): boolean => {
    if (typeof value !== 'boolean') throw new Error(t('codex.settings.notSwitch'))
    return value
  }
  switch (change.setting) {
    case 'memories':
      return { setting: 'memories', value: flag(change.value) }
    case 'networkAccess':
      return { setting: 'networkAccess', value: flag(change.value) }
    case 'permissionProfile': {
      const value = change.value
      if (value !== null && (typeof value !== 'string' || !PROFILE_ID.test(value))) {
        throw new Error(t('codex.settings.badProfile'))
      }
      return { setting: 'permissionProfile', value }
    }
    case 'feature': {
      const name = change.name
      if (typeof name !== 'string' || !FEATURE_NAME.test(name) || name === MEMORIES_FEATURE) {
        throw new Error(t('codex.settings.badFeature'))
      }
      return { setting: 'feature', name, value: flag(change.value) }
    }
    default:
      throw new Error(t('codex.settings.unknown'))
  }
}

/**
 * Writes one key through `config/value/write`. A profile or a feature must be one this Codex
 * lists, so nothing it would not read lands in the file.
 */
export async function writeCodexSetting(
  request: CodexRequest,
  change: CodexSettingChange,
): Promise<void> {
  let keyPath: string
  const value: unknown = change.value
  switch (change.setting) {
    case 'memories':
      keyPath = KEYS.memories
      break
    case 'networkAccess':
      keyPath = KEYS.networkAccess
      break
    case 'permissionProfile': {
      keyPath = KEYS.permissionProfile
      if (change.value !== null) {
        const profiles = await list<Profile>(request, 'permissionProfile/list')
        const listed = profiles?.find((profile) => profile.id === change.value)
        if (!listed?.allowed) throw new Error(t('codex.settings.badProfile'))
      }
      break
    }
    case 'feature': {
      const features = await list<Feature>(request, 'experimentalFeature/list')
      if (!features?.some((feature) => feature.name === change.name && feature.stage === 'beta')) {
        throw new Error(t('codex.settings.badFeature'))
      }
      keyPath = `features.${change.name}`
      break
    }
  }
  await request('config/value/write', { keyPath, value, mergeStrategy: 'replace' })
}
