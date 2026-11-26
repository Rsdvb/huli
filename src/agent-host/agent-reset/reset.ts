// Huli: a reset plan read against the disk, the list Settings shows, and the reset that removes
// what the user kept ticked. Only paths and key names are ever logged or returned, never what a
// file or an entry holds.

import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  AGENT_RESET_CATEGORIES,
  type AgentResetCategory,
  type AgentResetItem,
  type AgentResetResult,
} from '@shared/agent-reset'
import type { Platform } from '@shared/platform'
import { editJsonKeys, presentKeys } from './json-keys'
import { refusal, type ResetEntry, type ResetPlan, type SecretRef } from './plan'
import { secretName, type SecretStore } from './secrets'

/** An item of the list, with what the reset needs to remove it again. */
export interface ResolvedItem {
  item: AgentResetItem
  secret?: SecretRef
}

// A JSON file larger than this is not one an agent keeps its ids in.
const MAX_JSON_BYTES = 64 * 1024 * 1024
// A folder with more entries than this is counted only this far.
const MAX_COUNTED = 50_000
// Huli: one that takes longer than this to count has no size shown. A harness's 95,000
// node_modules files took 25 s under a virus scan, while the dialog showed only its loading lines.
const COUNT_MS = 2_000

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The bytes under `target`, without following links; null when counting them takes too long. */
export async function sizeOf(target: string, countMs = COUNT_MS): Promise<number | null> {
  let total = 0
  let counted = 0
  const until = Date.now() + countMs
  let late = false
  const visit = async (at: string): Promise<void> => {
    if (late || counted++ > MAX_COUNTED) return
    if (Date.now() > until) {
      late = true
      return
    }
    const info = await lstat(at).catch(() => null)
    if (!info) return
    if (!info.isDirectory()) {
      total += info.size
      return
    }
    const names = await readdir(at).catch(() => [] as string[])
    for (const name of names) await visit(path.join(at, name))
  }
  await visit(target)
  return late ? null : total
}

