// Huli: downloads the pinned Moli release into Kite's data folder, `<userData>/runtimes/moli/
// <version>/`, only once the user turned background web reading on. The archive streams into a
// partial folder, must match the SHA-256 pinned in release.ts, is extracted with the system's tar,
// must say its version, and is renamed into place last, so a version folder is whole or absent.
// Huli's own; see tools/huli/README.md (Background web reading).

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { MOLI_VERSION } from '@shared/web-reader'
import { renameWithRetry } from '../adapter-install'
import { isExecutableFile } from '../find-command'
import { t } from '../i18n'
import { extractArchive } from '../node-runtime/install'
import { HttpStatusError, type Transport } from '../node-runtime/transport'
import { withoutElectronVars } from '../shell-env'
import { archiveFolder, archiveName, moliProgram, releaseUrl, type MoliAsset } from './release'

/** The record each install holds; a folder without it is no install. */
export const RECORD_FILE = 'kite-moli.json'
const PARTIAL_PREFIX = '.partial-'
const TRASH_PREFIX = '.trash-'
const VERSION_DIR = /^\d+\.\d+\.\d+$/
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000
/** A download that receives nothing for this long has stalled. */
const STALL_MS = 30_000
const CHECK_TIMEOUT_MS = 30_000

export interface MoliInstall {
  version: string
  dir: string
  program: string
  /** The space the folder takes, counted once at the install. */
  bytes: number
}

interface InstallRecord {
  version: string
  sha256: string
  bytes: number
  installedAt: number
}

export type MoliPhase = 'downloading' | 'verifying' | 'extracting'

export interface MoliInstallOptions {
  /** `<userData>/runtimes/moli`. */
  root: string
  platform: Platform
  asset: MoliAsset
  transport: Transport
  signal?: AbortSignal
  onProgress?(phase: MoliPhase, progress: number | null): void
  /** Tests stand in for the release's address, the system's tar and running the program. */
  url?: string
  extract?(archive: string, dest: string, format: MoliAsset['format']): Promise<void>
  version?(program: string): Promise<string | null>
}

export function moliRoot(userDataPath: string): string {
  return path.join(userDataPath, 'runtimes', 'moli')
}

function isRecord(value: unknown): value is InstallRecord {
  const r = value as InstallRecord | null
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.version === 'string' &&
    typeof r.sha256 === 'string' &&
    typeof r.bytes === 'number' &&
    typeof r.installedAt === 'number'
  )
}

async function readRecord(dir: string): Promise<InstallRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dir, RECORD_FILE), 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The pinned version's install, or null; a folder without its record or its program is none. */
export async function findMoli(root: string, platform: Platform): Promise<MoliInstall | null> {
  const dir = path.join(root, MOLI_VERSION)
  const record = await readRecord(dir)
  if (record?.version !== MOLI_VERSION) return null
  const program = moliProgram(dir, platform)
  if (!(await isExecutableFile(program, platform))) return null
  return { version: record.version, dir, program, bytes: record.bytes }
}

/** The bytes of every file under `dir`. */
async function folderBytes(dir: string): Promise<number> {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await folderBytes(full)
    else if (entry.isFile()) total += (await stat(full).catch(() => null))?.size ?? 0
  }
  return total
}

/**
 * Moves a folder out of the way, then deletes it. On Windows a folder whose program still runs
 * cannot be moved, so it stays whole and false says so.
 */
async function discard(root: string, dir: string, platform: Platform): Promise<boolean> {
  const trash = path.join(root, `${TRASH_PREFIX}${randomBytes(6).toString('hex')}`)
  try {
    await renameWithRetry(dir, trash, platform)
  } catch {
    return false
  }
  await rm(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  return true
}

/** What an earlier run left: folders moved out to delete, partials, and other versions. */
export async function removeLeftovers(root: string, platform: Platform): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[])
  await Promise.all(
    names.map(async (name) => {
      const full = path.join(root, name)
      if (name.startsWith(TRASH_PREFIX) || name.startsWith(PARTIAL_PREFIX)) {
        await rm(full, { recursive: true, force: true }).catch(() => {})
      } else if (VERSION_DIR.test(name) && name !== MOLI_VERSION) {
        await discard(root, full, platform)
      }
    }),
  )
}

