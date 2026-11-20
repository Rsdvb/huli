// Huli: the manifest each backup carries as `manifest.json`: what made it and when, and every file
// with its size and SHA-256, which a restore checks before it touches the data folder.

import { isEntryName, type ZipEntry } from './zip'
import { partOf, type Part } from './plan'

export const MANIFEST_NAME = 'manifest.json'
export const MANIFEST_FORMAT = 'kite-backup'
export const MANIFEST_VERSION = 1
/** The most a manifest may weigh: far more than a data folder's file list needs. */
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024

const SHA256 = /^[0-9a-f]{64}$/
const MAX_FILES = 1_000_000

export interface ManifestFile {
  path: string
  size: number
  sha256: string
  part: Part
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT
  version: typeof MANIFEST_VERSION
  /** The version of the app that made it. */
  app: string
  /** When it was made, as an ISO time. */
  created: string
  platform: string
  /** What was left out and why, for whoever reads the file. */
  leftOut: string[]
  files: ManifestFile[]
}

export function buildManifest(input: {
  app: string
  created: Date
  platform: string
  leftOut: readonly string[]
  files: readonly ManifestFile[]
}): Manifest {
  return {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    app: input.app,
    created: input.created.toISOString(),
    platform: input.platform,
    leftOut: [...input.leftOut],
    files: [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

const PARTS: readonly Part[] = ['file', 'database', 'content']

/** A manifest read from a backup, checked; a string says what is wrong with it. */
export function parseManifest(raw: unknown): Manifest | string {
  if (!isRecord(raw)) return 'The manifest is not an object'
  if (raw.format !== MANIFEST_FORMAT) return 'Not a Kite backup'
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version)) {
    return 'The manifest has no version'
  }
  if (raw.version > MANIFEST_VERSION) return 'The backup is from a newer version of Kite'
  if (raw.version !== MANIFEST_VERSION) return 'The manifest version is not known'
  if (typeof raw.app !== 'string' || raw.app.length > 100) return 'The manifest names no app'
  if (typeof raw.created !== 'string' || Number.isNaN(Date.parse(raw.created))) {
    return 'The manifest has no creation time'
  }
  if (typeof raw.platform !== 'string' || raw.platform.length > 40) {
    return 'The manifest names no platform'
  }
  const leftOut = Array.isArray(raw.leftOut)
    ? raw.leftOut.filter((line): line is string => typeof line === 'string').slice(0, 100)
    : []
  if (!Array.isArray(raw.files) || raw.files.length > MAX_FILES) {
    return 'The manifest lists no files'
  }
  const seen = new Set<string>()
  const files: ManifestFile[] = []
  for (const file of raw.files) {
    if (!isRecord(file)) return 'A file in the manifest is not an object'
    const { path, size, sha256, part } = file
    if (typeof path !== 'string' || !isEntryName(path) || path === MANIFEST_NAME) {
      return 'The manifest lists a path a backup may not hold'
    }
    if (!isSize(size) || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
      return `The manifest's record of ${path} is damaged`
    }
    if (!PARTS.includes(part as Part) || partOf(path) !== part) {
      return `A backup may not hold ${path}`
    }
    if (seen.has(path)) return `The manifest lists ${path} twice`
    seen.add(path)
    files.push({ path, size, sha256, part: part as Part })
  }
  return {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    app: raw.app,
    created: raw.created,
    platform: raw.platform,
    leftOut,
    files,
  }
}

/**
 * Whether the zip holds exactly what the manifest lists, at the sizes it lists; null when it
 * does, else what is wrong. The contents' hashes are checked as a restore reads them.
 */
export function checkEntries(
  manifest: Manifest,
  entries: readonly Pick<ZipEntry, 'name' | 'size'>[],
): string | null {
  const byName = new Map<string, number>()
  for (const entry of entries) {
    if (byName.has(entry.name)) return `The backup holds ${entry.name} twice`
    byName.set(entry.name, entry.size)
  }
  for (const file of manifest.files) {
    const size = byName.get(file.path)
    if (size === undefined) return `The backup is missing ${file.path}`
    if (size !== file.size) return `${file.path} in the backup is not the size the manifest says`
    byName.delete(file.path)
  }
  byName.delete(MANIFEST_NAME)
  const extra = byName.keys().next()
  return extra.done ? null : `The backup holds ${extra.value}, which its manifest does not list`
}

/** The bytes the manifest's files hold together. */
export function manifestBytes(manifest: Manifest): number {
  return manifest.files.reduce((sum, file) => sum + file.size, 0)
}
