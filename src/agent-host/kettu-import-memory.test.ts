import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryEntry } from '@shared/memory'
import type { Platform } from '@shared/platform'
import {
  importKettuMemory,
  readKettuMemory,
  type MemoryImportDeps,
  type MemoryLedgerItem,
} from './kettu-import-memory'
import { formatEntry } from './memory/entry-file'
import { MemoryService, projectDirName } from './memory/service'

const platform = process.platform as Platform
const log = () => {}

let root: string
let kettu: string
let huli: string
let temp: string
let alpha: string
let beta: string
let gone: string
let projects: { path: string; name: string }[]
let memory: MemoryService

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'kettu-memory-'))
  kettu = path.join(root, 'Kettu')
  huli = path.join(root, 'Huli')
  temp = path.join(root, 'copies')
  alpha = path.join(root, 'work', 'alpha')
  beta = path.join(root, 'work', 'beta')
  gone = path.join(root, 'work', 'gone')
  for (const folder of [kettu, huli, temp, alpha, beta]) await mkdir(folder, { recursive: true })
  projects = [{ path: alpha, name: 'alpha' }]
  memory = new MemoryService({
    root: path.join(huli, 'memory'),
    log,
    projects: () => projects,
    claudeAgents: () => [],
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function entry(id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    title: `Title ${id}`,
    description: `About ${id}`,
    body: `Body of ${id}.`,
    createdAt: Date.UTC(2026, 0, 2),
    updatedAt: Date.UTC(2026, 0, 3),
    source: { agentId: 'claude-code', sessionId: 'kettu-session' },
    ...extra,
  }
}

async function put(dir: string, item: MemoryEntry): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${item.id}.md`), formatEntry(item))
}

/** A project memory folder of Kettu's, named as Kettu might, with its project.json. */
async function kettuProject(name: string, project: string): Promise<string> {
  const dir = path.join(kettu, 'memory', 'projects', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'project.json'), JSON.stringify({ version: 1, path: project }))
  return dir
}

function deps(ledger: MemoryLedgerItem[] = []): MemoryImportDeps {
  return {
    memory,
    hasProject: (folder) => projects.some((p) => path.resolve(p.path) === path.resolve(folder)),
    addProject: async (folder) => {
      projects.push({ path: folder, name: path.basename(folder) })
    },
    isDirectory: async (folder) => (await stat(folder).catch(() => null))?.isDirectory() ?? false,
    sessionOf: (id) => (id === 'kettu-session' ? 'huli-session' : null),
    ledger,
    platform,
  }
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

async function run(ledger: MemoryLedgerItem[] = []) {
  const read = await readKettuMemory(kettu, temp, platform, log)
  return importKettuMemory(read, deps(ledger))
}

describe('importing Kettu memory', () => {
  it('brings global and project entries over with their ids, times and sessions', async () => {
    await put(path.join(kettu, 'memory', 'global'), entry('reply-in-chinese'))
    // Kettu's folder name is not this app's key: the project comes from project.json.
    const dir = await kettuProject('anything-123456789abc', alpha)
    await put(dir, entry('build-with-pnpm'))
    await mkdir(path.join(kettu, 'memory', 'undo'), { recursive: true })
    await writeFile(path.join(kettu, 'memory', 'undo', '0mwkio1qr-fa3b45b7.json'), '{}')

    const { result, ledger } = await run()

    expect(result.imported).toBe(2)
    expect(result.renamed).toEqual([])
    expect(ledger).toHaveLength(2)
    const [global] = await memory.list({ layer: 'global' })
    expect(global).toMatchObject({
      id: 'reply-in-chinese',
      title: 'Title reply-in-chinese',
      createdAt: Date.UTC(2026, 0, 2),
      updatedAt: Date.UTC(2026, 0, 3),
      source: { agentId: 'claude-code', sessionId: 'huli-session' },
    })
    expect(await memory.list({ layer: 'project', project: alpha })).toMatchObject([
      { id: 'build-with-pnpm' },
    ])
    const own = path.join(huli, 'memory', 'projects', projectDirName(alpha))
    expect(await readdir(own)).toContain('build-with-pnpm.md')
    expect(await readdir(path.join(huli, 'memory'))).not.toContain('undo')
  })

  it('skips what is here already and renames an id taken by other content', async () => {
    await memory.adopt({ layer: 'global' }, [
      entry('same-id', { body: 'Kept here.' }),
      entry('other-id', { title: 'Copied', body: 'Same text.' }),
      entry('twin', { body: 'Twin.' }),
    ])
    const global = path.join(kettu, 'memory', 'global')
    await put(global, entry('same-id', { body: 'Kettu says otherwise.' }))
    await put(global, entry('copy-elsewhere', { title: 'Copied', body: 'Same text.' }))
    await put(global, entry('twin', { body: 'Twin.' }))

    const { result } = await run()

    expect(result.imported).toBe(1)
    expect(result.skipped.same).toBe(2)
    expect(result.renamed).toEqual([
      { title: 'Title same-id', id: 'same-id', as: expect.any(String) },
    ])
    const here = await memory.list({ layer: 'global' })
    expect(here.find((e) => e.id === 'same-id')?.body).toBe('Kept here.')
    const renamed = here.find((e) => e.id === result.renamed[0]!.as)
    expect(renamed?.body).toBe('Kettu says otherwise.')
    expect(here).toHaveLength(4)
  })

  it('does not bring an entry again once imported, though it changed here', async () => {
    await put(path.join(kettu, 'memory', 'global'), entry('fact'))
    const first = await run()
    await memory.save(
      { layer: 'global' },
      'fact',
      { title: 'Title fact', description: '', body: 'Edited here.' },
      { agentId: null, sessionId: null },
    )
    const second = await run(first.ledger)
    expect(second.result.imported).toBe(0)
    expect(second.result.skipped.imported).toBe(1)
    expect(await memory.list({ layer: 'global' })).toHaveLength(1)
  })

  it('passes over malformed files and secrets, and projects it cannot place', async () => {
    const global = path.join(kettu, 'memory', 'global')
    await put(global, entry('fine'))
    await writeFile(path.join(global, 'Bad Name.md'), formatEntry(entry('x')))
    await writeFile(path.join(global, 'huge.md'), 'x'.repeat(300 * 1024))
    await writeFile(path.join(global, 'binary.md'), Buffer.from([0xff, 0xfe, 0x00, 0xc3]))
    await writeFile(path.join(global, 'long.md'), `# Long\n\n${'y'.repeat(9_000)}`)
    await put(global, entry('key', { body: 'sk-ant-api03-' + 'a'.repeat(90) }))
    const lost = path.join(kettu, 'memory', 'projects', 'lost-000000000000')
    await put(lost, entry('no-project-json'))
    const broken = await kettuProject('broken-000000000000', alpha)
    await writeFile(path.join(broken, 'project.json'), '{not json')
    await put(broken, entry('broken-project'))
    const scratch = await kettuProject('scratch-000000000000', path.join(kettu, 'scratch', 's1'))
    await put(scratch, entry('in-scratch'))
    await put(await kettuProject('gone-000000000000', gone), entry('folder-gone'))
    await put(await kettuProject('beta-000000000000', beta), entry('new-project'))

    const { result } = await run()

    expect(result.imported).toBe(2)
    expect(result.skipped).toEqual({
      imported: 0,
      same: 0,
      invalid: 7,
      secret: 1,
      full: 0,
      noProject: 1,
    })
    expect(projects.map((p) => p.path)).toEqual([alpha, beta])
    expect((await memory.list({ layer: 'global' })).map((e) => e.id)).toEqual(['fine'])
  })

  it('never writes to Kettu folder', async () => {
    await put(path.join(kettu, 'memory', 'global'), entry('fact'))
    await put(await kettuProject('alpha-000000000000', alpha), entry('rule'))
    await memory.adopt({ layer: 'global' }, [entry('fact', { body: 'Different.' })])
    const before = await snapshot(kettu)
    const { result } = await run()
    expect(result.imported).toBe(2)
    expect(await snapshot(kettu)).toEqual(before)
  })
})
