import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import { contentPath } from './artifacts/content'
import { newArtifactId } from './artifacts/ids'
import {
  checkKettuArtifact,
  checkKettuArtifacts,
  copyKettuDatabase,
  importKettuArtifacts,
  type ArtifactLedgerItem,
} from './kettu-import-artifacts'
import { inThreadWorker } from './testing/thread-worker'
import type { KettuArtifactRow } from './threads/kettu-artifacts'
import { ThreadStore } from './threads/store'

const platform = process.platform as Platform
const log = () => {}
const bytes = (text: string) => new TextEncoder().encode(text)
const page = (text: string) => bytes(`<!doctype html><title>${text}</title><p>${text}</p>`)

let root: string
let kettu: string
let huli: string
let project: string
let stores: ThreadStore[]

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'kettu-artifacts-'))
  kettu = path.join(root, 'Kettu')
  huli = path.join(root, 'Huli')
  project = path.join(root, 'work', 'alpha')
  for (const folder of [kettu, huli, project]) await mkdir(folder, { recursive: true })
  stores = []
})

afterEach(async () => {
  for (const store of stores) await store.close()
  await rm(root, { recursive: true, force: true })
})

/** A thread database with its content folder, as this app and Kettu keep them. */
async function openStore(data: string): Promise<ThreadStore> {
  await mkdir(path.join(data, 'state'), { recursive: true })
  const store = new ThreadStore({
    file: path.join(data, 'state', 'threads.db'),
    contentDir: path.join(data, 'artifacts', 'content'),
    createWorker: (worker) => inThreadWorker(worker),
    log,
  })
  stores.push(store)
  await store.ready
  return store
}

async function closeStore(store: ThreadStore): Promise<void> {
  await store.close()
  stores = stores.filter((other) => other !== store)
}

async function make(
  store: ThreadStore,
  title: string,
  versions: string[],
  extra: { id?: string; at?: number; folder?: string } = {},
): Promise<string> {
  const at = extra.at ?? Date.UTC(2026, 0, 1)
  const id = extra.id ?? newArtifactId(at)
  await store.artifact('create', {
    id,
    project: extra.folder ?? project,
    sessionId: 'kettu-session',
    title,
    files: [{ path: 'index.html', data: page(versions[0]!) }],
    pages: 1,
    note: 'first',
    at,
  })
  for (const [index, text] of versions.slice(1).entries()) {
    await store.artifact('write', {
      id,
      project: null,
      baseVersion: index + 1,
      changes: [{ path: 'index.html', data: page(text) }],
      pages: 1,
      author: 'kettu-session',
      note: `v${index + 2}`,
      at: at + (index + 1) * 1000,
    })
  }
  return id
}

