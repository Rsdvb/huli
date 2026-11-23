// Huli: the recycle bin through the host's requests, as a window and a paired phone use it: a
// session, a folder, a project and a routine go in and come back, and the keys route to each kind.

import { afterEach, describe, expect, it } from 'vitest'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

async function started(): Promise<TestHost> {
  const host = await startTestHost()
  hosts.push(host)
  return host
}

async function prompted(window: TestPort, project: string): Promise<string> {
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'hello' }],
  })
  await window.untilEntry(id, (entry) => entry.kind === 'agent')
  await window.untilStatus(id, 'ready')
  return id
}

const ids = async (window: TestPort) =>
  (await window.request('sessions.list', {})).map((summary) => summary.id)

const keys = async (window: TestPort) =>
  (await window.request('bin.list', undefined)).items.map((item) => item.key)

describe('Huli: the recycle bin on the host', () => {
  it('takes a session and its folder out of every list and puts them back', async () => {
    const host = await started()
    const window = host.connect()
    const id = await prompted(window, host.project)
    const folder = await window.request('folders.create', { name: 'Work', sessionIds: [id] })

    await window.request('sessions.delete', { sessionId: id })
    expect(await ids(window)).not.toContain(id)
    expect((await window.request('folders.list', undefined))[0]!.sessionIds).toEqual([])
    await expect(window.request('sessions.open', { sessionId: id })).rejects.toThrow()
    const listed = await window.request('bin.list', undefined)
    expect(listed.keepDays).toBe(30)
    expect(listed.items).toMatchObject([
      {
        key: `session:${id}`,
        kind: 'session',
        agentId: 'fake-agent',
        project: 'listed',
        purgeAt: expect.any(Number),
      },
    ])

    expect(await window.request('bin.restore', { keys: [`session:${id}`] })).toEqual({
      restored: [`session:${id}`],
      held: [],
    })
    expect(await ids(window)).toContain(id)
    // Its folder kept it while it was in the bin.
    expect((await window.request('folders.list', undefined))[0]!.sessionIds).toEqual([id])
    // Its stored thread came back with it.
    const opened = await window.request('sessions.open', { sessionId: id })
    expect(JSON.stringify(opened)).toContain('hello')

    await window.request('folders.delete', { folderId: folder.id })
    expect(await window.request('folders.list', undefined)).toEqual([])
    expect(await ids(window)).toContain(id)
    expect((await window.request('bin.list', undefined)).items).toMatchObject([
      { key: `folder:${folder.id}`, title: 'Work', count: 1 },
    ])
    await window.request('bin.restore', { keys: [`folder:${folder.id}`] })
    expect(await window.request('folders.list', undefined)).toMatchObject([
      { id: folder.id, sessionIds: [id] },
    ])
    expect(await keys(window)).toEqual([])
  })

  it('takes a project with its sessions, and asks for it before a session alone comes back', async () => {
    const host = await started()
    const window = host.connect()
    const kept = await prompted(window, host.project)
    const alone = await prompted(window, host.project)
    await window.request('sessions.delete', { sessionId: alone })
    const [project] = await window.request('projects.list', undefined)
    await window.request('projects.remove', { path: project!.path })
    expect(await window.request('projects.list', undefined)).toEqual([])
    expect(await ids(window)).toEqual([])
    const items = (await window.request('bin.list', undefined)).items
    expect(
      items.map((item) => [item.key, item.count ?? null, item.project ?? null]).sort(),
    ).toEqual(
      [
        [`project:${project!.path}`, 1, null],
        [`session:${alone}`, 0, 'binned'],
      ].sort(),
    )

    // A session whose project is in the bin waits for the user's choice.
    expect(await window.request('bin.restore', { keys: [`session:${alone}`] })).toEqual({
      restored: [],
      held: [{ key: `session:${alone}`, projectPath: project!.path, project: 'binned' }],
    })
    const both = await window.request('bin.restore', {
      keys: [`session:${alone}`],
      project: 'restore',
    })
    expect(both.restored.sort()).toEqual([`project:${project!.path}`, `session:${alone}`].sort())
    expect((await window.request('projects.list', undefined)).map((p) => p.path)).toEqual([
      project!.path,
    ])
    expect((await ids(window)).sort()).toEqual([alone, kept].sort())
    expect(await keys(window)).toEqual([])
  })

  it('puts a session under No project when its project went for good', async () => {
    const host = await started()
    const window = host.connect()
    const id = await prompted(window, host.project)
    await window.request('sessions.delete', { sessionId: id })
    const [project] = await window.request('projects.list', undefined)
    await window.request('projects.remove', { path: project!.path })
    await window.request('bin.purge', { keys: [`project:${project!.path}`] })
    expect((await window.request('bin.list', undefined)).items).toMatchObject([
      { key: `session:${id}`, project: 'gone' },
    ])
    await window.request('bin.restore', { keys: [`session:${id}`], project: 'noProject' })
    expect(await window.request('projects.list', undefined)).toEqual([])
    const summary = (await window.request('sessions.list', {})).find((s) => s.id === id)
    expect(summary).toMatchObject({ scratch: true, projectPath: project!.path })
  })

  it('takes a routine off its schedule into the bin and back', async () => {
    const host = await started()
    const window = host.connect()
    const routine = await window.request('routines.create', {
      name: 'Morning',
      prompt: 'Summarize',
      agentId: 'fake-agent',
      projectPath: null,
      options: [],
      trigger: { kind: 'schedule', schedule: { kind: 'weekly', days: [1], time: '09:00' } },
      scope: { level: 'read', web: false },
      timeLimitMinutes: 60,
      keptRunSessions: 100,
    })
    await window.request('routines.delete', { routineId: routine.id })
    expect((await window.request('routines.list', undefined)).routines).toEqual([])
    await expect(window.request('routines.runNow', { routineId: routine.id })).rejects.toThrow()
    expect(await keys(window)).toEqual([`routine:${routine.id}`])
    await window.request('bin.restore', { keys: [`routine:${routine.id}`] })
    expect((await window.request('routines.list', undefined)).routines).toMatchObject([
      { id: routine.id, name: 'Morning', enabled: true },
    ])
    await window.request('routines.delete', { routineId: routine.id })
    await window.request('bin.empty', undefined)
    expect(await keys(window)).toEqual([])
    await expect(
      window.request('bin.restore', { keys: [`routine:${routine.id}`] }),
    ).resolves.toEqual({ restored: [], held: [] })
  })

  it('lets a paired phone list, restore and delete for good', async () => {
    const host = await started()
    const window = host.connect()
    const id = await prompted(window, host.project)
    await window.request('sessions.delete', { sessionId: id })
    const phone = host.connect({ id: 'phone', name: 'Phone' })
    expect(await keys(phone)).toEqual([`session:${id}`])
    await phone.request('bin.restore', { keys: [`session:${id}`] })
    expect(await ids(window)).toContain(id)
    await phone.request('sessions.delete', { sessionId: id })
    await phone.request('bin.purge', { keys: [`session:${id}`] })
    expect(await keys(window)).toEqual([])
    await expect(phone.request('bin.purge', { keys: ['nothing:1'] })).rejects.toThrow()
  })
})
