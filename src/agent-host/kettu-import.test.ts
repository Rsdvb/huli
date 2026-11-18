import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/agents'
import type { Platform } from '@shared/platform'
import { HostError } from './errors'
import {
  KettuImport,
  kettuDataFolder,
  kettuImportFile,
  type ImportSessions,
  type KettuImportDeps,
} from './kettu-import'
import { newArtifactId } from './artifacts/ids'
import type { ArtifactCaller } from './kettu-import-artifacts'
import { formatEntry } from './memory/entry-file'
import { MemoryService } from './memory/service'
import { projectsFile, sessionsFile, type ProjectRecord, type SessionRecord } from './storage'
import { inThreadWorker } from './testing/thread-worker'
import { ThreadStore } from './threads/store'
import { createValidators } from './validate'

const platform = process.platform as Platform
const log = () => {}

let root: string
let kettu: string
let huli: string
let copies: string
let alpha: string
let beta: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'kettu-import-'))
  kettu = path.join(root, 'Kettu')
  huli = path.join(root, 'Huli')
  copies = path.join(root, 'copies')
  alpha = path.join(root, 'work', 'alpha')
  beta = path.join(root, 'work', 'beta')
  for (const folder of [kettu, huli, copies, alpha, beta, path.join(kettu, 'scratch', 's1')]) {
    await mkdir(folder, { recursive: true })
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function session(id: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    agentId: 'claude-code',
    acpSessionId: `acp-${id}`,
    projectPath: alpha,
    title: `Title ${id}`,
    titleSource: 'agent',
    createdAt: 1_000,
    updatedAt: 2_000,
    lastViewedAt: 2_000,
    parentId: null,
    origin: 'user',
    description: null,
    branch: null,
    ...extra,
  }
}

/** Kettu's index, written by the code that writes this app's own. */
async function writeKettu(sessions: SessionRecord[], projects: ProjectRecord[]): Promise<void> {
  const sessionFile = sessionsFile(kettu, log)
  sessionFile.save({ version: 1, sessions })
  await sessionFile.flush()
  const projectFile = projectsFile(kettu, log)
  projectFile.save({ version: 1, projects })
  await projectFile.flush()
}

function fixture(): SessionRecord[] {
  return [
    session('pinned', { pinnedAt: 5_000, updatedAt: 9_000, customTitle: 'Mine' }),
    session('archived', { archivedAt: 6_000, projectPath: beta, createdAt: 500 }),
    session('child', { origin: 'subagent', parentId: 'pinned', acpSessionId: 'agent-1' }),
    session('child2', { origin: 'subagent', parentId: 'pinned', acpSessionId: 'agent-2' }),
    session('worktree', {
      worktree: { path: path.join(root, 'wt'), branch: 'b', base: 'main', baseOid: 'a'.repeat(40) },
    }),
    session('scratch', { projectPath: path.join(kettu, 'scratch', 's1') }),
    session('stranger', { agentId: 'claude-code~gone' as AgentId }),
    session('gone', { projectPath: path.join(root, 'work', 'gone') }),
    session('blank', { acpSessionId: '' }),
  ]
}

function threadStore(data: string): ThreadStore {
  return new ThreadStore({
    file: path.join(data, 'state', 'threads.db'),
    contentDir: path.join(data, 'artifacts', 'content'),
    createWorker: (worker) => inThreadWorker(worker),
    log,
  })
}

interface Fakes {
  imports: { params: Parameters<ImportSessions['importSession']>[0]; kept: unknown }[]
  added: string[]
  progress: [number, number, string | null][]
  summaries: SessionSummary[]
  held: Set<string>
}

function setup(extra: Partial<KettuImportDeps> = {}): { importer: KettuImport; fakes: Fakes } {
  const fakes: Fakes = { imports: [], added: [], progress: [], summaries: [], held: new Set() }
  let next = 0
  const importer = new KettuImport({
    source: kettu,
    ownData: huli,
    platform,
    tempDir: copies,
    ledger: kettuImportFile(huli, log),
    sessions: {
      list: () => fakes.summaries,
      importSession: async (params, kept) => {
        if (!params.fork && fakes.held.has(params.acpSessionId)) {
          throw new HostError('busy', 'held')
        }
        fakes.imports.push({ params, kept })
        const summary = {
          id: `huli-${next++}`,
          agentId: params.agentId,
          acpSessionId: params.fork ? `copy-${params.acpSessionId}` : params.acpSessionId,
        } as SessionSummary
        fakes.summaries.push(summary)
        return summary
      },
    },
    projects: {
      find: (value) =>
        fakes.added.includes(value)
          ? { path: value, name: '', addedAt: 0, lastOpenedAt: 0 }
          : undefined,
      add: async (value) => {
        fakes.added.push(value)
      },
    },
    memory: { list: async () => [], adopt: async () => [] },
    threads: null,
    artifactsChanged: () => {},
    hasAgent: (agentId) => agentId === 'claude-code',
    progress: (done, total, title) => fakes.progress.push([done, total, title]),
    log,
    ...extra,
  })
  return { importer, fakes }
}

