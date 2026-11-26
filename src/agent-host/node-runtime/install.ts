// Huli: installs the official Node.js build into Kite's data folder, `<userData>/runtimes/node/
// <version>/`, with no administrator rights, package manager or change to the user's PATH. The
// archive is downloaded into a partial folder, checked against SHA256SUMS, extracted with the
// system's tar and renamed into place last, so a version folder is whole or absent. Huli's own;
// see tools/huli/README.md (Kite's own Node.js).

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { renameWithRetry } from '../adapter-install'
import { deleteLater, discard as discardFolder, TRASH_PREFIX } from '../discard'
import { isExecutableFile } from '../find-command'
import { t } from '../i18n'
import { withoutElectronVars } from '../shell-env'
import {
  archiveFile,
  archiveFolder,
  compareNodeVersions,
  indexUrl,
  MIRROR_SOURCE,
  NODE_VERSION,
  OFFICIAL_SOURCE,
  parseShasums,
  pickRelease,
  releaseUrl,
  type NodeAsset,
  type NodeSource,
} from './release'
import { HttpStatusError, type Transport } from './transport'

/** The record each install holds; a folder without it is no install. */
export const RECORD_FILE = 'kite-node.json'
const PARTIAL_PREFIX = '.partial-'
/** The newest installs kept: the one agents use, and the one before it while it may still run. */
export const KEEP_VERSIONS = 2

/** How long nodejs.org has to answer before the mirror races it. */
export const HEAD_START_MS = 3_000
const INDEX_TIMEOUT_MS = 20_000
const SHASUMS_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000
/** A download that receives nothing for this long has stalled. */
const STALL_MS = 30_000
const CHECK_TIMEOUT_MS = 30_000
const EXTRACT_TIMEOUT_MS = 5 * 60_000
const MIB = 1024 * 1024

export interface NodeInstall {
  version: string
  dir: string
  binDir: string
  installedAt: number
  source: string
}

interface InstallRecord {
  version: string
  file: string
  sha256: string
  source: string
  /** Where SHASUMS256.txt came from: nodejs.org, or the mirror when nodejs.org did not answer. */
  checkedWith: string
  installedAt: number
}

export type InstallPhase = 'checking' | 'downloading' | 'verifying' | 'extracting'

export interface InstallProgress {
  phase: InstallPhase
  progress: number | null
  version: string | null
  source: string | null
}

export interface NodeInstallOptions {
  /** `<userData>/runtimes/node`. */
  root: string
  platform: Platform
  asset: NodeAsset
  required: string | null
  transport: Transport
  signal?: AbortSignal
  onProgress?(progress: InstallProgress): void
  log?(level: 'info' | 'warn', message: string): void
  /** Tests stand in for the system's tar and for running the new node. */
  extract?(archive: string, dest: string, format: NodeAsset['format']): Promise<void>
  version?(program: string): Promise<string | null>
  headStartMs?: number
}

export interface NodeInstallResult {
  install: NodeInstall
  /** False when that version was installed already. */
  installed: boolean
  source: string
}

export function binDirOf(dir: string, platform: Platform): string {
  return platform === 'win32' ? dir : path.posix.join(dir, 'bin')
}

export function nodeProgram(dir: string, platform: Platform): string {
  return platform === 'win32'
    ? path.win32.join(dir, 'node.exe')
    : path.posix.join(dir, 'bin', 'node')
}

function isRecord(value: unknown): value is InstallRecord {
  const r = value as InstallRecord | null
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.version === 'string' &&
    typeof r.source === 'string' &&
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

/** Kite's installs, newest first; a folder without its record or its node is none. */
export async function listNodeInstalls(root: string, platform: Platform): Promise<NodeInstall[]> {
  const names = await readdir(root).catch(() => [] as string[])
  const found = await Promise.all(
    names
      .filter((name) => NODE_VERSION.test(name))
      .map(async (name): Promise<NodeInstall | null> => {
        const dir = path.join(root, name)
        const record = await readRecord(dir)
        if (record?.version !== name) return null
        if (!(await isExecutableFile(nodeProgram(dir, platform), platform))) return null
        return {
          version: name,
          dir,
          binDir: binDirOf(dir, platform),
          installedAt: record.installedAt,
          source: record.source,
        }
      }),
  )
  return found
    .filter((install) => install !== null)
    .sort((a, b) => compareNodeVersions(b.version, a.version))
}

/**
 * Moves a folder out of the way at once and deletes it in the background. On Windows a folder
 * whose program still runs cannot be moved, so it stays whole and false says so.
 */
async function discard(root: string, dir: string, platform: Platform): Promise<boolean> {
  return discardFolder(dir, { platform, trashRoot: root }).catch(() => false)
}

/** What an earlier run left: folders moved out to delete, and partials no install still writes. */
export async function removeLeftovers(root: string, olderThanMs = 60 * 60_000): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[])
  await Promise.all(
    names.map(async (name) => {
      const full = path.join(root, name)
      if (name.startsWith(TRASH_PREFIX)) {
        void deleteLater(full)
      } else if (name.startsWith(PARTIAL_PREFIX)) {
        const info = await stat(full).catch(() => null)
        if (info && Date.now() - info.mtimeMs > olderThanMs) {
          await rm(full, { recursive: true, force: true }).catch(() => {})
        }
      }
    }),
  )
}

