// Huli: an official Kettu's memory brought over: its global memory, about the user, into global
// memory here, and each project's into the same project's here. Every file is copied out of Kettu's
// data folder and read from the copy, and everything read is checked as untrusted. Kettu's undo
// records are not brought. Huli's own; see tools/huli/README.md.

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { KettuMemoryResult } from '@shared/kettu-import'
import { MEMORY_ID, type MemoryEntry, type MemoryScope } from '@shared/memory'
import type { Platform } from '@shared/platform'
import { parseEntry } from './memory/entry-file'
import type { AdoptOutcome } from './memory/service'
import { isAbsolutePath, isInside, pathKey } from './paths'
import type { LogFn } from './storage'

/** A file larger than this is no memory entry Kettu wrote. */
const MAX_FILE_BYTES = 256 * 1024
const MAX_PROJECT_FILE_BYTES = 64 * 1024
/** The project folders and files per folder looked at, at most. */
const MAX_PROJECTS = 1_000
const MAX_FILES = 2_000

/** An entry of Kettu's memory, as read from a copy of its file. */
export interface KettuMemoryEntry {
  /** The project's folder for project memory; null for global memory. */
  project: string | null
  entry: MemoryEntry
  /** Names the entry in the ledger: its layer and id. */
  key: string
  /** The SHA-256 of its title and body, which the ledger keeps to know it again. */
  hash: string
}

export interface KettuMemoryRead {
  entries: KettuMemoryEntry[]
  /** Files that are no entry: too large, not text, links, or in a folder naming no project. */
  malformed: number
}