async function pathItem(
  category: AgentResetCategory,
  target: string,
): Promise<ResolvedItem | null> {
  try {
    const info = await lstat(target)
    const folder = info.isDirectory()
    return {
      item: {
        category,
        kind: folder ? 'folder' : 'file',
        path: target,
        bytes: folder ? await sizeOf(target) : info.size,
      },
    }
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function keysItem(
  category: AgentResetCategory,
  file: string,
  keys: readonly string[],
): Promise<ResolvedItem | null> {
  let size: number
  try {
    const info = await stat(file)
    if (!info.isFile()) return null
    size = info.size
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  const base = { category, kind: 'keys' as const, path: file, bytes: null }
  if (size > MAX_JSON_BYTES) return { item: { ...base, keys: [], problem: 'too large' } }
  const present = presentKeys(await readFile(file, 'utf8'), keys)
  if (present === null) return { item: { ...base, keys: [], problem: 'not JSON' } }
  return present.length > 0 ? { item: { ...base, keys: present } } : null
}

async function namesIn(folder: string, match: RegExp): Promise<string[]> {
  try {
    return (await readdir(folder)).filter((name) => match.test(name)).sort()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

async function entryItems(entry: ResetEntry, secrets: SecretStore): Promise<ResolvedItem[]> {
  switch (entry.kind) {
    case 'path': {
      const found = await pathItem(entry.category, entry.path)
      return found ? [found] : []
    }
    case 'children': {
      const names = await namesIn(entry.folder, entry.match)
      const found = await Promise.all(
        names.map((name) => pathItem(entry.category, path.join(entry.folder, name))),
      )
      return found.filter((item) => item !== null)
    }
    case 'keys': {
      const found = await keysItem(entry.category, entry.file, entry.keys)
      return found ? [found] : []
    }
    case 'keys-in': {
      const names = await namesIn(entry.folder, entry.match)
      const found = await Promise.all(
        names.map((name) => keysItem(entry.category, path.join(entry.folder, name), entry.keys)),
      )
      return found.filter((item) => item !== null)
    }
    case 'secret': {
      if (!(await secrets.has(entry.secret))) return []
      return [
        {
          item: {
            category: entry.category,
            kind: 'secret',
            path: secretName(entry.secret),
            store: entry.secret.store,
            bytes: null,
          },
          secret: entry.secret,
        },
      ]
    }
  }
}

/**
 * What of the plan is on this computer now, in the plan's order. A path the plan may not remove
 * is left out, as a check on the plan itself; a store that cannot be asked counts as empty.
 */
export async function resolvePlan(
  plan: ResetPlan,
  secrets: SecretStore,
  platform: Platform,
  log: (message: string) => void,
): Promise<ResolvedItem[]> {
  const lists = await Promise.all(
    plan.entries.map((entry) =>
      entryItems(entry, secrets).catch((error: unknown) => {
        log(`Could not check ${describe(entry)}: ${(error as Error).message}`)
        return [] as ResolvedItem[]
      }),
    ),
  )
  const seen = new Set<string>()
  return lists.flat().filter(({ item }) => {
    const key = `${item.category}\0${item.kind}\0${item.path}`
    if (seen.has(key)) return false
    seen.add(key)
    if ((item.kind === 'file' || item.kind === 'folder') && refusal(plan, item.path, platform)) {
      log(`The reset plan names ${item.path}, which it may not remove; it is left out`)
      return false
    }
    return true
  })
}

function describe(entry: ResetEntry): string {
  switch (entry.kind) {
    case 'path':
      return entry.path
    case 'children':
    case 'keys-in':
      return entry.folder
    case 'keys':
      return entry.file
    case 'secret':
      return secretName(entry.secret)
  }
}

/**
 * Removes what `items` name: whole files and folders, the keys out of each JSON file in one write
 * whatever categories asked for them, and the store's entries. Each failure is its item's alone.
 */
export async function applyReset(
  items: readonly ResolvedItem[],
  plan: ResetPlan,
  secrets: SecretStore,
  platform: Platform,
): Promise<AgentResetResult> {
  const result: AgentResetResult = { removed: [], failed: [] }
  const fail = (item: AgentResetItem, error: unknown): void => {
    result.failed.push({ item, error: (error as Error).message })
  }
  const edits = new Map<string, AgentResetItem[]>()
  for (const { item, secret } of items) {
    if (item.kind === 'keys') {
      if (item.problem) {
        fail(
          item,
          new Error(`${path.basename(item.path)} is ${item.problem}; it was left as it is`),
        )
        continue
      }
      edits.set(item.path, [...(edits.get(item.path) ?? []), item])
      continue
    }
    try {
      if (item.kind === 'file' || item.kind === 'folder') {
        const refused = refusal(plan, item.path, platform)
        if (refused) throw new Error(`${item.path} is ${refused}`)
        await rm(item.path, { recursive: true, force: true, maxRetries: 2 })
      } else if (item.kind === 'secret' && secret) {
        await secrets.remove(secret)
      } else {
        continue
      }
      result.removed.push(item)
    } catch (error) {
      fail(item, error)
    }
  }
  for (const [file, asked] of edits) {
    try {
      const removed = new Set(
        await editJsonKeys(
          file,
          asked.flatMap((item) => item.keys ?? []),
        ),
      )
      for (const item of asked) {
        const keys = (item.keys ?? []).filter((key) => removed.has(key))
        if (keys.length > 0) result.removed.push({ ...item, keys })
      }
    } catch (error) {
      for (const item of asked) fail(item, error)
    }
  }
  return result
}

/**
 * The names of what is kept that is there now: relative to the agent's folder inside it, else to
 * the home folder as `~`.
 */
export async function keptNames(
  plan: ResetPlan,
  platform: Platform,
  home: string,
): Promise<string[]> {
  const p = platform === 'win32' ? path.win32 : path.posix
  const within = (base: string, target: string): string | null => {
    const rel = p.relative(base, target)
    return rel && !rel.startsWith('..') && !p.isAbsolute(rel) ? rel : null
  }
  const found = await Promise.all(
    plan.keep.map(async (kept) => {
      const info = await lstat(kept.path).catch(() => null)
      if (!info) return null
      const inHome = within(home, kept.path)
      const name =
        (plan.folder ? within(plan.folder, kept.path) : null) ??
        (inHome ? `~${p.sep}${inHome}` : kept.path)
      return info.isDirectory() ? `${name}${p.sep}` : name
    }),
  )
  return found.filter((name) => name !== null)
}

/** What a reset removed and could not, by category, for the log: paths and key names only. */
export function resetLog(result: AgentResetResult): string {
  const name = (item: AgentResetItem): string =>
    item.kind === 'logout'
      ? `its sign-out (${item.path})`
      : item.kind === 'secret'
        ? `${item.store} entry ${item.path}`
        : item.keys?.length
          ? `${item.path} [${item.keys.join(', ')}]`
          : item.path
  const parts = AGENT_RESET_CATEGORIES.flatMap((category) => {
    const removed = result.removed.filter((item) => item.category === category).map(name)
    const failed = result.failed
      .filter(({ item }) => item.category === category)
      .map(({ item, error }) => `${name(item)} (${error})`)
    if (removed.length === 0 && failed.length === 0) return []
    const failures = failed.length > 0 ? `; could not remove ${failed.join('; ')}` : ''
    return [`${category}: removed ${removed.join('; ') || 'nothing'}${failures}`]
  })
  return parts.join(' | ') || 'nothing to remove'
}
