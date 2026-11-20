// Huli: one backup of the data folder into a zip in the backup folder, run in the backup's own
// utility process. The databases are copied through SQLite (`VACUUM INTO`), which reads one
// consistent state of a database the agent host has open; the content folders they name are
// copied before them and topped up after, so every file a copy names is in the zip. The zip is
// written under a temporary name and renamed once whole, then the oldest backups go.

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BackupProblem } from '@shared/backup'
import { buildManifest, MANIFEST_NAME, type ManifestFile } from './manifest'
import { BACKUP_PREFIX, backupName, isPartial, PARTIAL_SUFFIX, toPrune } from './names'
import { CONTENT_FOLDERS, DATABASES, keptRoots, LEFT_OUT, partOf, type Part } from './plan'
import { ZipWriter } from './zip'

/** A run that could not finish, and why, in words Settings turns into the user's language. */
export class BackupFailure extends Error {
  constructor(
    readonly problem: BackupProblem,
    message: string,
  ) {
    super(message)
    this.name = 'BackupFailure'
  }
}

export interface BackupJob {
  dataDir: string
  destDir: string
  /** The default folder is made when missing; a folder the user picked must be there. */
  createDest: boolean
  /** How many daily backups the folder keeps; 0 removes none. */
  keep: number
  app: string
  platform: string
  /** `Kite-backup-` for a daily or manual backup, `Kite-before-restore-` for a safety copy. */
  prefix?: string
  /** Where the databases' copies are made before they go into the zip. */
  tempDir?: string
  now?: () => Date
  progress?: (done: number, total: number) => void
}

export interface BackupDone {
  file: string
  path: string
  bytes: number
  files: number
  durationMs: number
  pruned: string[]
}

interface Found {
  path: string
  size: number
  modified: Date
  part: Part
}

// Formats that are compressed already, stored as they are rather than deflated again.
const STORED_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'mp3',
  'm4a',
  'ogg',
  'mp4',
  'webm',
  'weba',
  'mov',
  'zip',
  'gz',
  'tgz',
  '7z',
  'woff',
  'woff2',
])

function compressible(file: string): boolean {
  const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  return !STORED_EXTENSIONS.has(extension)
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? ''
}