/** Every file under the folder with its size, time and content. */
async function snapshot(folder: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of await readdir(folder, { recursive: true })) {
    const full = path.join(folder, name)
    const info = await stat(full)
    if (!info.isFile()) {
      out[name] = 'folder'
      continue
    }
    const hash = createHash('sha256')
      .update(await readFile(full))
      .digest('hex')
    out[name] = `${info.size} ${info.mtimeMs} ${hash}`
  }
  return out
}

describe('kettuDataFolder', () => {
  it("is Electron's data folder for an app named Kettu", () => {
    expect(
      kettuDataFolder('win32', 'C:\\Users\\a', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }),
    ).toBe('C:\\Users\\a\\AppData\\Roaming\\Kettu')
    expect(kettuDataFolder('win32', 'C:\\Users\\a', {})).toBe(
      'C:\\Users\\a\\AppData\\Roaming\\Kettu',
    )
    expect(kettuDataFolder('darwin', '/Users/a', {})).toBe(
      '/Users/a/Library/Application Support/Kettu',
    )
    expect(kettuDataFolder('linux', '/home/a', {})).toBe('/home/a/.config/Kettu')
    expect(kettuDataFolder('linux', '/home/a', { XDG_CONFIG_HOME: '/x' })).toBe('/x/Kettu')
    expect(kettuDataFolder('linux', '/home/a', { HULI_KETTU_DATA: '/copy' })).toBe('/copy')
  })
})

