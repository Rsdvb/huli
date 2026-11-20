import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { SCHEMA_VERSION as THREAD_SCHEMA, ThreadDb } from '../../agent-host/threads/db'
import { INLINE_MEDIA_LIMIT } from '../../agent-host/threads/model'
import {
  buildManifest,
  checkEntries,
  MANIFEST_NAME,
  parseManifest,
  type Manifest,
} from './manifest'
import { backupName, backupStamp, isPartial, SAFETY_PREFIX, toPrune } from './names'
import { dropOnRestore, partOf, restorePlan } from './plan'
import { inspectBackup, restoreBackup } from './restore'
import { BackupFailure, runBackup } from './run'
import { isOwed, lastDue, nextDue } from './schedule'
import { parseState, PickedBackups, PICK_TTL_MS } from './state'
import { isEntryName, ZipReader, ZipWriter } from './zip'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kite-backup-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function put(root: string, relative: string, data: string | Buffer): Promise<void> {
  const file = path.join(root, ...relative.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, data)
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

async function readEntry(zip: ZipReader, name: string): Promise<Buffer> {
  return zip.read(zip.find(name)!, 64 * 1024 * 1024)
}

describe('the zip files', () => {
  it('reads back what it wrote, stored and deflated, and JSZip reads it too', async () => {
    const file = path.join(dir, 'a.zip')
    const big = Buffer.from('backup '.repeat(50_000))
    const source = path.join(dir, 'source.bin')
    await writeFile(source, big)
    const zip = await ZipWriter.create(file)
    expect(await zip.addBuffer('state/x.json', Buffer.from('{"a":1}'), { compress: true })).toEqual(
      {
        size: 7,
        sha256: sha('{"a":1}'),
      },
    )
    await zip.addBuffer('empty.txt', Buffer.alloc(0), { compress: false })
    await zip.addFile('memory/文件.md', source, { compress: false })
    await zip.addFile('state/big.txt', source, { compress: true, expected: big.length })
    await zip.close()

    const reader = await ZipReader.open(file)
    expect(reader.entries.map((entry) => entry.name)).toEqual([
      'state/x.json',
      'empty.txt',
      'memory/文件.md',
      'state/big.txt',
    ])
    expect((await readEntry(reader, 'state/x.json')).toString()).toBe('{"a":1}')
    expect((await readEntry(reader, 'empty.txt')).length).toBe(0)
    expect((await readEntry(reader, 'memory/文件.md')).equals(big)).toBe(true)
    expect((await readEntry(reader, 'state/big.txt')).equals(big)).toBe(true)
    expect(reader.find('state/big.txt')!.compressedSize).toBeLessThan(big.length / 10)
    await reader.close()

    const other = await JSZip.loadAsync(await readFile(file))
    expect(await other.file('memory/文件.md')!.async('string')).toBe(big.toString())
    expect(await other.file('state/x.json')!.async('string')).toBe('{"a":1}')
  })

  it('reads a zip JSZip wrote', async () => {
    const other = new JSZip()
    other.file('a/b.txt', 'hello')
    other.file('c.bin', Buffer.alloc(1000, 7), { compression: 'DEFLATE' })
    const file = path.join(dir, 'jszip.zip')
    await writeFile(file, await other.generateAsync({ type: 'nodebuffer' }))
    const reader = await ZipReader.open(file)
    expect((await readEntry(reader, 'a/b.txt')).toString()).toBe('hello')
    expect((await readEntry(reader, 'c.bin')).equals(Buffer.alloc(1000, 7))).toBe(true)
    await reader.close()
  })

  it('takes zip64 sizes in a local header for an entry declared that large', async () => {
    const file = path.join(dir, 'wide.zip')
    const source = path.join(dir, 'small')
    await writeFile(source, 'not that large')
    const zip = await ZipWriter.create(file)
    await zip.addFile('state/wide.bin', source, { compress: true, expected: 0xf0000000 })
    await zip.close()
    const bytes = await readFile(file)
    expect(bytes.readUInt32LE(18)).toBe(0xffffffff)
    const reader = await ZipReader.open(file)
    expect((await readEntry(reader, 'state/wide.bin')).toString()).toBe('not that large')
    await reader.close()
    const other = await JSZip.loadAsync(bytes)
    expect(await other.file('state/wide.bin')!.async('string')).toBe('not that large')
  })

  it('fails an entry whose bytes do not match its checksum', async () => {
    const file = path.join(dir, 'bad.zip')
    const zip = await ZipWriter.create(file)
    await zip.addBuffer('a.txt', Buffer.from('abcdefgh'), { compress: false })
    await zip.close()
    const bytes = await readFile(file)
    bytes[30 + 'a.txt'.length + 2] ^= 0xff
    await writeFile(file, bytes)
    const reader = await ZipReader.open(file)
    await expect(readEntry(reader, 'a.txt')).rejects.toThrow('checksum')
    await reader.close()
  })

  it('refuses what is no zip, and names that could leave a folder', async () => {
    await writeFile(path.join(dir, 'x.zip'), 'plain text')
    await expect(ZipReader.open(path.join(dir, 'x.zip'))).rejects.toThrow('Not a zip')
    for (const name of ['../x', 'a/../../x', '/etc/x', 'C:/x', 'a\\b', 'a//b', 'a/', '.', '']) {
      expect(isEntryName(name)).toBe(false)
    }
    expect(isEntryName('state/thread-media/ab/c.png')).toBe(true)
    const zip = await ZipWriter.create(path.join(dir, 'y.zip'))
    await expect(zip.addBuffer('../escape', Buffer.from('x'), { compress: false })).rejects.toThrow(
      'Not a name',
    )
    await zip.abort()
  })
})

describe('what a backup keeps', () => {
  it('keeps the settings, state, databases, memory, artifacts and media', () => {
    expect(partOf('settings.json')).toBe('file')
    expect(partOf('state/sessions.json')).toBe('file')
    expect(partOf('state/threads.db')).toBe('database')
    expect(partOf('state/usage.db')).toBe('database')
    expect(partOf('state/thread-media/ab/' + 'a'.repeat(64) + '.png')).toBe('content')
    expect(partOf('artifacts/content/ab/abcd')).toBe('content')
    expect(partOf('memory/global/entry.md')).toBe('file')
    expect(partOf('attachments/sent/x.png')).toBe('file')
    expect(partOf('marketplace/skills/x/SKILL.md')).toBe('file')
    expect(partOf('workflows/flow.json')).toBe('file')
  })

  it('leaves out secrets, caches, journals, the search index and what is not its own', () => {
    for (const path of [
      'remote/identity.json',
      'remote/account.json',
      'market-keys.json',
      'published-artifacts.json',
      'agent-network/subscriptions.json',
      'state/agent-network.json',
      'state/search-1.db',
      'state/threads.db-wal',
      'state/threads.db-shm',
      'state/sessions.json.tmp',
      'state/sessions.corrupt-1.json',
      'state/market-catalog.json',
      'state/site-icons.json',
      'state/other.db',
      'artifacts/thumbnails/a.png',
      'artifacts/remote/x/y',
      'marketplace/catalog/x',
      'window-state.json',
      'backup-state.json',
      'logs/main.log',
      'Cache/data_0',
      'Partitions/x/Cookies',
      '.restore-staging-1/settings.json',
      '../settings.json',
      'state/../remote/identity.json',
    ]) {
      expect(partOf(path), path).toBeNull()
    }
  })

  it('drops the journals, the search index and thumbnails on restore, nothing else', () => {
    expect(dropOnRestore('state/threads.db-wal')).toBe(true)
    expect(dropOnRestore('state/usage.db-shm')).toBe(true)
    expect(dropOnRestore('state/search-1.db')).toBe(true)
    expect(dropOnRestore('state/search-1.db-wal')).toBe(true)
    expect(dropOnRestore('artifacts/thumbnails/a.png')).toBe(true)
    expect(dropOnRestore('remote/identity.json')).toBe(false)
    expect(dropOnRestore('state/agent-network.json')).toBe(false)
  })

  it('plans a restore that replaces what the backup covers and leaves the rest', () => {
    const plan = restorePlan(
      [
        'settings.json',
        'state/sessions.json',
        'state/new-since.json',
        'state/threads.db',
        'state/threads.db-wal',
        'state/search-1.db',
        'remote/identity.json',
        'state/agent-network.json',
        'artifacts/thumbnails/a.png',
      ],
      ['settings.json', 'state/sessions.json', 'state/threads.db'],
    )
    expect(plan.replace).toEqual([
      'settings.json',
      'state/sessions.json',
      'state/new-since.json',
      'state/threads.db',
    ])
    expect(plan.drop).toEqual([
      'state/threads.db-wal',
      'state/search-1.db',
      'artifacts/thumbnails/a.png',
    ])
    expect(plan.place).toEqual(['settings.json', 'state/sessions.json', 'state/threads.db'])
  })

  it('refuses a backup that would write where a backup may not', () => {
    expect(() => restorePlan([], ['remote/identity.json'])).toThrow('may not hold')
    expect(() => restorePlan([], ['../outside'])).toThrow('may not hold')
  })
})

describe('the manifest', () => {
  const manifest = (): Manifest =>
    buildManifest({
      app: '0.1.0',
      created: new Date('2026-11-20T03:00:00Z'),
      platform: 'win32',
      leftOut: ['remote/'],
      files: [
        { path: 'state/sessions.json', size: 2, sha256: sha('{}'), part: 'file' },
        { path: 'settings.json', size: 2, sha256: sha('{}'), part: 'file' },
      ],
    })

  it('reads back what it wrote, its files sorted', () => {
    const parsed = parseManifest(JSON.parse(JSON.stringify(manifest())))
    expect(parsed).toEqual(manifest())
    expect((parsed as Manifest).files.map((file) => file.path)).toEqual([
      'settings.json',
      'state/sessions.json',
    ])
  })

  it('refuses another format, a newer version and damaged records', () => {
    const base = manifest()
    expect(parseManifest({ ...base, format: 'zip' })).toBe('Not a Kite backup')
    expect(parseManifest({ ...base, version: 2 })).toContain('newer version')
    const file = base.files[0]!
    for (const bad of [
      { ...file, sha256: 'abc' },
      { ...file, size: -1 },
      { ...file, path: '../escape' },
      { ...file, path: 'remote/identity.json' },
      { ...file, part: 'database' },
    ]) {
      expect(typeof parseManifest({ ...base, files: [bad] })).toBe('string')
    }
    expect(parseManifest({ ...base, files: [file, file] })).toContain('twice')
  })

  it('checks the zip holds exactly the files listed, at their sizes', () => {
    const listed = manifest()
    const entries = [
      { name: 'settings.json', size: 2 },
      { name: 'state/sessions.json', size: 2 },
      { name: MANIFEST_NAME, size: 100 },
    ]
    expect(checkEntries(listed, entries)).toBeNull()
    expect(checkEntries(listed, entries.slice(1))).toContain('missing settings.json')
    expect(checkEntries(listed, [...entries, { name: 'memory/x.md', size: 1 }])).toContain(
      'does not list',
    )
    expect(
      checkEntries(listed, [{ name: 'settings.json', size: 3 }, ...entries.slice(1)]),
    ).toContain('not the size')
  })
})

describe('naming and pruning the backups', () => {
  it('names a backup by its local time, apart from one of the same second', () => {
    const at = new Date(2026, 10, 20, 3, 0, 12)
    expect(backupName(at)).toBe('Kite-backup-2026-11-20-030012.zip')
    expect(backupName(at, undefined, new Set(['Kite-backup-2026-11-20-030012.zip']))).toBe(
      'Kite-backup-2026-11-20-030012-2.zip',
    )
    expect(backupName(at, SAFETY_PREFIX)).toBe('Kite-before-restore-2026-11-20-030012.zip')
  })

  it('removes the oldest backups past the count, and nothing else in the folder', () => {
    const names = [
      'Kite-backup-2026-11-18-030000.zip',
      'Kite-backup-2026-11-20-030000.zip',
      'Kite-backup-2026-11-19-030000.zip',
      'Kite-backup-2026-11-20-030000-2.zip',
      'Kite-before-restore-2026-01-01-000000.zip',
      'Kite-backup-2026-11-17-030000.zip.partial',
      'notes.txt',
      'Kite-backup-garbage.zip',
    ]
    expect(toPrune(names, 2)).toEqual([
      'Kite-backup-2026-11-18-030000.zip',
      'Kite-backup-2026-11-19-030000.zip',
    ])
    expect(toPrune(names, 10)).toEqual([])
    expect(toPrune(names, 0)).toHaveLength(3)
    expect(backupStamp('Kite-backup-2026-11-20-030000-2.zip')! > backupStamp(names[1]!)!).toBe(true)
    expect(isPartial('Kite-backup-2026-11-17-030000.zip.partial')).toBe(true)
    expect(isPartial('mine.zip.partial')).toBe(false)
  })
})

describe('the schedule', () => {
  const at = (day: number, hours: number, minutes = 0): number =>
    new Date(2026, 10, day, hours, minutes).getTime()

  it('is due each day at the set time', () => {
    expect(lastDue(at(20, 10), '03:00')).toBe(at(20, 3))
    expect(lastDue(at(20, 2), '03:00')).toBe(at(19, 3))
    expect(nextDue(at(20, 2), '03:00')).toBe(at(20, 3))
    expect(nextDue(at(20, 3), '03:00')).toBe(at(21, 3))
  })

  it('catches up a missed day once, at the next chance', () => {
    // Off overnight: the 03:00 backup comes when the computer is on again.
    expect(isOwed(at(20, 9), '03:00', at(19, 3, 1))).toBe(true)
    // That attempt pays for it, whatever came of it, until the next day's time.
    expect(isOwed(at(20, 12), '03:00', at(20, 9))).toBe(false)
    expect(isOwed(at(21, 3, 1), '03:00', at(20, 9))).toBe(true)
    // Several days off still owe one backup, not one a day.
    expect(isOwed(at(25, 9), '03:00', at(19, 3))).toBe(true)
    expect(isOwed(at(25, 10), '03:00', at(25, 9))).toBe(false)
    expect(isOwed(at(20, 9), '03:00', null)).toBe(true)
  })
})

describe('the record main keeps', () => {
  it('drops what does not parse and keeps the rest', () => {
    expect(
      parseState({
        version: 1,
        lastAttempt: 5,
        last: { at: 5, file: 'a.zip', bytes: 1, files: 2, durationMs: 3 },
        error: { at: 6, problem: 'no-space', message: 'full' },
        restore: { at: 7, ok: 'yes', from: 'a.zip' },
      }),
    ).toEqual({
      version: 1,
      lastAttempt: 5,
      last: { at: 5, file: 'a.zip', bytes: 1, files: 2, durationMs: 3 },
      error: { at: 6, problem: 'no-space', message: 'full' },
      restore: null,
    })
    expect(parseState({ version: 1, error: { at: 1, problem: 'exploded' } }).error).toBeNull()
    expect(parseState({ version: 2, lastAttempt: 5 }).lastAttempt).toBeNull()
    expect(parseState('nonsense').last).toBeNull()
  })

  it('restores only a file its dialog picked, by a token good once and for a while', () => {
    const picks = new PickedBackups()
    const token = picks.add('C:/backups/a.zip', 1000)
    expect(picks.take(token, 2000)).toBe('C:/backups/a.zip')
    expect(() => picks.take(token, 2000)).toThrow('again')
    const late = picks.add('C:/backups/b.zip', 1000)
    expect(() => picks.take(late, 1000 + PICK_TTL_MS + 1)).toThrow('again')
    for (const bad of ['C:/backups/a.zip', 7, null, { token }, '0'.repeat(31)]) {
      expect(() => picks.take(bad, 2000)).toThrow('Not a picked backup')
    }
  })
})

describe('a backup and its restore', () => {
  let data: string
  let dest: string

  beforeEach(async () => {
    data = path.join(dir, 'data')
    dest = path.join(dir, 'backups')
    await put(data, 'settings.json', '{"version":1}')
    await put(data, 'window-state.json', '{}')
    await put(data, 'market-keys.json', '{"key":"secret"}')
    await put(data, 'state/sessions.json', '{"sessions":["a"]}')
    await put(data, 'state/agent-network.json', '{}')
    await put(data, 'state/search-1.db', 'index')
    await put(data, 'memory/global/a.md', '# A')
    await put(data, 'artifacts/content/ab/abcd', '<p>artifact</p>')
    await put(data, 'artifacts/thumbnails/abcd.png', 'thumb')
    await put(data, `state/thread-media/ab/${'a'.repeat(64)}.png`, Buffer.alloc(4096, 1))
    await put(data, 'remote/identity.json', '{"privateKey":"before"}')
    await put(data, 'agent-network/subscriptions.json', '{"url":"https://example.com/token"}')
    await put(data, 'Cache/data_0', 'cache')
  })

  /** A threads database in WAL mode whose rows are still in the WAL, as while the host runs. */
  function openThreads(value: string): DatabaseSync {
    const db = new DatabaseSync(path.join(data, 'state', 'threads.db'))
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (v TEXT); DELETE FROM t')
    db.prepare('INSERT INTO t VALUES (?)').run(value)
    return db
  }

  function readThreads(file: string): string[] {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      return db
        .prepare('SELECT v FROM t')
        .all()
        .map((row) => String(row.v))
    } finally {
      db.close()
    }
  }

  const job = { app: '0.1.0', platform: process.platform, keep: 7, createDest: true }

  it('writes one zip of what it keeps, the open database copied whole', async () => {
    const db = openThreads('one')
    let done
    try {
      expect(existsSync(path.join(data, 'state', 'threads.db-wal'))).toBe(true)
      done = await runBackup({ ...job, dataDir: data, destDir: dest, tempDir: dir })
    } finally {
      db.close()
    }
    expect(await readdir(dest)).toEqual([done.file])
    expect(done.file).toMatch(/^Kite-backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/)

    const { manifest } = await inspectBackup(done.path)
    expect(manifest.files.map((file) => file.path)).toEqual([
      'artifacts/content/ab/abcd',
      'memory/global/a.md',
      'settings.json',
      'state/sessions.json',
      `state/thread-media/ab/${'a'.repeat(64)}.png`,
      'state/threads.db',
    ])
    expect(manifest.files.find((file) => file.path === 'settings.json')!.sha256).toBe(
      sha('{"version":1}'),
    )
    const zip = await ZipReader.open(done.path)
    const copy = path.join(dir, 'copy.db')
    await writeFile(copy, await readEntry(zip, 'state/threads.db'))
    await zip.close()
    expect(readThreads(copy)).toEqual(['one'])
  })

  it('keeps as many backups as the setting says', async () => {
    let at = new Date(2026, 10, 20, 3, 0, 0).getTime()
    const now = (): Date => new Date((at += 1000))
    for (let i = 0; i < 4; i++) {
      await runBackup({ ...job, keep: 2, dataDir: data, destDir: dest, tempDir: dir, now })
    }
    const names = (await readdir(dest)).sort()
    expect(names).toHaveLength(2)
    expect(names[1]! > names[0]!).toBe(true)
  })

  it('fails without touching anything when a picked folder is not there', async () => {
    await expect(
      runBackup({ ...job, createDest: false, dataDir: data, destDir: dest, tempDir: dir }),
    ).rejects.toMatchObject({ problem: 'destination-missing' })
    expect(existsSync(dest)).toBe(false)
  })

  it('restores the backup over newer data, keeps a safety copy, and leaves the keys', async () => {
    openThreads('one').close()
    const done = await runBackup({ ...job, dataDir: data, destDir: dest, tempDir: dir })

    openThreads('two').close()
    await put(data, 'state/sessions.json', '{"sessions":["a","b"]}')
    await put(data, 'memory/global/b.md', '# B, made since')
    await put(data, 'remote/identity.json', '{"privateKey":"after"}')
    await put(data, 'state/threads.db-wal', 'a journal of the newer data')

    const restored = await restoreBackup({
      file: done.path,
      dataDir: data,
      safety: { ...job, destDir: dest, tempDir: dir },
    })
    expect(await readFile(path.join(data, 'state/sessions.json'), 'utf8')).toBe(
      '{"sessions":["a"]}',
    )
    expect(readThreads(path.join(data, 'state/threads.db'))).toEqual(['one'])
    expect(existsSync(path.join(data, 'memory/global/b.md'))).toBe(false)
    expect(existsSync(path.join(data, 'memory/global/a.md'))).toBe(true)
    // What the backup leaves out stays as it is now; what is rebuilt goes.
    expect(await readFile(path.join(data, 'remote/identity.json'), 'utf8')).toBe(
      '{"privateKey":"after"}',
    )
    expect(existsSync(path.join(data, 'agent-network/subscriptions.json'))).toBe(true)
    expect(existsSync(path.join(data, 'Cache/data_0'))).toBe(true)
    expect(existsSync(path.join(data, 'state/search-1.db'))).toBe(false)
    expect(existsSync(path.join(data, 'artifacts/thumbnails/abcd.png'))).toBe(false)
    expect((await readdir(data)).filter((name) => name.startsWith('.restore'))).toEqual([])

    expect(restored.safety.file.startsWith(SAFETY_PREFIX)).toBe(true)
    const safety = await ZipReader.open(restored.safety.path)
    expect((await readEntry(safety, 'memory/global/b.md')).toString()).toBe('# B, made since')
    await safety.close()
  })

  it('refuses a backup whose files do not match its manifest and changes nothing', async () => {
    const zipFile = path.join(dir, 'tampered.zip')
    const zip = await ZipWriter.create(zipFile)
    await zip.addBuffer('settings.json', Buffer.from('{"version":9}'), { compress: true })
    const manifest = buildManifest({
      app: '0.1.0',
      created: new Date(),
      platform: process.platform,
      leftOut: [],
      files: [{ path: 'settings.json', size: 13, sha256: sha('{"version":1}'), part: 'file' }],
    })
    await zip.addBuffer(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest)), { compress: true })
    await zip.close()

    await expect(
      restoreBackup({ file: zipFile, dataDir: data, safety: { ...job, destDir: dest } }),
    ).rejects.toBeInstanceOf(BackupFailure)
    expect(await readFile(path.join(data, 'settings.json'), 'utf8')).toBe('{"version":1}')
    expect(existsSync(dest)).toBe(false)
    expect((await readdir(data)).filter((name) => name.startsWith('.restore'))).toEqual([])
  })

  it('keeps the thread database and its media files together, back as the app reads them', async () => {
    // The real thread database, its pictures in files under state/thread-media/.
    const file = path.join(data, 'state', 'threads.db')
    await rm(file, { force: true })
    const bytes = Buffer.alloc(INLINE_MEDIA_LIMIT, 7)
    const hash = sha(bytes)
    const db = ThreadDb.open(file, () => {})
    const entry: ThreadEntry = {
      kind: 'user',
      id: 'u',
      content: [
        {
          type: 'ref',
          ref: { kind: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
        },
      ],
    }
    db.write('s1', {
      head: { agentId: 'claude-code', acpSessionId: 'a' },
      entries: [{ pos: 0, entry }],
    })
    let done
    try {
      done = await runBackup({ ...job, dataDir: data, destDir: dest, tempDir: dir })
    } finally {
      db.close()
    }
    const { manifest } = await inspectBackup(done.path)
    expect(manifest.schemas['state/threads.db']).toBe(THREAD_SCHEMA)
    const media = manifest.files.find((f) => f.path.startsWith('state/thread-media/'))
    expect(media?.sha256).toBe(hash)

    // Gone from the data folder, the database and its media come back whole.
    await rm(path.join(data, 'state'), { recursive: true, force: true })
    await restoreBackup({ file: done.path, dataDir: data, safety: { ...job, destDir: dest } })
    const reopened = ThreadDb.open(file, () => {})
    try {
      expect(reopened.blob('s1', hash)?.data).toEqual(new Uint8Array(bytes))
    } finally {
      reopened.close()
    }
  })

  it('refuses a zip that is not a Kite backup', async () => {
    const zipFile = path.join(dir, 'other.zip')
    const other = new JSZip()
    other.file('remote/identity.json', '{}')
    await writeFile(zipFile, await other.generateAsync({ type: 'nodebuffer' }))
    await expect(inspectBackup(zipFile)).rejects.toThrow('no Kite backup manifest')
  })
})
