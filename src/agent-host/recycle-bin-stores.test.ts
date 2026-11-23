// Huli: what the recycle bin keeps in the stored files, and the checks of its requests.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_BIN_KEYS } from '@shared/recycle-bin'
import { Projects } from './projects'
import {
  parseProjectsFile,
  parseRoutinesFile,
  parseSessionsFile,
  projectsFile,
  type ProjectsFile,
} from './storage'
import { createValidators } from './validate'

const log = () => {}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kite-bin-stores-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const session = {
  id: 's1',
  agentId: 'claude-code',
  acpSessionId: 'acp-1',
  projectPath: '/repo',
  title: null,
  createdAt: 1,
  updatedAt: 2,
  lastViewedAt: null,
  parentId: null,
  origin: 'user',
  description: null,
  branch: null,
}

describe('Huli: the recycle bin in the stored files', () => {
  it("reads a session's place in the bin, and drops it without a time", () => {
    const binned = {
      ...session,
      deletedAt: 10,
      deletedWith: 'project:/repo',
      deletedKeepsAgent: true,
      noProject: true,
    }
    expect(parseSessionsFile({ sessions: [binned] })).toMatchObject({
      sessions: [
        { deletedAt: 10, deletedWith: 'project:/repo', deletedKeepsAgent: true, noProject: true },
      ],
    })
    const loose = { ...session, deletedAt: 'soon', deletedWith: 'project:/repo' }
    const [read] = (parseSessionsFile({ sessions: [loose] }) as { sessions: object[] }).sessions
    expect(read).not.toHaveProperty('deletedAt')
    expect(read).not.toHaveProperty('deletedWith')
  })

  it("reads a project's and a routine's time in the bin", () => {
    const project = { path: '/repo', name: 'repo', addedAt: 1, lastOpenedAt: 2, deletedAt: 3 }
    expect(parseProjectsFile({ projects: [project] }, 'darwin')).toMatchObject({
      projects: [{ path: '/repo', deletedAt: 3 }],
    })
    const routine = {
      id: 'r-0123456789ab',
      name: 'Morning briefing',
      prompt: 'Summarize',
      agentId: 'fake-agent',
      projectPath: null,
      options: [],
      trigger: { kind: 'schedule', schedule: { kind: 'weekly', days: [1], time: '09:00' } },
      scope: { level: 'read', web: false },
      timeLimitMinutes: 60,
      keptRunSessions: 50,
      onLimit: 'switch',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      checkedThrough: 3,
    }
    const read = parseRoutinesFile({ routines: [{ ...routine, deletedAt: 9 }, routine] })
    expect(read).toMatchObject({ routines: [{ deletedAt: 9 }, { id: routine.id }] })
    expect((read as { routines: object[] }).routines[1]).not.toHaveProperty('deletedAt')
  })

  it('keeps a removed project with its settings, out of every lookup, until it comes back', async () => {
    const make = () =>
      new Projects({
        file: projectsFile(dir, log, 'darwin'),
        platform: 'darwin',
        realpath: async (value) => value,
        isDirectory: async () => true,
      })
    const projects = make()
    await projects.load()
    await projects.add('/repo')
    const record = projects.match('/repo')
    projects.pin(record, true)
    projects.remove(record)
    expect(projects.list()).toEqual([])
    expect(projects.find('/repo')).toBeUndefined()
    expect(() => projects.match('/repo')).toThrow()
    expect(projects.paths()).toEqual([])
    await projects.flush()
    const stored = JSON.parse(
      await readFile(path.join(dir, 'state', 'projects.json'), 'utf8'),
    ) as ProjectsFile
    expect(stored.projects).toMatchObject([
      { path: '/repo', pinnedAt: expect.any(Number), deletedAt: expect.any(Number) },
    ])
    // After a restart it is still in the bin, and a restore puts it back as it was.
    const again = make()
    await again.load()
    expect(again.list()).toEqual([])
    expect(again.binnedRecords().map((item) => item.path)).toEqual(['/repo'])
    expect(again.restore('/repo')).toBe(true)
    expect(again.list()).toMatchObject([{ path: '/repo', pinnedAt: expect.any(Number) }])
    expect(again.binnedRecords()).toEqual([])
  })

  it('takes a project out of the bin when its folder is added again, and purges one for good', async () => {
    const projects = new Projects({
      file: projectsFile(dir, log, 'darwin'),
      platform: 'darwin',
      realpath: async (value) => value,
      isDirectory: async () => true,
    })
    await projects.load()
    await projects.add('/a')
    await projects.add('/b')
    projects.setAutoApprove(projects.match('/a'), 'low')
    projects.remove(projects.match('/a'))
    projects.remove(projects.match('/b'))
    await projects.add('/a')
    expect(projects.list()).toMatchObject([{ path: '/a', autoApprove: 'low' }])
    expect(projects.binnedRecords().map((item) => item.path)).toEqual(['/b'])
    projects.purge(['/b'])
    expect(projects.binnedRecords()).toEqual([])
    await projects.flush()
    const stored = JSON.parse(
      await readFile(path.join(dir, 'state', 'projects.json'), 'utf8'),
    ) as ProjectsFile
    expect(stored.projects.map((item) => item.path)).toEqual(['/a'])
  })
})

describe('Huli: the recycle bin requests', () => {
  const validate = createValidators('darwin')

  it('takes keys that name a kind, each once', () => {
    expect(validate['bin.list']!(undefined)).toBeUndefined()
    expect(validate['bin.empty']!(undefined)).toBeUndefined()
    expect(validate['bin.purge']!({ keys: ['session:s1', 'session:s1', 'project:/a:b'] })).toEqual({
      keys: ['session:s1', 'project:/a:b'],
    })
    expect(validate['bin.restore']!({ keys: ['folder:f1'], project: 'noProject' })).toEqual({
      keys: ['folder:f1'],
      project: 'noProject',
    })
    expect(validate['bin.restore']!({ keys: ['folder:f1'] })).toEqual({ keys: ['folder:f1'] })
  })

  it('refuses keys that name no kind, too many, and a project choice it does not know', () => {
    const refused = [
      { keys: [] },
      { keys: 'session:s1' },
      { keys: ['nothing:x'] },
      { keys: ['session:'] },
      { keys: [7] },
      { keys: ['session:a\0b'] },
      { keys: [`session:${'x'.repeat(5000)}`] },
      { keys: Array.from({ length: MAX_BIN_KEYS + 1 }, (_, i) => `session:${i}`) },
    ]
    for (const params of refused) {
      expect(() => validate['bin.purge']!(params)).toThrow()
      expect(() => validate['bin.restore']!(params)).toThrow()
    }
    expect(() => validate['bin.restore']!({ keys: ['session:s1'], project: 'all' })).toThrow()
    expect(() => validate['bin.list']!({ keys: ['session:s1'] })).toThrow()
  })
})