/** Deletes all but the newest `keep` installs; returns the versions removed. */
export async function pruneNodeInstalls(
  root: string,
  platform: Platform,
  keep = KEEP_VERSIONS,
): Promise<string[]> {
  const stale = (await listNodeInstalls(root, platform)).slice(keep)
  const removed: string[] = []
  for (const install of stale) {
    if (await discard(root, install.dir, platform)) removed.push(install.version)
  }
  return removed
}

/** Deletes every install; throws, keeping the rest whole, when one is in use. */
export async function removeNodeInstalls(root: string, platform: Platform): Promise<void> {
  let busy = false
  for (const install of await listNodeInstalls(root, platform)) {
    if (!(await discard(root, install.dir, platform))) busy = true
  }
  if (busy) throw new Error(t('nodeRuntime.inUse'))
}

type Attempt = { source: NodeSource; index: unknown } | { source: NodeSource; error: Error }

function sleep(ms: number): { done: Promise<'slow'>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<'slow'>((resolve) => {
    timer = setTimeout(() => resolve('slow'), ms)
  })
  return { done, cancel: () => clearTimeout(timer) }
}

/**
 * nodejs.org's `index.json`, unless it fails or takes longer than `headStartMs`: then the mirror
 * races it, and whichever answers first is where the archive comes from.
 */
export async function pickSource(
  transport: Transport,
  signal: AbortSignal,
  headStartMs = HEAD_START_MS,
): Promise<{ source: NodeSource; index: unknown }> {
  const controllers = new Map<NodeSource, AbortController>()
  const attempt = (source: NodeSource): Promise<Attempt> => {
    const controller = new AbortController()
    controllers.set(source, controller)
    const own = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(INDEX_TIMEOUT_MS)])
    return transport.text(indexUrl(source), { signal: own, maxBytes: 16 * MIB }).then(
      (text) => ({ source, index: JSON.parse(text) as unknown }),
      (error: unknown) => ({ source, error: error as Error }),
    )
  }
  const official = attempt(OFFICIAL_SOURCE)
  const wait = sleep(headStartMs)
  const early = await Promise.race([official, wait.done])
  wait.cancel()
  if (early !== 'slow' && 'index' in early) return early
  const mirror = attempt(MIRROR_SOURCE)
  const pending = new Set([official, mirror])
  const failures: Attempt[] = []
  while (pending.size > 0) {
    const next = await Promise.race([...pending].map((p) => p.then((result) => ({ p, result }))))
    pending.delete(next.p)
    if ('index' in next.result) {
      for (const [source, controller] of controllers) {
        if (source !== next.result.source) controller.abort()
      }
      return next.result
    }
    failures.push(next.result)
  }
  if (signal.aborted) throw new Error(t('nodeRuntime.stopped'))
  const reason = failures.map((f) => `${f.source.id}: ${reasonOf(f)}`).join('; ')
  throw new Error(t('nodeRuntime.unreachable', { reason }))
}

function reasonOf(attempt: Attempt): string {
  return 'error' in attempt ? attempt.error.message : ''
}

/**
 * The archive's SHA-256 from nodejs.org's SHASUMS256.txt. When nodejs.org cannot be reached it is
 * read from the mirror instead: a weaker trust path, since the mirror then vouches for its own
 * archive, kept so users who cannot reach nodejs.org can still install.
 */
