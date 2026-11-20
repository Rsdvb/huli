// Huli: restoring a backup into the data folder, run in the backup's utility process while the
// hosts are stopped. The backup is read whole into a folder beside the data and each file checked
// against the manifest's SHA-256 first; then a safety copy of the data in place is made as a
// backup of its own; only then are the files the backup covers swapped, by renames on the same
// volume, and moved back if a rename fails.

import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  checkEntries,
  manifestBytes,
  MANIFEST_NAME,
  MAX_MANIFEST_BYTES,
  parseManifest,
  type Manifest,
} from './manifest'
import { SAFETY_PREFIX } from './names'
import { keptRoots, restorePlan } from './plan'
import { BackupFailure, runBackup, type BackupDone, type BackupJob } from './run'
import { ZipReader, type ZipEntry } from './zip'

export interface Inspected {
  manifest: Manifest
  files: number
  bytes: number
}

/** The backup's manifest, checked against the zip's listing; fails when it is no backup. */
export async function inspectBackup(file: string): Promise<Inspected> {
  let zip: ZipReader
  try {
    zip = await ZipReader.open(file)
  } catch (error) {
    throw new BackupFailure('failed', `Not a backup Kite can read: ${(error as Error).message}`)
  }
  try {
    const entry = zip.find(MANIFEST_NAME)
    if (!entry) throw new BackupFailure('failed', 'The file has no Kite backup manifest')
    let raw: unknown
    try {
      raw = JSON.parse((await zip.read(entry, MAX_MANIFEST_BYTES)).toString('utf8'))
    } catch (error) {
      throw new BackupFailure('failed', `The manifest cannot be read: ${(error as Error).message}`)
    }
    const manifest = parseManifest(raw)
    if (typeof manifest === 'string') throw new BackupFailure('failed', manifest)
    const problem = checkEntries(manifest, zip.entries)
    if (problem) throw new BackupFailure('failed', problem)
    return { manifest, files: manifest.files.length, bytes: manifestBytes(manifest) }
  } finally {
    await zip.close()
  }
}

/** Writes the entry to `target`, failing unless its bytes hash to `sha256`. */
async function extract(zip: ZipReader, entry: ZipEntry, target: string, sha256: string) {
  await mkdir(path.dirname(target), { recursive: true })
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk)
      done(null, chunk)
    },
  })
  await pipeline(await zip.stream(entry), tap, createWriteStream(target))
  if (hash.digest('hex') !== sha256) {
    throw new BackupFailure('failed', `${entry.name} in the backup does not match its manifest`)
  }
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** A rename, tried again while Windows holds the file for a moment, as a scanner does. */
async function move(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true })
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!RETRYABLE.has(code) || attempt >= 8) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

async function listFiles(root: string, folder: string, into: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(path.join(root, folder), { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw error
  }
  for (const entry of entries) {
    const relative = `${folder}/${entry.name}`
    if (entry.isDirectory()) await listFiles(root, relative, into)
    else into.push(relative)
  }
}

/** The files at the data folder's top and under the folders a backup keeps. */
async function currentFiles(dataDir: string): Promise<string[]> {
  const { files, folders } = keptRoots()
  const names = await readdir(dataDir)
  const found = files.filter((name) => names.includes(name))
  for (const folder of folders) await listFiles(dataDir, folder, found)
  return found
}

/** Removes the folders a restore emptied, deepest first, keeping the kept roots themselves. */
async function pruneEmpty(dataDir: string, folder: string): Promise<boolean> {
  let entries
  try {
    entries = await readdir(path.join(dataDir, folder), { withFileTypes: true })
  } catch {
    return false
  }
  let empty = true
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      empty = false
      continue
    }
    if (!(await pruneEmpty(dataDir, `${folder}/${entry.name}`))) empty = false
  }
  if (empty && folder.includes('/')) {
    await rmdir(path.join(dataDir, folder)).catch(() => {})
    return true
  }
  return false
}

export interface RestoreJob {
  file: string
  dataDir: string
  /** Where the safety copy of the data in place goes, as a backup does. */
  safety: Omit<BackupJob, 'dataDir' | 'prefix' | 'keep' | 'progress'>
  progress?: (phase: 'check' | 'safety' | 'swap', done: number, total: number) => void
}

export interface RestoreDone {
  manifest: Manifest
  safety: BackupDone
}

export async function restoreBackup(job: RestoreJob): Promise<RestoreDone> {
  const { manifest } = await inspectBackup(job.file)
  const stamp = `${Date.now()}-${randomBytes(4).toString('hex')}`
  const staging = path.join(job.dataDir, `.restore-staging-${stamp}`)
  const aside = path.join(job.dataDir, `.restore-aside-${stamp}`)
  const total = manifestBytes(manifest)
  // Set when a file that went aside could not come back, so the folder holding it stays.
  let keepAside = false
  try {
    // Every byte is checked before anything in the data folder changes.
    const zip = await ZipReader.open(job.file)
    try {
      let done = 0
      for (const file of manifest.files) {
        const entry = zip.find(file.path)!
        await extract(zip, entry, path.join(staging, ...file.path.split('/')), file.sha256)
        done += file.size
        job.progress?.('check', done, total)
      }
    } finally {
      await zip.close()
    }

    const safety = await runBackup({
      ...job.safety,
      dataDir: job.dataDir,
      prefix: SAFETY_PREFIX,
      keep: 0,
      progress: (done, all) => job.progress?.('safety', done, all),
    })

    const plan = restorePlan(
      await currentFiles(job.dataDir),
      manifest.files.map((file) => file.path),
    )
    const movedAside: string[] = []
    const placed: string[] = []
    const local = (root: string, relative: string): string =>
      path.join(root, ...relative.split('/'))
    try {
      for (const relative of plan.replace) {
        await move(local(job.dataDir, relative), local(aside, relative))
        movedAside.push(relative)
      }
      for (const relative of plan.place) {
        await move(local(staging, relative), local(job.dataDir, relative))
        placed.push(relative)
        job.progress?.('swap', placed.length, plan.place.length)
      }
    } catch (error) {
      // Back as it was: what came in goes back to the staging folder, what went aside returns.
      for (const relative of placed.reverse()) {
        await move(local(job.dataDir, relative), local(staging, relative)).catch(() => {})
      }
      for (const relative of movedAside.reverse()) {
        await move(local(aside, relative), local(job.dataDir, relative)).catch(() => {
          keepAside = true
        })
      }
      const reason = (error as Error).message
      throw new BackupFailure(
        'failed',
        keepAside
          ? `The restore could not put the files in place, and some of the data stayed in ${aside}: ${reason}`
          : `The restore could not put the files in place, and left the data as it was: ${reason}`,
      )
    }
    for (const relative of plan.drop) {
      await rm(local(job.dataDir, relative), { recursive: true, force: true }).catch(() => {})
    }
    for (const folder of keptRoots().folders) await pruneEmpty(job.dataDir, folder)
    return { manifest, safety }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    if (!keepAside) await rm(aside, { recursive: true, force: true }).catch(() => {})
  }
}
