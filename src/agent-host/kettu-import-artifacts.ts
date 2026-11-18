// Huli: an official Kettu's artifacts brought over, each with its title and every version, in the
// same project. Their records live in Kettu's thread database, which is copied out of its data
// folder and read from the copy in the thread worker; their files are read from Kettu's content
// folder, which nothing ever rewrites, and kept only when their bytes match their hashes. What
// Kettu published, its sharing links, belongs to Kettu's account and stays. Huli's own; see
// tools/huli/README.md.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, readFile, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  RUNTIME_VERSIONS,
  parseDeclaration,
  type DeclaredCapability,
} from '@shared/artifact-capabilities'
import {
  ARTIFACT_ENTRY,
  DISK_FILE_BYTES,
  VERSION_BYTES,
  VERSION_FILES,
  artifactPathProblem,
  caseClash,
} from '@shared/artifact-files'
import { ARTIFACT_TITLE_CHARS, NO_SESSION } from '@shared/artifacts'
import { CURRENT_FORMATS, isArtifactTypeName, type ArtifactTypeInfo } from '@shared/artifact-types'
import { CANVAS_FILE } from '@shared/canvas-doc'
import type { KettuArtifactsResult } from '@shared/kettu-import'
import type { Platform } from '@shared/platform'
import { contentPath, versionKey } from './artifacts/content'
import { newArtifactId } from './artifacts/ids'
import type { ArtifactCallName, ArtifactCalls } from './artifacts/model'
import { isAbsolutePath, isInside } from './paths'
import type { KettuArtifactRow } from './threads/kettu-artifacts'

/** Kept free on the disk beside the copy of Kettu's database. */
const SPARE_BYTES = 256 * 1024 * 1024
const ARTIFACT_ID = /^art_[0-9A-HJKMNP-TV-Z]{26}$/
const HASH = /^[0-9a-f]{64}$/
const NOTE_CHARS = 2_000
const AUTHOR_CHARS = 200

/** The thread worker's artifact calls, which the import makes on this app's database. */
export interface ArtifactCaller {
  artifact<K extends ArtifactCallName>(
    name: K,
    params: ArtifactCalls[K]['params'],
  ): Promise<ArtifactCalls[K]['result']>
}

export interface KettuVersion {
  version: number
  pages: number
  author: string | null
  note: string | null
  createdAt: number
  files: { path: string; hash: string; size: number }[]
  capabilities: DeclaredCapability[]
  runtime: number
}

/** An artifact of Kettu's whose records passed the checks. */
export interface KettuArtifact {
  id: string
  project: string
  title: string
  sessionId: string
  createdAt: number
  type: ArtifactTypeInfo | null
  /** Oldest first, numbered 1 up. */
  versions: KettuVersion[]
  /** What its latest version's thumbnail and content are known by. */
  key: string
}

export interface KettuArtifactsRead {
  artifacts: KettuArtifact[]
  /** In Kettu's Recently deleted, which is not brought over. */
  deleted: number
  /** Records that failed the checks. */
  invalid: number
  /** In a folder inside Kettu's data folder, its scratch folders. */
  scratch: number
}

/** One record of the ledger: which of Kettu's artifacts became which here. */
export interface ArtifactLedgerItem {
  kettuId: string
  artifactId: string
}

function safeTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < 2 ** 48
}

function clean(text: string): boolean {
  return !/\p{Cc}/u.test(text)
}

/** The disk lacks room for a copy of Kettu's database. */
export class NoSpaceError extends Error {}