/** Every file under `folder` the backup keeps, by its path relative to the data folder. */
async function walk(dataDir: string, folder: string, found: Map<string, Found>): Promise<void> {
  let entries
  try {
    entries = await readdir(path.join(dataDir, folder), { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return
    throw error
  }
  for (const entry of entries) {
    const relative = `${folder}/${entry.name}`
    if (entry.isDirectory()) {
      await walk(dataDir, relative, found)
      continue
    }
    // Links are left alone: a backup holds the data folder's own files only.
    if (!entry.isFile()) continue
    const part = partOf(relative)
    if (!part || found.has(relative)) continue
    try {
      const info = await stat(path.join(dataDir, relative))
      found.set(relative, { path: relative, size: info.size, modified: info.mtime, part })
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
}

/** The files the backup keeps, as the data folder holds them now. */
export async function listKept(dataDir: string): Promise<Found[]> {
  const found = new Map<string, Found>()
  const { files, folders } = keptRoots()
  for (const name of files) {
    try {
      const info = await stat(path.join(dataDir, name))
      if (info.isFile()) {
        found.set(name, { path: name, size: info.size, modified: info.mtime, part: 'file' })
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
  for (const folder of folders) await walk(dataDir, folder, found)
  return [...found.values()]
}

/**
 * A consistent copy of the database at `source` in `target`, and the schema version it is at;
 * null when there is none.
 */
function copyDatabase(source: string, target: string): number | null {
  // Opening a database that is not there would make an empty one.
  if (!existsSync(source)) return null
  const db = new DatabaseSync(source, { timeout: 30_000 })
  try {
    db.prepare('VACUUM INTO ?').run(target)
  } finally {
    db.close()
  }
  const copy = new DatabaseSync(target, { readOnly: true })
  try {
    return Number(copy.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  } finally {
    copy.close()
  }
}

async function prepareDest(destDir: string, create: boolean): Promise<void> {
  try {
    const info = await stat(destDir)
    if (!info.isDirectory()) {
      throw new BackupFailure('destination-missing', `${destDir} is not a folder`)
    }
  } catch (error) {
    if (error instanceof BackupFailure) throw error
    if (errorCode(error) !== 'ENOENT') throw error
    if (!create) throw new BackupFailure('destination-missing', `${destDir} is not there`)
    await mkdir(destDir, { recursive: true })
  }
}

/** Leftovers of a run that stopped half-way, a day old or more, so a run under way is spared. */
async function removePartials(destDir: string, names: readonly string[], now: Date): Promise<void> {
  for (const name of names) {
    if (!isPartial(name)) continue
    const file = path.join(destDir, name)
    try {
      const info = await stat(file)
      if (now.getTime() - info.mtimeMs > 24 * 60 * 60 * 1000) await rm(file, { force: true })
    } catch {
      // Another run may have taken it already.
    }
  }
}

function failure(error: unknown, destDir: string): BackupFailure {
  if (error instanceof BackupFailure) return error
  const code = errorCode(error)
  const message = (error as Error)?.message ?? String(error)
  if (code === 'ENOSPC') return new BackupFailure('no-space', message)
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new BackupFailure('destination-unwritable', `${destDir}: ${message}`)
  }
  return new BackupFailure('failed', message)
}

export async function runBackup(job: BackupJob): Promise<BackupDone> {
  const now = job.now ?? (() => new Date())
  const started = now()
  const prefix = job.prefix ?? BACKUP_PREFIX
  await prepareDest(job.destDir, job.createDest).catch((error: unknown) => {
    throw failure(error, job.destDir)
  })
  const existing = await readdir(job.destDir).catch((error: unknown) => {
    throw failure(error, job.destDir)
  })
  await removePartials(job.destDir, existing, started)

  const kept = await listKept(job.dataDir)
  const total = kept.reduce((sum, file) => sum + file.size, 0)
  try {
    const space = await statfs(job.destDir)
    // Compressed, a backup is at most its files' size and usually well under half of it.
    if (space.bavail * space.bsize < total / 2) {
      throw new BackupFailure('no-space', `${job.destDir} has too little free space`)
    }
  } catch (error) {
    if (error instanceof BackupFailure) throw error
    // A folder whose free space cannot be read still gets a try.
  }

  const name = backupName(started, prefix, new Set(existing))
  const final = path.join(job.destDir, name)
  const partial = `${final}${PARTIAL_SUFFIX}`
  const scratch = path.join(
    job.tempDir ?? tmpdir(),
    `kite-backup-${randomBytes(6).toString('hex')}`,
  )
  let zip: ZipWriter | null = null
  try {
    zip = await ZipWriter.create(partial)
    const writer = zip
    const files: ManifestFile[] = []
    const added = new Set<string>()
    let done = 0
    const report = (size: number): void => {
      done += size
      job.progress?.(Math.min(done, total), total)
    }
    const add = async (file: Found, source = path.join(job.dataDir, file.path)): Promise<void> => {
      try {
        const written = await writer.addFile(file.path, source, {
          compress: compressible(file.path),
          modified: file.modified,
          expected: file.size,
        })
        files.push({ path: file.path, size: written.size, sha256: written.sha256, part: file.part })
        added.add(file.path)
      } catch (error) {
        // Gone since it was listed, as a file a session removed; the zip holds no part of it.
        if (errorCode(error) !== 'ENOENT') throw error
      }
      report(file.size)
    }

    const content = kept.filter((file) => file.part === 'content')
    for (const file of content) await add(file)

    await mkdir(scratch, { recursive: true })
    const schemas: Record<string, number> = {}
    for (const database of DATABASES) {
      const file = kept.find((found) => found.path === database)
      if (!file) continue
      const copy = path.join(scratch, path.basename(database))
      const schema = copyDatabase(path.join(job.dataDir, database), copy)
      if (schema === null) continue
      schemas[database] = schema
      const info = await stat(copy)
      await add({ ...file, size: info.size }, copy)
      await rm(copy, { force: true })
    }

    for (const file of kept) {
      if (file.part === 'file') await add(file)
    }

    // What the databases' copies may name that came after the first pass.
    const later = new Map<string, Found>()
    for (const folder of CONTENT_FOLDERS) await walk(job.dataDir, folder, later)
    for (const file of later.values()) {
      if (!added.has(file.path)) await add(file)
    }

    const manifest = buildManifest({
      app: job.app,
      created: started,
      platform: job.platform,
      leftOut: LEFT_OUT,
      schemas,
      files,
    })
    await writer.addBuffer(MANIFEST_NAME, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), {
      compress: true,
      modified: started,
    })
    await writer.close()
    zip = null
    await rename(partial, final)
    const bytes = (await stat(final)).size

    const pruned: string[] = []
    if (job.keep > 0 && prefix === BACKUP_PREFIX) {
      const names = await readdir(job.destDir)
      for (const old of toPrune(names, job.keep)) {
        try {
          await rm(path.join(job.destDir, old), { force: true })
          pruned.push(old)
        } catch {
          // One that cannot go now goes with a later run.
        }
      }
    }
    return {
      file: name,
      path: final,
      bytes,
      files: files.length,
      durationMs: now().getTime() - started.getTime(),
      pruned,
    }
  } catch (error) {
    await zip?.abort()
    await rm(partial, { force: true }).catch(() => {})
    throw failure(error, job.destDir)
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}
