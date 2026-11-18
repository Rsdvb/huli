// Huli: the artifact records of an official Kettu's thread database, read from a copy the import
// made of it, never from Kettu's own file. Runs in the thread worker, since node:sqlite is
// synchronous. The rows are only shaped here; kettu-import-artifacts.ts checks them as untrusted.
// Huli's own; see tools/huli/README.md.

import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { SCHEMA_VERSION } from './db'

/** The most artifacts, and versions of one, an import reads. */
const MAX_ARTIFACTS = 10_000
const MAX_VERSIONS = 1_000
const MAX_FILES = 1_000_000

export interface KettuVersionRow {
  version: number
  pages: number
  author: string | null
  note: string | null
  createdAt: number
  files: { path: string; hash: string; size: number }[]
  type: { name: string; format: number } | null
  /** What the version declares, as stored; null when it has no record. */
  declaration: { capabilities: string; runtime: number } | null
}

export interface KettuArtifactRow {
  id: string
  project: string
  title: string
  head: number
  sessionId: string
  createdAt: number
  updatedAt: number
  /** Oldest first. */
  versions: KettuVersionRow[]
}

export type KettuArtifactsRead =
  | { kind: 'ok'; artifacts: KettuArtifactRow[]; deleted: number; malformed: number }
  | { kind: 'newer' }

type Row = Record<string, SQLOutputValue>

function text(value: SQLOutputValue): value is string {
  return typeof value === 'string'
}

function int(value: SQLOutputValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function textOrNull(value: SQLOutputValue): value is string | null {
  return value === null || text(value)
}

/** The artifacts outside Recently deleted, with their versions and files; malformed rows counted. */
export function readKettuArtifacts(file: string): KettuArtifactsRead {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
  try {
    db.exec('PRAGMA trusted_schema = OFF')
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version > SCHEMA_VERSION) return { kind: 'newer' }
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    )
    const empty = { kind: 'ok' as const, artifacts: [], deleted: 0, malformed: 0 }
    if (!['artifacts', 'artifact_versions', 'artifact_files'].every((t) => tables.has(t))) {
      return empty
    }
    const deleted = Number(
      db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE deleted_at IS NOT NULL').get()?.n ?? 0,
    )
    const rows = db
      .prepare(
        `SELECT id, project, title, head, session_id, created_at, updated_at FROM artifacts
         WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT ${MAX_ARTIFACTS + 1}`,
      )
      .all()
    let malformed = Math.max(0, rows.length - MAX_ARTIFACTS)
    const versions = new Map<string, Row[]>()
    for (const row of db
      .prepare(
        `SELECT artifact_id, n, pages, author, note, created_at FROM artifact_versions
         ORDER BY artifact_id, n`,
      )
      .iterate()) {
      const id = String(row.artifact_id)
      const list = versions.get(id) ?? []
      if (list.length <= MAX_VERSIONS) list.push(row)
      versions.set(id, list)
    }
    const files = new Map<string, Row[]>()
    let count = 0
    for (const row of db
      .prepare('SELECT artifact_id, n, path, hash, size FROM artifact_files ORDER BY path')
      .iterate()) {
      if (++count > MAX_FILES) break
      const key = `${String(row.artifact_id)}\0${String(row.n)}`
      const list = files.get(key) ?? []
      list.push(row)
      files.set(key, list)
    }
    const types = new Map<string, Row>()
    if (tables.has('artifact_types')) {
      for (const row of db
        .prepare('SELECT artifact_id, n, type, format FROM artifact_types')
        .all()) {
        types.set(`${String(row.artifact_id)}\0${String(row.n)}`, row)
      }
    }
    const declarations = new Map<string, Row>()
    if (tables.has('artifact_runtime')) {
      for (const row of db
        .prepare('SELECT artifact_id, n, capabilities, runtime FROM artifact_runtime')
        .all()) {
        declarations.set(`${String(row.artifact_id)}\0${String(row.n)}`, row)
      }
    }
    const artifacts: KettuArtifactRow[] = []
    for (const row of rows.slice(0, MAX_ARTIFACTS)) {
      const artifact = artifactOf(row, versions, files, types, declarations)
      if (artifact) artifacts.push(artifact)
      else malformed++
    }
    return { kind: 'ok', artifacts, deleted, malformed }
  } finally {
    db.close()
  }
}

function artifactOf(
  row: Row,
  versions: Map<string, Row[]>,
  files: Map<string, Row[]>,
  types: Map<string, Row>,
  declarations: Map<string, Row>,
): KettuArtifactRow | null {
  const { id, project, title, head, session_id, created_at, updated_at } = row
  if (!text(id) || !text(project) || !text(title) || !text(session_id)) return null
  if (!int(head) || !int(created_at) || !int(updated_at)) return null
  const rows = versions.get(id) ?? []
  if (rows.length === 0 || rows.length > MAX_VERSIONS) return null
  const out: KettuVersionRow[] = []
  for (const version of rows) {
    const { n, pages, author, note } = version
    const at = version.created_at
    if (!int(n) || !int(pages) || !int(at) || !textOrNull(author) || !textOrNull(note)) return null
    const key = `${id}\0${n}`
    const stored: KettuVersionRow['files'] = []
    for (const file of files.get(key) ?? []) {
      if (!text(file.path) || !text(file.hash) || !int(file.size)) return null
      stored.push({ path: file.path, hash: file.hash, size: file.size })
    }
    const type = types.get(key)
    const declared = declarations.get(key)
    if (type && (!text(type.type) || !int(type.format))) return null
    if (declared && (!text(declared.capabilities) || !int(declared.runtime))) return null
    out.push({
      version: n,
      pages,
      author,
      note,
      createdAt: at,
      files: stored,
      type: type ? { name: String(type.type), format: Number(type.format) } : null,
      declaration: declared
        ? { capabilities: String(declared.capabilities), runtime: Number(declared.runtime) }
        : null,
    })
  }
  return {
    id,
    project,
    title,
    head,
    sessionId: session_id,
    createdAt: created_at,
    updatedAt: updated_at,
    versions: out,
  }
}