/** The record checked as untrusted; null when it is not one this app could have written. */
export function checkKettuArtifact(row: KettuArtifactRow): KettuArtifact | null {
  const { id, project, title, sessionId, createdAt } = row
  if (!ARTIFACT_ID.test(id) || !safeTime(createdAt)) return null
  if (project === '' || project.length > 4096 || project.includes('\0')) return null
  const shown = title.replace(/\s+/g, ' ').trim()
  if (shown === '' || Array.from(shown).length > ARTIFACT_TITLE_CHARS || !clean(shown)) return null
  if (sessionId.length > AUTHOR_CHARS || !clean(sessionId)) return null
  if (row.versions.length === 0 || row.head !== row.versions.length) return null
  const first = row.versions[0]!.type
  let type: ArtifactTypeInfo | null = null
  if (first) {
    if (!isArtifactTypeName(first.name)) return null
    if (first.format < 1 || first.format > CURRENT_FORMATS[first.name]) return null
    type = { name: first.name, format: first.format }
  }
  const versions: KettuVersion[] = []
  for (const [index, version] of row.versions.entries()) {
    if (version.version !== index + 1 || !safeTime(version.createdAt)) return null
    if (version.pages < 0 || version.pages > 100_000) return null
    if (version.author !== null && (version.author.length > AUTHOR_CHARS || !clean(version.author)))
      return null
    if (version.note !== null && Array.from(version.note).length > NOTE_CHARS) return null
    // A type is the artifact's for good, as this app's writes keep it.
    if ((version.type?.name ?? null) !== (type?.name ?? null)) return null
    const { files } = version
    if (files.length === 0 || files.length > VERSION_FILES) return null
    let total = 0
    for (const file of files) {
      if (artifactPathProblem(file.path) !== null || !HASH.test(file.hash)) return null
      if (file.size < 0 || file.size > DISK_FILE_BYTES) return null
      total += file.size
    }
    if (total > VERSION_BYTES || caseClash(files.map((file) => file.path))) return null
    if (new Set(files.map((file) => file.path)).size !== files.length) return null
    if (!type && !files.some((f) => f.path === ARTIFACT_ENTRY || f.path === CANVAS_FILE)) {
      return null
    }
    let capabilities: DeclaredCapability[] = []
    let runtime = RUNTIME_VERSIONS[0]!
    if (version.declaration) {
      let parsed: ReturnType<typeof parseDeclaration>
      try {
        parsed = parseDeclaration(JSON.parse(version.declaration.capabilities))
      } catch {
        return null
      }
      if (!Array.isArray(parsed) || !RUNTIME_VERSIONS.includes(version.declaration.runtime)) {
        return null
      }
      capabilities = parsed
      runtime = version.declaration.runtime
    }
    versions.push({
      version: version.version,
      pages: version.pages,
      author: version.author,
      note: version.note,
      createdAt: version.createdAt,
      files,
      capabilities,
      runtime,
    })
  }
  return {
    id,
    project,
    title: shown,
    sessionId,
    createdAt,
    type,
    versions,
    key: versionKey(versions.at(-1)!.files),
  }
}

/** The size and time of each file, to tell whether Kettu wrote while it was copied. */
async function signature(files: readonly string[]): Promise<string> {
  const parts = await Promise.all(
    files.map(async (file) => {
      const info = await stat(file).catch(() => null)
      return info ? `${info.size}:${info.mtimeMs}` : '-'
    }),
  )
  return parts.join('|')
}

async function copyShared(from: string, to: string): Promise<void> {
  // Node's own open shares the file with Kettu's writes, so this never blocks or locks it.
  await pipeline(createReadStream(from), createWriteStream(to))
}

/**
 * Copies Kettu's thread database and its write-ahead log into `temp`; null when Kettu has none.
 * Kettu may write while it is copied, so a copy is taken again, up to three times, until the
 * files did not change during it; the reader only trusts what passes its checks either way.
 */
export async function copyKettuDatabase(source: string, temp: string): Promise<string | null> {
  const db = path.join(source, 'state', 'threads.db')
  const wal = `${db}-wal`
  const info = await lstat(db).catch(() => null)
  if (!info?.isFile()) return null
  const walSize = (await stat(wal).catch(() => null))?.size ?? 0
  const space = await statfs(temp).catch(() => null)
  if (space && space.bavail * space.bsize < info.size + walSize + SPARE_BYTES) {
    throw new NoSpaceError(`No room to copy ${db}`)
  }
  const copy = path.join(temp, 'threads.db')
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await signature([db, wal])
    await copyShared(db, copy)
    if ((await stat(wal).catch(() => null))?.isFile()) await copyShared(wal, `${copy}-wal`)
    if ((await signature([db, wal])) === before) break
  }
  return copy
}

