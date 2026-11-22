// Huli: how Agent sync reads and writes the agents' files: as exact bytes, refusing a file that
// is not UTF-8 rather than rewriting it; through a link to the file it points at; and by a file
// beside the target renamed over it, after a copy of the old one went into Kite's data.

import { createHash, randomBytes } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

/** The largest agent file Agent sync reads; `.claude.json` grows with every project. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024
/** The most a skill folder may hold to be copied. */
export const SKILL_LIMITS = { files: 1_000, bytes: 50 * 1024 * 1024 }

export type ReadProblem = 'not-utf8' | 'too-large' | 'not-file'

export interface FileRead {
  /** Null when the file does not exist. */
  text: string | null
  /** The bytes' hash, or `missing`; a write goes ahead only while it is still this. */
  stamp: string
  problem: ReadProblem | null
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function hashOf(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The file's text and stamp; a file that is not UTF-8 has its stamp but no text. */
export async function readExact(file: string): Promise<FileRead> {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    if (isMissing(error)) return { text: null, stamp: 'missing', problem: null }
    throw error
  }
  if (!info.isFile()) return { text: null, stamp: 'not-file', problem: 'not-file' }
  if (info.size > MAX_FILE_BYTES)
    return { text: null, stamp: `size:${info.size}`, problem: 'too-large' }
  const data = await readFile(file)
  const stamp = hashOf(data)
  try {
    return { text: decoder.decode(data), stamp, problem: null }
  } catch {
    return { text: null, stamp, problem: 'not-utf8' }
  }
}

/** The stamp of the file as it is now. */
export async function stampOf(file: string): Promise<string> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return 'not-file'
    if (info.size > MAX_FILE_BYTES) return `size:${info.size}`
    return hashOf(await readFile(file))
  } catch (error) {
    if (isMissing(error)) return 'missing'
    throw error
  }
}

/** The file a link at `file` points to, so a write keeps the link; `file` itself otherwise. */
async function writeTarget(file: string): Promise<string> {
  try {
    if ((await lstat(file)).isSymbolicLink()) return await realpath(file)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  return file
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Writes `text` beside the file, flushes it and renames it over the file, keeping the old file's
 * mode; a new file gets `mode`.
 */
export async function writeAtomic(file: string, text: string, mode: number): Promise<void> {
  const target = await writeTarget(file)
  await mkdir(path.dirname(target), { recursive: true })
  let keep = mode
  try {
    keep = (await stat(target)).mode & 0o777
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.kite-${randomBytes(4).toString('hex')}.tmp`,
  )
  const handle = await open(temp, 'wx', keep)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // On Windows a scanner or indexer can hold the target open for a moment.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt >= 4 || !RETRYABLE.has(code)) {
        await rm(temp, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

export interface BackupEntry {
  original: string
  copy: string
}

/**
 * Copies each existing file into a new folder under `root`, with a list of where each came from,
 * and keeps only the newest `keep` folders. Returns the folder and what it holds.
 */
export async function backUp(
  root: string,
  files: readonly string[],
  now: number,
  keep = 30,
): Promise<{ dir: string; entries: BackupEntry[] }> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const dir = path.join(root, `${stamp}-${randomBytes(3).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  const entries: BackupEntry[] = []
  for (const [index, file] of files.entries()) {
    const copy = path.join(dir, `${index + 1}-${path.basename(file)}`)
    try {
      await copyFile(file, copy)
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    entries.push({ original: file, copy })
  }
  await writeFile(path.join(dir, 'backup.json'), `${JSON.stringify({ entries }, null, 2)}\n`, {
    mode: 0o600,
  })
  await prune(root, keep)
  return { dir, entries }
}

async function prune(root: string, keep: number): Promise<void> {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    await rm(path.join(root, name), { recursive: true, force: true })
  }
}

export interface FolderList {
  files: { path: string; size: number }[]
  bytes: number
  /** Changes when a file is added, taken out, resized or touched. */
  stamp: string
}

export class FolderError extends Error {
  constructor(
    readonly code: 'link' | 'too-many' | 'too-large',
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`)
  }
}

/** The files in `root`, refusing a link inside it and stopping at the skill limits. */
export async function listFolder(root: string): Promise<FolderList> {
  const files: FolderList['files'] = []
  const stampParts: string[] = []
  let bytes = 0
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new FolderError('link', relative)
      if (entry.isDirectory()) {
        await walk(full, relative)
        continue
      }
      if (!entry.isFile()) continue
      const info = await lstat(full)
      bytes += info.size
      files.push({ path: relative, size: info.size })
      stampParts.push(`${relative}\0${info.size}\0${info.mtimeMs}`)
      if (files.length > SKILL_LIMITS.files) throw new FolderError('too-many', String(files.length))
      if (bytes > SKILL_LIMITS.bytes) throw new FolderError('too-large', String(bytes))
    }
  }
  await walk(root, '')
  return { files, bytes, stamp: hashOf(stampParts.join('\n')) }
}

/** Copies the listed files of `from` into a folder beside `to`, then renames it to `to`. */
export async function copyFolder(from: string, to: string, list: FolderList): Promise<void> {
  const partial = path.join(
    path.dirname(to),
    `.${path.basename(to)}.kite-${randomBytes(4).toString('hex')}.partial`,
  )
  await mkdir(partial, { recursive: true })
  try {
    for (const file of list.files) {
      const parts = file.path.split('/')
      const target = path.join(partial, ...parts)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(path.join(from, ...parts), target)
    }
    await rename(partial, to)
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }
}

/** Whether anything is at `target`, a link included. */
export async function existsAt(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}