/** One record of the ledger: an entry of Kettu's brought over as it was. */
export interface MemoryLedgerItem {
  key: string
  hash: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function memoryKey(project: string | null, id: string, platform: Platform): string {
  return sha256(
    project === null ? `global\0${id}` : `project\0${pathKey(project, platform)}\0${id}`,
  )
}

export function memoryHash(entry: { title: string; body: string }): string {
  return sha256(`${entry.title}\0${entry.body}`)
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The names in a folder; none when it is missing or no folder. */
async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

/**
 * The text of a regular file of Kettu's of at most `max` bytes, copied into `temp` and read back;
 * null when it is a link, larger or not UTF-8.
 */
async function copyText(file: string, temp: string, max: number): Promise<string | null> {
  const info = await lstat(file)
  if (!info.isFile() || info.size > max) return null
  // Read through Node's own open, which shares the file with Kettu's writes and renames.
  const bytes = await readFile(file)
  if (bytes.length > max) return null
  const copy = path.join(temp, `${sha256(file).slice(0, 16)}-${path.basename(file)}`)
  await writeFile(copy, bytes)
  try {
    return utf8.decode(await readFile(copy))
  } catch {
    return null
  }
}

/** The folder of the project a project memory folder belongs to, from its `project.json`. */
async function projectOf(dir: string, temp: string, platform: Platform): Promise<string | null> {
  try {
    const text = await copyText(path.join(dir, 'project.json'), temp, MAX_PROJECT_FILE_BYTES)
    if (text === null) return null
    const data = JSON.parse(text) as unknown
    if (typeof data !== 'object' || data === null) return null
    const folder = (data as Record<string, unknown>).path
    if (typeof folder !== 'string' || folder.length > 4096 || folder.includes('\0')) return null
    return isAbsolutePath(folder, platform) ? folder : null
  } catch {
    return null
  }
}

async function readLayer(
  dir: string,
  project: string | null,
  temp: string,
  platform: Platform,
  log: LogFn,
): Promise<KettuMemoryRead> {
  const out: KettuMemoryRead = { entries: [], malformed: 0 }
  const files = (await names(dir)).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md')
  for (const name of files.slice(0, MAX_FILES)) {
    const id = name.slice(0, -3)
    if (!MEMORY_ID.test(id)) {
      out.malformed++
      continue
    }
    const file = path.join(dir, name)
    try {
      const text = await copyText(file, temp, MAX_FILE_BYTES)
      if (text === null) {
        out.malformed++
        continue
      }
      const parsed = parseEntry(id, text)
      const modified = (await lstat(file)).mtimeMs
      const created = parsed.created ?? modified
      const entry: MemoryEntry = {
        ...parsed.entry,
        createdAt: created,
        updatedAt: Math.max(parsed.updated ?? modified, created),
      }
      out.entries.push({
        project,
        entry,
        key: memoryKey(project, id, platform),
        hash: memoryHash(entry),
      })
    } catch (error) {
      log('warn', `Could not read Kettu's memory entry ${file}: ${(error as Error).message}`)
      out.malformed++
    }
  }
  out.malformed += Math.max(0, files.length - MAX_FILES)
  return out
}

/**
 * Kettu's global and project memory, from copies of its files in `temp`. Its undo records, and
 * the projects inside Kettu's own data folder (its scratch folders), are left out.
 */
export async function readKettuMemory(
  source: string,
  temp: string,
  platform: Platform,
  log: LogFn,
): Promise<KettuMemoryRead> {
  const root = path.join(source, 'memory')
  const read = await readLayer(path.join(root, 'global'), null, temp, platform, log)
  const projects = path.join(root, 'projects')
  for (const name of (await names(projects)).slice(0, MAX_PROJECTS)) {
    const dir = path.join(projects, name)
    const info = await lstat(dir).catch(() => null)
    if (!info?.isDirectory()) continue
    const project = await projectOf(dir, temp, platform)
    const layer = await readLayer(dir, project ?? source, temp, platform, log)
    if (project === null || isInside(project, source, platform)) {
      read.malformed += layer.entries.length + layer.malformed
      continue
    }
    read.entries.push(...layer.entries)
    read.malformed += layer.malformed
  }
  return read
}

/** What bringing memory over asks of this app. */
export interface MemoryImportDeps {
  memory: {
    list(scope: MemoryScope): Promise<MemoryEntry[]>
    adopt(scope: MemoryScope, entries: readonly MemoryEntry[]): Promise<AdoptOutcome[]>
  }
  /** Whether this app lists a project at the folder. */
  hasProject(folder: string): boolean
  /** Adds the project; only for a folder that exists. */
  addProject(folder: string): Promise<unknown>
  isDirectory(folder: string): Promise<boolean>
  /** This app's session that Kettu's became when it was imported; null when it was not. */
  sessionOf(kettuId: string): string | null
  /** What earlier imports brought over. */
  ledger: readonly MemoryLedgerItem[]
  platform: Platform
}

/** The entries grouped by layer, in the order they were read. */
function byLayer(
  entries: readonly KettuMemoryEntry[],
  platform: Platform,
): { project: string | null; entries: KettuMemoryEntry[] }[] {
  const layers = new Map<string, { project: string | null; entries: KettuMemoryEntry[] }>()
  for (const item of entries) {
    const key = item.project === null ? '' : pathKey(item.project, platform)
    let layer = layers.get(key)
    if (!layer) {
      layer = { project: item.project, entries: [] }
      layers.set(key, layer)
    }
    layer.entries.push(item)
  }
  return [...layers.values()]
}

function scopeOf(project: string | null): MemoryScope {
  return project === null ? { layer: 'global' } : { layer: 'project', project }
}

/** How many of the entries read are neither brought over before nor here already. */
export async function countNewMemory(
  read: KettuMemoryRead,
  deps: Pick<MemoryImportDeps, 'memory' | 'hasProject' | 'ledger' | 'platform'>,
): Promise<number> {
  const done = new Set(deps.ledger.map((item) => `${item.key}\0${item.hash}`))
  let count = 0
  for (const layer of byLayer(read.entries, deps.platform)) {
    const held =
      layer.project === null || deps.hasProject(layer.project)
        ? await deps.memory.list(scopeOf(layer.project)).catch(() => [])
        : []
    const contents = new Set(held.map(memoryHash))
    for (const item of layer.entries) {
      if (!done.has(`${item.key}\0${item.hash}`) && !contents.has(item.hash)) count++
    }
  }
  return count
}

/**
 * Brings the entries over, layer by layer. An entry the ledger has as it is now is not brought
 * again, even when it was changed or forgotten here since; one whose title and body its layer
 * holds is skipped; one whose id is taken here by other content comes under a new id. A project
 * this app lacks is added when its folder exists, and its entries skipped when it does not.
 * Returns the result and what the ledger gains.
 */
export async function importKettuMemory(
  read: KettuMemoryRead,
  deps: MemoryImportDeps,
): Promise<{ result: KettuMemoryResult; ledger: MemoryLedgerItem[] }> {
  const result: KettuMemoryResult = {
    imported: 0,
    renamed: [],
    skipped: { imported: 0, same: 0, invalid: read.malformed, secret: 0, full: 0, noProject: 0 },
  }
  const done = new Set(deps.ledger.map((item) => `${item.key}\0${item.hash}`))
  const ledger: MemoryLedgerItem[] = []
  for (const layer of byLayer(read.entries, deps.platform)) {
    const fresh = layer.entries.filter((item) => !done.has(`${item.key}\0${item.hash}`))
    result.skipped.imported += layer.entries.length - fresh.length
    if (fresh.length === 0) continue
    if (layer.project !== null && !deps.hasProject(layer.project)) {
      if (!(await deps.isDirectory(layer.project))) {
        result.skipped.noProject += fresh.length
        continue
      }
      await deps.addProject(layer.project)
    }
    const entries = fresh.map(({ entry }) => ({
      ...entry,
      source: {
        agentId: entry.source.agentId,
        sessionId: entry.source.sessionId === null ? null : deps.sessionOf(entry.source.sessionId),
      },
    }))
    const outcomes = await deps.memory.adopt(scopeOf(layer.project), entries)
    for (const [index, outcome] of outcomes.entries()) {
      const item = fresh[index]!
      switch (outcome.kind) {
        case 'renamed':
          result.renamed.push({ title: item.entry.title, id: outcome.id, as: outcome.as })
          result.imported++
          ledger.push({ key: item.key, hash: item.hash })
          break
        case 'added':
          result.imported++
          ledger.push({ key: item.key, hash: item.hash })
          break
        default:
          result.skipped[outcome.kind]++
      }
    }
  }
  return { result, ledger }
}