/** Checks the rows read from the copy and sorts out what cannot come over. */
export function checkKettuArtifacts(
  read: { artifacts: KettuArtifactRow[]; deleted: number; malformed: number },
  source: string,
  platform: Platform,
): KettuArtifactsRead {
  const out: KettuArtifactsRead = {
    artifacts: [],
    deleted: read.deleted,
    invalid: read.malformed,
    scratch: 0,
  }
  const seen = new Set<string>()
  for (const row of read.artifacts) {
    const artifact = checkKettuArtifact(row)
    if (!artifact || seen.has(artifact.id) || !isAbsolutePath(artifact.project, platform)) {
      out.invalid++
    } else if (isInside(artifact.project, source, platform)) {
      out.scratch++
    } else {
      seen.add(artifact.id)
      out.artifacts.push(artifact)
    }
  }
  return out
}

/** What is here already: every artifact's id, Recently deleted's too, and its latest version's key. */
async function heldHere(threads: ArtifactCaller): Promise<Map<string, string>> {
  const listed = [
    ...(await threads.artifact('list', { project: null, deleted: false })),
    ...(await threads.artifact('list', { project: null, deleted: true })),
  ]
  const held = new Map<string, string>()
  for (const artifact of listed) {
    const found = await threads
      .artifact('get', { id: artifact.id, version: null, project: null })
      .catch(() => null)
    held.set(artifact.id, found ? versionKey(found.files) : '')
  }
  return held
}

type Plan = { kind: 'imported' | 'same' } | { kind: 'new'; id: string; renamed: boolean }

function planOf(
  artifact: KettuArtifact,
  held: Map<string, string>,
  keys: Set<string>,
  ledger: readonly ArtifactLedgerItem[],
): Plan {
  const before = ledger.find((item) => item.kettuId === artifact.id)
  if (before && held.has(before.artifactId)) return { kind: 'imported' }
  if (keys.has(artifact.key)) return { kind: 'same' }
  if (!held.has(artifact.id)) return { kind: 'new', id: artifact.id, renamed: false }
  let id = newArtifactId(artifact.createdAt)
  while (held.has(id)) id = newArtifactId(artifact.createdAt)
  return { kind: 'new', id, renamed: true }
}

/** How many of the artifacts are neither brought over before nor here already. */
export async function countNewArtifacts(
  read: KettuArtifactsRead,
  threads: ArtifactCaller,
  ledger: readonly ArtifactLedgerItem[],
): Promise<number> {
  const held = await heldHere(threads)
  const keys = new Set(held.values())
  return read.artifacts.filter((a) => planOf(a, held, keys, ledger).kind === 'new').length
}