async function expectedHash(
  transport: Transport,
  version: string,
  file: string,
  signal: AbortSignal,
  log: NodeInstallOptions['log'],
): Promise<{ sha256: string; from: NodeSource }> {
  let lastError: Error | null = null
  for (const source of [OFFICIAL_SOURCE, MIRROR_SOURCE]) {
    try {
      const text = await transport.text(releaseUrl(source, version, 'SHASUMS256.txt'), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(SHASUMS_TIMEOUT_MS)]),
        maxBytes: MIB,
      })
      const sha256 = parseShasums(text, file)
      if (!sha256) throw new Error(t('nodeRuntime.noChecksum', { file }))
      if (source !== OFFICIAL_SOURCE) {
        log?.(
          'warn',
          `Node.js ${version}: nodejs.org gave no SHASUMS256.txt, checked by the mirror's`,
        )
      }
      return { sha256, from: source }
    } catch (error) {
      if (signal.aborted) throw new Error(t('nodeRuntime.stopped'), { cause: error })
      lastError = error as Error
    }
  }
  throw lastError ?? new Error(t('nodeRuntime.noChecksum', { file }))
}

/** The download, with a stall and an overall limit; null and the error when it failed. */
async function download(
  options: NodeInstallOptions,
  url: string,
  file: string,
  onBytes: (received: number, total: number | null) => void,
): Promise<{ sha256: string } | { error: Error }> {
  const stall = new AbortController()
  let timer = setTimeout(() => stall.abort(), STALL_MS)
  const signals = [stall.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]
  if (options.signal) signals.push(options.signal)
  try {
    const result = await options.transport.file(url, file, {
      signal: AbortSignal.any(signals),
      onBytes: (received, total) => {
        clearTimeout(timer)
        timer = setTimeout(() => stall.abort(), STALL_MS)
        onBytes(received, total)
      },
    })
    return { sha256: result.sha256 }
  } catch (error) {
    if (options.signal?.aborted) throw new Error(t('nodeRuntime.stopped'), { cause: error })
    const reason =
      error instanceof HttpStatusError
        ? error.message
        : stall.signal.aborted
          ? t('nodeRuntime.stalled')
          : (error as Error).message
    return { error: new Error(reason) }
  } finally {
    clearTimeout(timer)
  }
}

function run(program: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      {
        timeout,
        windowsHide: true,
        maxBuffer: 4 * MIB,
        env: withoutElectronVars(process.env, process.platform as Platform) as NodeJS.ProcessEnv,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim().split(/\r?\n/).slice(-2).join(' ')
          reject(new Error(detail || error.message))
        } else resolve(String(stdout))
      },
    )
  })
}

/**
 * The system's own tar: Windows 10's bsdtar in System32, which reads .zip too (Git's GNU tar on
 * PATH reads no .zip and takes `C:` for a host), or `/usr/bin/tar` and `/bin/tar` elsewhere.
 */
async function systemTar(platform: Platform): Promise<string | null> {
  const candidates =
    platform === 'win32'
      ? [process.env.SystemRoot, process.env.windir, 'C:\\Windows']
          .filter((root): root is string => !!root && path.win32.isAbsolute(root))
          .map((root) => path.win32.join(root, 'System32', 'tar.exe'))
      : ['/usr/bin/tar', '/bin/tar']
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate, platform)) return candidate
  }
  return null
}

type Decompress = (input: string, output: string) => Promise<unknown>

/** Every argument is a path Kite made, passed without a shell. */
export async function extractArchive(
  archive: string,
  dest: string,
  format: NodeAsset['format'],
  platform: Platform,
): Promise<void> {
  const tar = await systemTar(platform)
  if (tar) {
    await run(tar, [format === 'zip' ? '-xf' : '-xzf', archive, '-C', dest], EXTRACT_TIMEOUT_MS)
    return
  }
  // Without a system tar, the extractor harness installs use; it stays outside the bundle.
  const module = (await import('decompress')) as unknown as { default?: Decompress }
  const decompress = module.default ?? (module as unknown as Decompress)
  await decompress(archive, dest)
}

async function versionOf(program: string): Promise<string | null> {
  try {
    return (await run(program, ['--version'], CHECK_TIMEOUT_MS)).trim() || null
  } catch {
    return null
  }
}

/**
 * Installs the newest LTS release that meets `required`, unless it is installed already, then
 * deletes all but the newest `KEEP_VERSIONS`. A failed or stopped install leaves nothing behind.
 */