describe('KettuImport', () => {
  it('reads sessions, projects and links from a copy of the index', async () => {
    await writeKettu(fixture(), [{ path: alpha, name: 'alpha', addedAt: 1, lastOpenedAt: 1 }])
    const { importer } = setup()
    const scan = await importer.scan()
    expect(scan.found).toBe(true)
    expect(scan.error).toBeNull()
    expect(scan.counts).toEqual({ sessions: 7, subagents: 2, importable: 2, imported: 0 })
    const byId = Object.fromEntries(scan.sessions.map((s) => [s.id, s]))
    expect(byId.pinned).toMatchObject({
      title: 'Mine',
      pinned: true,
      archived: false,
      subagents: 2,
      skip: null,
      imported: false,
    })
    expect(byId.archived).toMatchObject({ archived: true, skip: null, projectPath: beta })
    expect(byId.child).toMatchObject({ origin: 'subagent', parentId: 'pinned', skip: 'subagent' })
    expect(byId.worktree!.skip).toBe('worktree')
    expect(byId.scratch!.skip).toBe('scratch')
    expect(byId.stranger!.skip).toBe('unknownAgent')
    expect(byId.gone!.skip).toBe('missingFolder')
    expect(byId.blank!.skip).toBe('noAgentSession')
    expect(scan.sessions[0]!.id).toBe('pinned')
    const alphaProject = scan.projects.find((p) => p.path === alpha)
    expect(alphaProject).toMatchObject({ name: 'alpha', sessions: 4, added: false })
    expect(scan.projects.find((p) => p.path === beta)).toMatchObject({ name: 'beta', sessions: 1 })
    expect(await readdir(copies)).toEqual([])
  })

  it('finds nothing without an index, or in its own folder', async () => {
    expect((await setup().importer.scan()).found).toBe(false)
    await writeKettu(fixture(), [])
    expect((await setup({ ownData: kettu }).importer.scan()).found).toBe(false)
  })

  it('reads nothing from an index a newer Kettu wrote', async () => {
    await mkdir(path.join(kettu, 'state'), { recursive: true })
    await writeFile(
      path.join(kettu, 'state', 'sessions.json'),
      JSON.stringify({ version: 99, sessions: [] }),
    )
    const scan = await setup().importer.scan()
    expect(scan).toMatchObject({ found: true, error: 'newer', sessions: [] })
  })

  it('imports through the agent session, keeping title, times, pin and archive', async () => {
    await writeKettu(fixture(), [])
    const { importer, fakes } = setup()
    const result = await importer.run(['pinned', 'archived', 'child', 'scratch', 'nope'])
    expect(result).toMatchObject({ imported: 2, forked: 0, skipped: 2 })
    expect(result.failed.map((f) => f.sessionId)).toEqual(['nope'])
    // The oldest first.
    expect(fakes.imports.map((i) => i.params.acpSessionId)).toEqual(['acp-archived', 'acp-pinned'])
    expect(fakes.imports[0]!.params).toEqual({
      agentId: 'claude-code',
      projectPath: beta,
      acpSessionId: 'acp-archived',
    })
    expect(fakes.imports[0]!.kept).toEqual({
      title: 'Title archived',
      titleSource: 'agent',
      createdAt: 500,
      updatedAt: 2_000,
      archivedAt: 6_000,
    })
    expect(fakes.imports[1]!.kept).toMatchObject({ customTitle: 'Mine', pinnedAt: 5_000 })
    expect(fakes.added).toEqual([beta, alpha])
    expect(fakes.progress).toEqual([
      [0, 2, 'Title archived'],
      [1, 2, 'Mine'],
      [2, 2, null],
    ])
    const ledger = JSON.parse(await readFile(path.join(huli, 'state', 'kettu-import.json'), 'utf8'))
    expect(ledger.imported).toEqual([
      { kettuId: 'archived', sessionId: 'huli-0' },
      { kettuId: 'pinned', sessionId: 'huli-1' },
    ])
  })

  it('skips sessions already here, by agent session or by an earlier import', async () => {
    await writeKettu(fixture(), [])
    const { importer, fakes } = setup()
    fakes.summaries.push({
      id: 'own',
      agentId: 'claude-code',
      acpSessionId: 'acp-pinned',
    } as SessionSummary)
    fakes.held.add('acp-archived')
    const first = await importer.run(['pinned', 'archived'])
    expect(first).toMatchObject({ imported: 1, forked: 1, skipped: 1 })
    expect(fakes.imports.map((i) => i.params)).toEqual([
      { agentId: 'claude-code', projectPath: beta, acpSessionId: 'acp-archived', fork: true },
    ])
    // The copy has an agent session of its own; the import's record still knows it.
    const scan = await importer.scan()
    expect(scan.sessions.filter((s) => s.imported).map((s) => s.id)).toEqual(['pinned', 'archived'])
    expect(scan.counts.imported).toBe(2)
    // Once the session made here is gone, as when deleted, it can be imported again.
    const again = await setup().importer.run(['archived'])
    expect(again).toMatchObject({ imported: 1, skipped: 0 })
  })

  it("never writes to, creates in or leaves copies of Kettu's folder", async () => {
    await writeKettu(fixture(), [{ path: alpha, name: 'alpha', addedAt: 1, lastOpenedAt: 1 }])
    const before = await snapshot(kettu)
    const { importer, fakes } = setup()
    fakes.held.add('acp-pinned')
    await importer.scan()
    await importer.run(['pinned', 'archived', 'worktree'])
    await importer.scan()
    expect(await snapshot(kettu)).toEqual(before)
    expect(await readdir(copies)).toEqual([])
  })

  it('brings memory and artifacts over after the sessions, naming the sessions they became', async () => {
    await writeKettu(fixture(), [])
    const entry = {
      id: 'reply-in-chinese',
      title: 'Reply in Chinese',
      description: '',
      body: 'Always.',
      createdAt: 1_000,
      updatedAt: 2_000,
      source: { agentId: 'claude-code' as AgentId, sessionId: 'pinned' },
    }
    await mkdir(path.join(kettu, 'memory', 'global'), { recursive: true })
    await writeFile(path.join(kettu, 'memory', 'global', `${entry.id}.md`), formatEntry(entry))
    const kettuThreads = threadStore(kettu)
    await kettuThreads.ready
    const artifactId = newArtifactId(1_000)
    await kettuThreads.artifact('create', {
      id: artifactId,
      project: alpha,
      sessionId: 'pinned',
      title: 'Plan',
      files: [{ path: 'index.html', data: new TextEncoder().encode('<p>plan</p>') }],
      pages: 1,
      note: null,
      at: 1_000,
    })
    await kettuThreads.close()
    const threads = threadStore(huli)
    await threads.ready
    const added: string[] = []
    const memory = new MemoryService({
      root: path.join(huli, 'memory'),
      log,
      projects: () => added.map((folder) => ({ path: folder, name: '' })),
      claudeAgents: () => [],
    })
    let changed = 0
    const { importer } = setup({ memory, threads, artifactsChanged: () => changed++ })
    const before = await snapshot(kettu)

    const scan = await importer.scan()
    expect(scan.memory).toEqual({ found: 1, importable: 1 })
    expect(scan.artifacts).toEqual({ found: 1, importable: 1, error: null })
    const result = await importer.run(['pinned'], { memory: true, artifacts: true })

    expect(result.memory).toMatchObject({ imported: 1 })
    expect(result.artifacts).toMatchObject({ imported: 1 })
    expect(changed).toBe(1)
    const [global] = await memory.list({ layer: 'global' })
    expect(global!.source.sessionId).toBe('huli-0')
    const found = await threads.artifact('get', { id: artifactId, version: null, project: null })
    expect(found.artifact.sessionId).toBe('huli-0')
    const again = await importer.scan()
    expect(again.memory).toEqual({ found: 1, importable: 0 })
    expect(again.artifacts).toEqual({ found: 1, importable: 0, error: null })
    const ledger = JSON.parse(await readFile(path.join(huli, 'state', 'kettu-import.json'), 'utf8'))
    expect(ledger.artifacts).toEqual([{ kettuId: artifactId, artifactId }])
    expect(ledger.memory).toHaveLength(1)
    expect(await snapshot(kettu)).toEqual(before)
    expect(await readdir(copies)).toEqual([])
    await threads.close()
  })

  it("removes the copy of Kettu's database when reading it fails", async () => {
    await writeKettu(fixture(), [])
    await writeFile(path.join(kettu, 'state', 'threads.db'), 'not a database')
    const threads = {
      artifact: async () => {
        throw new Error('broken')
      },
    } as ArtifactCaller
    const scan = await setup({ threads }).importer.scan()
    expect(scan.artifacts).toEqual({ found: 0, importable: 0, error: 'unreadable' })
    expect(await readdir(copies)).toEqual([])
  })

  it('removes copies an earlier host left behind, and only those', async () => {
    await writeKettu(fixture(), [])
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    for (const name of [
      'huli-kettu-Ab12Cd',
      'huli-kettu-Ef34Gh',
      'huli-kettu-data',
      'other-Ij56Kl',
    ]) {
      await mkdir(path.join(copies, name))
      await writeFile(path.join(copies, name, 'threads.db'), 'copy')
    }
    for (const name of ['huli-kettu-Ab12Cd', 'huli-kettu-data', 'other-Ij56Kl']) {
      await utimes(path.join(copies, name), twoHoursAgo, twoHoursAgo)
    }
    await setup().importer.scan()
    expect((await readdir(copies)).sort()).toEqual([
      'huli-kettu-Ef34Gh',
      'huli-kettu-data',
      'other-Ij56Kl',
    ])
  })

  it('runs one import at a time', async () => {
    await writeKettu(fixture(), [])
    const { importer } = setup()
    const first = importer.run(['pinned'])
    await expect(importer.run(['archived'])).rejects.toMatchObject({ code: 'busy' })
    await first
  })
})

describe('kettuImport validators', () => {
  const validators = createValidators('linux')

  it('takes the ids to import, each once', () => {
    expect(validators['kettuImport.run']({ sessionIds: ['a', 'b', 'a'], extra: 1 })).toEqual({
      sessionIds: ['a', 'b'],
    })
    expect(
      validators['kettuImport.run']({ sessionIds: [], memory: true, artifacts: false }),
    ).toEqual({ sessionIds: [], memory: true, artifacts: false })
    expect(validators['kettuImport.scan'](undefined)).toBeUndefined()
  })

  it('refuses anything else', () => {
    expect(() => validators['kettuImport.run']({})).toThrow(/sessionIds/)
    expect(() => validators['kettuImport.run']({ sessionIds: 'a' })).toThrow(/sessionIds/)
    expect(() => validators['kettuImport.run']({ sessionIds: [1] })).toThrow()
    expect(() => validators['kettuImport.run']({ sessionIds: [''] })).toThrow()
    expect(() => validators['kettuImport.run']({ sessionIds: [], memory: 'yes' })).toThrow()
    expect(() => validators['kettuImport.scan']({ x: 1 })).toThrow()
  })
})