export interface ArtifactImportDeps {
  threads: ArtifactCaller
  /** Kettu's data folder, which is only read. */
  source: string
  /** This app's session that Kettu's became when it was imported; null when it was not. */
  sessionOf(kettuId: string): string | null
  ledger: readonly ArtifactLedgerItem[]
  /** Each artifact as it starts, for the progress shown. */
  progress?(done: number, total: number, title: string): void
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** The bytes of a content file of Kettu's; null when it is missing or not what its hash says. */
async function contentOf(
  source: string,
  file: { hash: string; size: number },
): Promise<Buffer | null> {
  const where = contentPath(path.join(source, 'artifacts', 'content'), file.hash)
  const info = await lstat(where).catch(() => null)
  if (!info?.isFile() || info.size !== file.size) return null
  const data = await readFile(where).catch(() => null)
  return data && data.length === file.size && sha256(data) === file.hash ? data : null
}

/**
 * Brings the artifacts over, oldest first. One the ledger names and this app still keeps is not
 * brought again, nor one whose latest version an artifact here has; one whose id an artifact here
 * has comes under a new id. Each comes as its versions, written in turn with their times, notes,
 * authors and declarations; one whose content cannot be read is skipped whole, and one that fails
 * partway is removed again. Returns the result and what the ledger gains.
 */
export async function importKettuArtifacts(
  read: KettuArtifactsRead,
  deps: ArtifactImportDeps,
): Promise<{ result: KettuArtifactsResult; ledger: ArtifactLedgerItem[] }> {
  const { threads } = deps
  const result: KettuArtifactsResult = {
    imported: 0,
    renamed: [],
    skipped: {
      imported: 0,
      same: 0,
      invalid: read.invalid,
      missingContent: 0,
      scratch: read.scratch,
      deleted: read.deleted,
    },
    failed: [],
  }
  const ledger: ArtifactLedgerItem[] = []
  const held = await heldHere(threads)
  const keys = new Set(held.values())
  const wanted = [...read.artifacts].sort((a, b) => a.createdAt - b.createdAt)
  for (const [index, artifact] of wanted.entries()) {
    deps.progress?.(index, wanted.length, artifact.title)
    const plan = planOf(artifact, held, keys, deps.ledger)
    if (plan.kind !== 'new') {
      result.skipped[plan.kind]++
      continue
    }
    const contents = new Map<string, Buffer>()
    let missing = false
    for (const file of artifact.versions.flatMap((version) => version.files)) {
      if (contents.has(file.hash)) continue
      const data = await contentOf(deps.source, file)
      if (!data) {
        missing = true
        break
      }
      contents.set(file.hash, data)
    }
    if (missing) {
      result.skipped.missingContent++
      continue
    }
    const session = (id: string | null): string | null =>
      id === null || id === NO_SESSION ? id : (deps.sessionOf(id) ?? id)
    let made = false
    try {
      const [first, ...rest] = artifact.versions
      await threads.artifact('create', {
        id: plan.id,
        project: artifact.project,
        sessionId: session(artifact.sessionId) ?? NO_SESSION,
        title: artifact.title,
        files: first!.files.map((file) => ({ path: file.path, data: contents.get(file.hash)! })),
        pages: first!.pages,
        note: first!.note,
        at: first!.createdAt,
        declaration: { capabilities: first!.capabilities, runtime: first!.runtime },
        type: artifact.type,
      })
      made = true
      let previous = first!
      for (const version of rest) {
        const was = new Map(previous.files.map((file) => [file.path, file.hash]))
        const now = new Set(version.files.map((file) => file.path))
        await threads.artifact('write', {
          id: plan.id,
          project: null,
          baseVersion: previous.version,
          changes: [
            ...version.files
              .filter((file) => was.get(file.path) !== file.hash)
              .map((file) => ({ path: file.path, data: contents.get(file.hash)! })),
            ...previous.files
              .filter((file) => !now.has(file.path))
              .map((file) => ({ path: file.path, data: null })),
          ],
          pages: version.pages,
          author: session(version.author),
          note: version.note,
          at: Math.max(version.createdAt, previous.createdAt),
          declaration: { capabilities: version.capabilities, runtime: version.runtime },
          type: artifact.type,
        })
        previous = version
      }
      held.set(plan.id, artifact.key)
      keys.add(artifact.key)
      ledger.push({ kettuId: artifact.id, artifactId: plan.id })
      result.imported++
      if (plan.renamed) {
        result.renamed.push({ title: artifact.title, id: artifact.id, as: plan.id })
      }
    } catch (error) {
      if (made) {
        await threads
          .artifact('delete', { id: plan.id, project: null, at: Date.now() })
          .then(() => threads.artifact('erase', { id: plan.id }))
          .catch(() => {})
      }
      result.failed.push({
        title: artifact.title,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  deps.progress?.(wanted.length, wanted.length, '')
  return { result, ledger }
}