export async function installNode(options: NodeInstallOptions): Promise<NodeInstallResult> {
  const { root, platform, asset, transport } = options
  const signal = options.signal ?? new AbortController().signal
  const report = (progress: InstallProgress): void => options.onProgress?.(progress)
  const stopped = (): void => {
    if (signal.aborted) throw new Error(t('nodeRuntime.stopped'))
  }
  await mkdir(root, { recursive: true })
  await removeLeftovers(root)
  report({ phase: 'checking', progress: null, version: null, source: null })
  const picked = await pickSource(transport, signal, options.headStartMs)
  stopped()
  const version = pickRelease(picked.index, asset, options.required)
  if (!version) {
    throw new Error(t('nodeRuntime.noRelease', { required: options.required ?? '' }))
  }
  const existing = (await listNodeInstalls(root, platform)).find((i) => i.version === version)
  if (existing) return { install: existing, installed: false, source: picked.source.id }
  const file = archiveFile(version, asset)
  report({ phase: 'checking', progress: null, version, source: picked.source.id })
  const expected = await expectedHash(transport, version, file, signal, options.log)
  stopped()

  const partial = path.join(root, `${PARTIAL_PREFIX}${randomBytes(6).toString('hex')}`)
  await mkdir(partial)
  try {
    const archive = path.join(partial, file)
    // The mirror wins the race only when nodejs.org was slow; a failed download tries the other.
    const order =
      picked.source === OFFICIAL_SOURCE
        ? [OFFICIAL_SOURCE, MIRROR_SOURCE]
        : [MIRROR_SOURCE, OFFICIAL_SOURCE]
    let downloaded: { sha256: string; source: NodeSource } | null = null
    const failures: string[] = []
    for (const source of order) {
      let shown = -1
      report({ phase: 'downloading', progress: 0, version, source: source.id })
      const result = await download(
        options,
        releaseUrl(source, version, file),
        archive,
        (received, total) => {
          const progress = total ? Math.min(1, received / total) : null
          const percent = progress === null ? -1 : Math.floor(progress * 100)
          if (percent === shown && progress !== null) return
          shown = percent
          report({ phase: 'downloading', progress, version, source: source.id })
        },
      )
      if ('sha256' in result) {
        downloaded = { sha256: result.sha256, source }
        break
      }
      failures.push(`${source.id}: ${result.error.message}`)
      options.log?.('warn', `Node.js ${version} from ${source.id}: ${result.error.message}`)
      await rm(archive, { force: true }).catch(() => {})
    }
    if (!downloaded) {
      throw new Error(t('nodeRuntime.downloadFailed', { reason: failures.join('; ') }))
    }
    stopped()
    report({ phase: 'verifying', progress: null, version, source: downloaded.source.id })
    if (downloaded.sha256 !== expected.sha256) {
      throw new Error(t('nodeRuntime.hashMismatch', { file }))
    }
    report({ phase: 'extracting', progress: null, version, source: downloaded.source.id })
    try {
      await (options.extract ?? ((a, d, f) => extractArchive(a, d, f, platform)))(
        archive,
        partial,
        asset.format,
      )
    } catch (error) {
      throw new Error(t('nodeRuntime.extractFailed', { reason: (error as Error).message }), {
        cause: error,
      })
    }
    await rm(archive, { force: true })
    stopped()
    const inner = path.join(partial, archiveFolder(version, asset))
    const found = await (options.version ?? versionOf)(nodeProgram(inner, platform))
    if (found !== version) {
      throw new Error(t('nodeRuntime.doesNotRun', { version }))
    }
    const record: InstallRecord = {
      version,
      file,
      sha256: downloaded.sha256,
      source: downloaded.source.id,
      checkedWith: expected.from.id,
      installedAt: Date.now(),
    }
    await writeFile(path.join(inner, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`)
    const target = path.join(root, version)
    if (await stat(target).catch(() => null)) {
      // A folder of this version without a whole install, such as one a crash left.
      if (!(await discard(root, target, platform))) throw new Error(t('nodeRuntime.inUse'))
    }
    await renameWithRetry(inner, target, platform)
    await rm(partial, { recursive: true, force: true }).catch(() => {})
    const install = (await listNodeInstalls(root, platform)).find((i) => i.version === version)
    if (!install) throw new Error(t('nodeRuntime.doesNotRun', { version }))
    await pruneNodeInstalls(root, platform)
    return { install, installed: true, source: downloaded.source.id }
  } catch (error) {
    await rm(partial, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {},
    )
    throw error
  }
}
