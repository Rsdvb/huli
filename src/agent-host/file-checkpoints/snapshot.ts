// Huli: a session folder's files at one moment, as a checkpoint keeps them. In a repository only
// what differs from HEAD is copied, so a checkpoint costs one `git status` and the copies of the
// changed and untracked files; elsewhere every file is copied, within the limits below.

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, opendir, readlink, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { repoOf, statusOf, type RepoInfo, type RunGit } from './git'

/** One path's content in a checkpoint. */
export type FileState =
  /** A copy in the store: the SHA-256 of its bytes, its size, and whether it may be run. */
  | { k: 'f'; h: string; s: number; x?: true }
  /** A symbolic link, to `t`. */
  | { k: 'l'; t: string }
  /** No file, where HEAD has one. */
  | { k: 'd' }

export interface Snapshot {
  v: 1
  /** When its listing was taken; a file changed since was not copied. */
  at: number
  /** The repository the folder is in, and HEAD then; null outside one. */
  git: (RepoInfo & { head: string | null }) | null
  /**
   * By path relative to the folder, `/`-separated. In a repository, the paths that differed from
   * HEAD, every other one being HEAD's blob as checked out; elsewhere, every file.
   */
  files: Record<string, FileState>
  /** Paths there that were not kept: too large, too many, or changing while copied. */
  skipped: string[]
  /** More files were there than are named: a path the snapshot does not name is unknown. */
  partial: boolean
}

export const LIMITS = {
  /** A file larger than this is not copied. */
  fileBytes: 16 * 1024 * 1024,
  /** At most this many files are copied for one checkpoint. */
  files: 5000,
  /** At most this much is copied for one checkpoint that the store does not hold yet. */
  newBytes: 128 * 1024 * 1024,
  /** At most this many skipped paths are named; past it the snapshot is partial. */
  skippedNamed: 2000,
  /** Copies running at once. */
  parallel: 4,
}

// Outside a repository nothing says what is generated, so these are left out as git would leave
// them out of most repositories.
const PLAIN_SKIP = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.gradle',
  '.pnpm-store',
  '.DS_Store',
  'Thumbs.db',
])

/** What was copied before, by the file's identity, so an unchanged file is not read again. */
export type CopyCache = Map<string, { h: string; s: number }>

export interface CaptureOptions {
  run: RunGit
  folder: string
  /** The store's object folder and a folder of its own for files being copied. */
  objects: string
  temp: string
  cache: CopyCache
  now?: () => number
  limits?: typeof LIMITS
  /** Paths below the folder that another checkpoint of the session keeps, relative and `/`-separated. */
  exclude?: readonly string[]
  /** The repository the folder was last found in, null for none; looked up when not given. */
  repo?: RepoInfo | null
}

export interface Capture {
  /** Settles once the listing is taken: a turn may start then, its changes coming after `at`. */
  listed: Promise<number>
  /** The snapshot, once its files are copied. */
  done: Promise<Snapshot>
}

/** A path relative to the folder, `/`-separated, as snapshots name it. */
export function toKey(relative: string): string {
  return relative.split(path.sep).join('/')
}

/** The absolute path of a key inside `folder`, or null for one that would leave it. */
export function fromKey(folder: string, key: string): string | null {
  if (key === '' || key.includes('\0') || key.includes('\\') || key.startsWith('/')) return null
  const parts = key.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  if (/^[A-Za-z]:/.test(parts[0]!)) return null
  if (parts.some((part) => part.toLowerCase() === '.git')) return null
  return path.join(folder, ...parts)
}

/**
 * Lists the folder, then copies what the snapshot keeps. The listing is awaited before the turn
 * starts; the copying may run on beside it, since a file whose change time is past the listing
 * is not copied but named as skipped.
 */
export function capture(options: CaptureOptions): Capture {
  const now = options.now ?? Date.now
  const limits = options.limits ?? LIMITS
  let resolveListed!: (at: number) => void
  let rejectListed!: (error: unknown) => void
  const listed = new Promise<number>((resolve, reject) => {
    resolveListed = resolve
    rejectListed = reject
  })
  const done = (async (): Promise<Snapshot> => {
    let listing: Listing
    try {
      listing = await list(options, limits)
    } catch (error) {
      rejectListed(error)
      throw error
    }
    const at = now()
    resolveListed(at)
    return copyAll(options, listing, at, limits)
  })()
  // Whoever awaits `listed` alone must not leave a failed copy unhandled.
  done.catch(() => {})
  return { listed, done }
}

interface Listing {
  git: Snapshot['git']
  /** Paths to copy, or to record as gone, relative to the folder. */
  paths: { key: string; present: boolean }[]
  partial: boolean
}