/** Every file under the folder with its size, time and SHA-256, to show nothing changed. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of await readdir(dir, { recursive: true })) {
    const file = path.join(dir, name)
    const info = await stat(file)
    if (!info.isFile()) continue
    const hash = createHash('sha256')
      .update(await readFile(file))
      .digest('hex')
    out[name] = `${info.size} ${info.mtimeMs} ${hash}`
  }
  return out
}

async function importInto(huliStore: ThreadStore, ledger: ArtifactLedgerItem[] = []) {
  const temp = await mkdtemp(path.join(root, 'copy-'))
  const copy = await copyKettuDatabase(kettu, temp)
  expect(copy).not.toBeNull()
  const read = await huliStore.artifact('readKettu', { file: copy! })
  if (read.kind !== 'ok') throw new Error(read.kind)
  const checked = checkKettuArtifacts(read, kettu, platform)
  return importKettuArtifacts(checked, {
    threads: huliStore,
    source: kettu,
    sessionOf: (id) => (id === 'kettu-session' ? 'huli-session' : null),
    ledger,
  })
}

describe('importing Kettu artifacts', () => {
  it('brings each artifact over with its id, title and every version', async () => {
    const kettuStore = await openStore(kettu)
    const id = await make(kettuStore, 'Plan', ['one', 'two', 'three'])
    await closeStore(kettuStore)
    const huliStore = await openStore(huli)

    const { result, ledger } = await importInto(huliStore)

    expect(result.imported).toBe(1)
    expect(ledger).toEqual([{ kettuId: id, artifactId: id }])
    const found = await huliStore.artifact('get', { id, version: null, project: project })
    expect(found.artifact).toMatchObject({ title: 'Plan', head: 3, sessionId: 'huli-session' })
    const versions = await huliStore.artifact('versions', { id, project: null })
    expect(versions.map((v) => [v.version, v.note, v.author, v.createdAt])).toEqual([
      [3, 'v3', 'huli-session', Date.UTC(2026, 0, 1) + 2000],
      [2, 'v2', 'huli-session', Date.UTC(2026, 0, 1) + 1000],
      [1, 'first', 'huli-session', Date.UTC(2026, 0, 1)],
    ])
    const file = found.files[0]!
    expect(await readFile(contentPath(path.join(huli, 'artifacts', 'content'), file.hash))).toEqual(
      Buffer.from(page('three')),
    )
  })

  it('skips what is here, and renames an id taken by other content', async () => {
    const kettuStore = await openStore(kettu)
    const kept = await make(kettuStore, 'Kept', ['kept'])
    const copied = await make(kettuStore, 'Copied', ['same'], { at: Date.UTC(2026, 0, 2) })
    const clash = await make(kettuStore, 'Clash', ['kettu'], { at: Date.UTC(2026, 0, 3) })
    await closeStore(kettuStore)
    const huliStore = await openStore(huli)
    await make(huliStore, 'Mine', ['mine'], { id: clash })
    await make(huliStore, 'Copy here', ['same'])

    const first = await importInto(huliStore)

    expect(first.result.imported).toBe(2)
    expect(first.result.skipped.same).toBe(1)
    expect(first.result.renamed).toEqual([{ title: 'Clash', id: clash, as: expect.any(String) }])
    const renamed = first.result.renamed[0]!.as
    expect(renamed).not.toBe(clash)
    expect(
      (await huliStore.artifact('get', { id: clash, version: null, project: null })).artifact.title,
    ).toBe('Mine')
    expect(
      (await huliStore.artifact('get', { id: renamed, version: null, project: null })).artifact
        .title,
    ).toBe('Clash')
    expect(first.ledger.map((item) => item.kettuId).sort()).toEqual([clash, kept].sort())
    expect(first.ledger.some((item) => item.kettuId === copied)).toBe(false)

    // Again, after the user changed the imported one here: nothing comes twice.
    await huliStore.artifact('write', {
      id: kept,
      project: null,
      baseVersion: 1,
      changes: [{ path: 'index.html', data: page('changed here') }],
      pages: 1,
      author: null,
      note: null,
      at: Date.now(),
    })
    const second = await importInto(huliStore, first.ledger)
    expect(second.result.imported).toBe(0)
    expect(second.result.skipped).toMatchObject({ imported: 2, same: 1 })
  })

  it('passes over deleted, scratch, malformed and unreadable artifacts', async () => {
    const kettuStore = await openStore(kettu)
    const fine = await make(kettuStore, 'Fine', ['fine'])
    const deleted = await make(kettuStore, 'Deleted', ['deleted'])
    await kettuStore.artifact('delete', { id: deleted, project: null, at: Date.now() })
    await make(kettuStore, 'Scratch', ['scratch'], { folder: path.join(kettu, 'scratch', 's1') })
    const missing = await make(kettuStore, 'Missing', ['missing'])
    const tampered = await make(kettuStore, 'Tampered', ['tampered'])
    const lost = await kettuStore.artifact('get', { id: missing, version: null, project: null })
    const changed = await kettuStore.artifact('get', { id: tampered, version: null, project: null })
    await closeStore(kettuStore)
    const content = path.join(kettu, 'artifacts', 'content')
    await rm(contentPath(content, lost.files[0]!.hash))
    await writeFile(contentPath(content, changed.files[0]!.hash), page('TAMPERED'))
    // Rows no write of this app would make: a path out of the artifact, and an empty title.
    const db = new DatabaseSync(path.join(kettu, 'state', 'threads.db'))
    const hash = changed.files[0]!.hash
    for (const [id, title, file] of [
      [newArtifactId(), 'Escape', '../escape.html'],
      [newArtifactId(), '  ', 'index.html'],
    ]) {
      db.prepare(
        'INSERT INTO artifacts (id, project, title, head, session_id, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 1)',
      ).run(id!, project, title!, 's')
      db.prepare(
        'INSERT INTO artifact_versions (artifact_id, n, size, pages, author, note, created_at) VALUES (?, 1, 1, 0, NULL, NULL, 1)',
      ).run(id!)
      db.prepare(
        'INSERT INTO artifact_files (artifact_id, n, path, hash, size) VALUES (?, 1, ?, ?, 1)',
      ).run(id!, file!, hash)
    }
    db.close()
    const huliStore = await openStore(huli)

    const { result, ledger } = await importInto(huliStore)

    expect(result.imported).toBe(1)
    expect(ledger).toEqual([{ kettuId: fine, artifactId: fine }])
    expect(result.skipped).toEqual({
      imported: 0,
      same: 0,
      invalid: 2,
      missingContent: 2,
      scratch: 1,
      deleted: 1,
    })
    expect(result.failed).toEqual([])
    expect(await huliStore.artifact('list', { project: null, deleted: false })).toHaveLength(1)
  })

  it('never writes to Kettu folder', async () => {
    const kettuStore = await openStore(kettu)
    await make(kettuStore, 'Plan', ['one', 'two'])
    await closeStore(kettuStore)
    const before = await snapshot(kettu)
    const huliStore = await openStore(huli)
    const { result } = await importInto(huliStore)
    expect(result.imported).toBe(1)
    expect(await snapshot(kettu)).toEqual(before)
  })
})

describe('checking a record of Kettu artifact', () => {
  const row = (extra: Partial<KettuArtifactRow> = {}): KettuArtifactRow => ({
    id: newArtifactId(1),
    project,
    title: 'Plan',
    head: 1,
    sessionId: 's',
    createdAt: 1,
    updatedAt: 1,
    versions: [
      {
        version: 1,
        pages: 1,
        author: null,
        note: null,
        createdAt: 1,
        files: [{ path: 'index.html', hash: 'a'.repeat(64), size: 1 }],
        type: null,
        declaration: { capabilities: '["db"]', runtime: 1 },
      },
    ],
    ...extra,
  })

  it('takes one this app could have written', () => {
    expect(checkKettuArtifact(row())).toMatchObject({ title: 'Plan', type: null })
  })

  it('refuses ids, versions, types, paths and declarations out of shape', () => {
    const version = row().versions[0]!
    for (const bad of [
      row({ id: 'art_../x' }),
      row({ head: 2 }),
      row({ versions: [{ ...version, version: 2 }] }),
      row({ versions: [{ ...version, type: { name: 'spreadsheet', format: 1 } }] }),
      row({ versions: [{ ...version, files: [{ ...version.files[0]!, path: '_kettu/x' }] }] }),
      row({ versions: [{ ...version, files: [{ ...version.files[0]!, hash: 'XYZ' }] }] }),
      row({ versions: [{ ...version, files: [{ ...version.files[0]!, path: 'a.css' }] }] }),
      row({ versions: [{ ...version, declaration: { capabilities: '["net"]', runtime: 1 } }] }),
      row({ versions: [{ ...version, declaration: { capabilities: '[]', runtime: 99 } }] }),
      row({ versions: [{ ...version, declaration: { capabilities: '{', runtime: 1 } }] }),
    ]) {
      expect(checkKettuArtifact(bad)).toBeNull()
    }
  })
})