/** Deletes every install; throws, keeping it whole, while a read still runs it. */
export async function removeMoli(root: string, platform: Platform): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[])
  let busy = false
  for (const name of names.filter((n) => VERSION_DIR.test(n))) {
    if (!(await discard(root, path.join(root, name), platform))) busy = true
  }
  if (busy) throw new Error(t('webReader.inUse'))
}

function versionOf(program: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      program,
      ['--version'],
      {
        timeout: CHECK_TIMEOUT_MS,
        windowsHide: true,
        env: withoutElectronVars(process.env, process.platform as Platform) as NodeJS.ProcessEnv,
      },
      (error, stdout) => {
        if (error) resolve(null)
        else resolve(/^moli (\S+)/.exec(String(stdout).trim())?.[1] ?? null)
      },
    )
  })
}

async function download(
  options: MoliInstallOptions,
  file: string,
  signal: AbortSignal,
): Promise<{ sha256: string; bytes: number }> {
  const stall = new AbortController()
  let timer = setTimeout(() => stall.abort(), STALL_MS)
  let shown = -1
  try {
    return await options.transport.file(options.url ?? releaseUrl(options.asset), file, {
      signal: AbortSignal.any([signal, stall.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
      onBytes: (received, total) => {
        clearTimeout(timer)
        timer = setTimeout(() => stall.abort(), STALL_MS)
        const expected = total ?? options.asset.bytes
        const percent = Math.floor(Math.min(1, received / expected) * 100)
        if (percent === shown) return
        shown = percent
        options.onProgress?.('downloading', percent / 100)
      },
    })
  } catch (error) {
    if (signal.aborted) throw new Error(t('webReader.stopped'), { cause: error })
    const reason =
      error instanceof HttpStatusError
        ? error.message
        : stall.signal.aborted
          ? t('webReader.stalled')
          : (error as Error).message
    throw new Error(t('webReader.downloadFailed', { reason }), { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Downloads, checks and installs the pinned release, unless it is installed already. A failed or
 * stopped install, and an archive whose hash or size differs from the pinned one, leave nothing
 * behind.
 */
export async function installMoli(options: MoliInstallOptions): Promise<MoliInstall> {
  const { root, platform, asset } = options
  const signal = options.signal ?? new AbortController().signal
  const stopped = (): void => {
    if (signal.aborted) throw new Error(t('webReader.stopped'))
  }
  await mkdir(root, { recursive: true })
  await removeLeftovers(root, platform)
  const existing = await findMoli(root, platform)
  if (existing) return existing
  const partial = path.join(root, `${PARTIAL_PREFIX}${randomBytes(6).toString('hex')}`)
  await mkdir(partial)
  try {
    const archive = path.join(partial, archiveName(asset))
    options.onProgress?.('downloading', 0)
    const downloaded = await download(options, archive, signal)
    stopped()
    options.onProgress?.('verifying', null)
    if (downloaded.sha256 !== asset.sha256 || downloaded.bytes !== asset.bytes) {
      throw new Error(t('webReader.hashMismatch', { file: archiveName(asset) }))
    }
    options.onProgress?.('extracting', null)
    try {
      await (options.extract ?? ((a, d, f) => extractArchive(a, d, f, platform)))(
        archive,
        partial,
        asset.format,
      )
    } catch (error) {
      throw new Error(t('webReader.extractFailed', { reason: (error as Error).message }), {
        cause: error,
      })
    }
    await rm(archive, { force: true })
    stopped()
    const inner = path.join(partial, archiveFolder(asset))
    const program = moliProgram(inner, platform)
    const found = await (options.version ?? versionOf)(program)
    if (found !== MOLI_VERSION) throw new Error(t('webReader.doesNotRun'))
    const record: InstallRecord = {
      version: MOLI_VERSION,
      sha256: downloaded.sha256,
      bytes: await folderBytes(inner),
      installedAt: Date.now(),
    }
    await writeFile(path.join(inner, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`)
    const target = path.join(root, MOLI_VERSION)
    if (await stat(target).catch(() => null)) {
      // A folder of this version without a whole install, such as one a crash left.
      if (!(await discard(root, target, platform))) throw new Error(t('webReader.inUse'))
    }
    await renameWithRetry(inner, target, platform)
    await rm(partial, { recursive: true, force: true }).catch(() => {})
    const install = await findMoli(root, platform)
    if (!install) throw new Error(t('webReader.doesNotRun'))
    return install
  } catch (error) {
    await rm(partial, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    )
    throw error
  }
}