async function list(options: CaptureOptions, limits: typeof LIMITS): Promise<Listing> {
  const excluded = (key: string): boolean =>
    (options.exclude ?? []).some((prefix) => key === prefix || key.startsWith(`${prefix}/`))
  let repo = options.repo === undefined ? await repoOf(options.run, options.folder) : options.repo
  // A folder that became a repository since, as by `git init`, is looked up again.
  if (
    repo === null &&
    options.repo === null &&
    (await present(path.join(options.folder, '.git')))
  ) {
    repo = await repoOf(options.run, options.folder)
  }
  if (repo) {
    const status = await statusOf(options.run, options.folder)
    if (status) {
      const paths: Listing['paths'] = []
      for (const entry of status.entries) {
        if (repo.prefix && !entry.path.startsWith(repo.prefix)) continue
        const key = entry.path.slice(repo.prefix.length)
        // A nested repository shows as its folder; it is its own to keep.
        if (key === '' || key.endsWith('/') || excluded(key)) continue
        paths.push({ key, present: entry.present })
      }
      return { git: { ...repo, head: status.head }, paths, partial: false }
    }
  }
  const paths: Listing['paths'] = []
  let partial = false
  const most = limits.files + limits.skippedNamed
  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (partial) return
    let handle
    try {
      handle = await opendir(dir)
    } catch {
      return
    }
    for await (const entry of handle) {
      if (PLAIN_SKIP.has(entry.name)) continue
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      if (excluded(key)) continue
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), key)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (paths.length >= most) {
          partial = true
          return
        }
        paths.push({ key, present: true })
      }
      if (partial) return
    }
  }
  await walk(options.folder, '')
  return { git: null, paths, partial }
}

async function copyAll(
  options: CaptureOptions,
  listing: Listing,
  at: number,
  limits: typeof LIMITS,
): Promise<Snapshot> {
  const files: Record<string, FileState> = {}
  const skipped: string[] = []
  let partial = listing.partial
  let copied = 0
  let newBytes = 0
  const skip = (key: string): void => {
    if (skipped.length < limits.skippedNamed) skipped.push(key)
    else partial = true
  }
  await mkdir(options.temp, { recursive: true })
  const queue = [...listing.paths]
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { key, present } = item
      if (!present) {
        files[key] = { k: 'd' }
        continue
      }
      const abs = fromKey(options.folder, key)
      if (abs === null) continue
      if (copied >= limits.files) {
        skip(key)
        continue
      }
      copied++
      const kept = await keep(options, abs, at, limits, () => newBytes).catch(() => null)
      if (kept === null) {
        skip(key)
        continue
      }
      if (kept.added) newBytes += kept.added
      files[key] = kept.state
    }
  }
  await Promise.all(Array.from({ length: limits.parallel }, worker))
  skipped.sort()
  return { v: 1, at, git: listing.git, files: sorted(files), skipped, partial }
}

function sorted(files: Record<string, FileState>): Record<string, FileState> {
  const out: Record<string, FileState> = {}
  for (const key of Object.keys(files).sort()) out[key] = files[key]!
  return out
}

/**
 * A file system's clock may run ahead of `Date.now()` by up to a tick of the system's timer (15.6
 * ms on Windows), and its times carry a fraction of a millisecond; a change this close to the
 * listing came before it. No agent acts within it, as its turn starts only after the listing.
 */
const CLOCK_SLACK_MS = 20

/** Whether a file changed after `at`, the time the listing ended. */
function changedAfter(info: { ctimeMs: number }, at: number): boolean {
  return info.ctimeMs > at + CLOCK_SLACK_MS
}

function identity(info: {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}

/**
 * Keeps one file: a link by its target, a regular file by a copy in the store. Null when it may
 * not be kept as it was at `at`: too large, over the checkpoint's budget, changed since `at`, or
 * changing while it was read.
 */
async function keep(
  options: CaptureOptions,
  abs: string,
  at: number,
  limits: typeof LIMITS,
  spent: () => number,
): Promise<{ state: FileState; added: number } | null> {
  const before = await lstat(abs)
  if (changedAfter(before, at)) return null
  if (before.isSymbolicLink()) {
    const target = await readlink(abs)
    const after = await lstat(abs)
    if (after.ctimeMs !== before.ctimeMs) return null
    return { state: { k: 'l', t: target }, added: 0 }
  }
  if (!before.isFile() || before.size > limits.fileBytes) return null
  const exec = process.platform !== 'win32' && (before.mode & 0o111) !== 0
  const id = identity(before)
  const cached = options.cache.get(id)
  if (cached) {
    return { state: { k: 'f', h: cached.h, s: cached.s, ...(exec ? { x: true } : {}) }, added: 0 }
  }
  if (spent() + before.size > limits.newBytes) return null
  const temp = path.join(options.temp, randomUUID())
  const hash = createHash('sha256')
  try {
    await pipeline(
      createReadStream(abs),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk as Buffer)
          yield chunk
        }
      },
      createWriteStream(temp),
    )
    const after = await lstat(abs)
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.ino !== before.ino
    ) {
      await rm(temp, { force: true })
      return null
    }
    const h = hash.digest('hex')
    const target = objectPath(options.objects, h)
    let added = 0
    if (await present(target)) {
      await rm(temp, { force: true })
    } else {
      await mkdir(path.dirname(target), { recursive: true })
      await rename(temp, target)
      added = before.size
    }
    options.cache.set(id, { h, s: before.size })
    return { state: { k: 'f', h, s: before.size, ...(exec ? { x: true } : {}) }, added }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export function objectPath(objects: string, h: string): string {
  return path.join(objects, h.slice(0, 2), h.slice(2))
}

async function present(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}
