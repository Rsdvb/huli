// Huli: a session deleted in Kite whose agent keeps its own copy, as Doubao CLI and an ACP agent
// without `session/delete` do, is not offered by either import again, across restarts, until it
// is imported by its id.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DeletedSessions,
  MAX_DELETED_SESSIONS,
  deletedSessionsFile,
  parseDeletedSessionsFile,
} from './deleted-sessions'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const log = () => {}

describe('the deleted sessions file', () => {
  it('keeps what was added past a restart, and forgets one taken back', async () => {
    const dir = await tempFolder('kite-deleted-')
    const first = new DeletedSessions(deletedSessionsFile(dir, log), () => 7)
    await first.load()
    first.add('doubao', '10000000000025552')
    first.add('fake-agent', 'fake-1')
    first.add('fake-agent', 'fake-2')
    first.forget('fake-agent', 'fake-2')
    await first.flush()
    const again = new DeletedSessions(deletedSessionsFile(dir, log))
    await again.load()
    expect(again.has('doubao', '10000000000025552')).toBe(true)
    expect(again.has('fake-agent', 'fake-1')).toBe(true)
    expect(again.has('fake-agent', 'fake-2')).toBe(false)
    // The same id of another agent is another session.
    expect(again.has('doubao', 'fake-1')).toBe(false)
    expect(again.idsOf(['fake-agent', 'codex'])).toEqual(new Set(['fake-1']))
    const written = JSON.parse(
      await readFile(path.join(dir, 'state', 'deleted-sessions.json'), 'utf8'),
    ) as unknown
    expect(written).toEqual({
      version: 1,
      sessions: [
        { agentId: 'doubao', acpSessionId: '10000000000025552', at: 7 },
        { agentId: 'fake-agent', acpSessionId: 'fake-1', at: 7 },
      ],
    })
  })

  it('reads past malformed and repeated entries, and keeps the newest when there are too many', () => {
    expect(parseDeletedSessionsFile({ sessions: 'no' })).toBe('sessions is not a list')
    const parsed = parseDeletedSessionsFile({
      sessions: [
        { agentId: 'doubao', acpSessionId: 'a', at: 1 },
        { agentId: 'doubao', acpSessionId: 'a', at: 2 },
        { agentId: 'not an id!', acpSessionId: 'b', at: 1 },
        { agentId: 'doubao', acpSessionId: '', at: 1 },
        { agentId: 'doubao', acpSessionId: 'c' },
        null,
      ],
    })
    expect(parsed).toEqual({
      version: 1,
      sessions: [
        { agentId: 'doubao', acpSessionId: 'a', at: 1 },
        { agentId: 'doubao', acpSessionId: 'c', at: 0 },
      ],
    })
    const many = parseDeletedSessionsFile({
      sessions: Array.from({ length: MAX_DELETED_SESSIONS + 5 }, (_, n) => ({
        agentId: 'doubao',
        acpSessionId: `s${n}`,
        at: n,
      })),
    })
    expect(typeof many === 'object' && many.sessions.length).toBe(MAX_DELETED_SESSIONS)
    expect(typeof many === 'object' && many.sessions[0]!.acpSessionId).toBe('s5')
  })
})

async function promptedSession(window: TestPort, project: string): Promise<[string, string]> {
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
  const acp = window.summary(id)?.acpSessionId
  if (!acp) throw new Error('The session has no agent session')
  return [id, acp]
}

describe('deleting a session whose agent keeps it', () => {
  it('offers it in neither import again, until it is imported by its id', async () => {
    const dir = await tempFolder('kite-deleted-host-')
    const host = await startTestHost({
      userDataPath: dir,
      agentEnv: { FAKE_AGENT_WITHOUT: 'delete' },
    })
    hosts.push(host)
    const window = host.connect()
    const [id, acp] = await promptedSession(window, host.project)
    const sidebar = () =>
      window.request('agents.listSessions', { agentId: 'fake-agent', projectPath: host.project })
    const everywhere = () => window.request('agentHistory.list', { agentId: 'fake-agent' })
    expect((await sidebar()).sessions.find((s) => s.acpSessionId === acp)?.imported).toBe(true)

    await window.request('sessions.delete', { sessionId: id })

    // The fake agent still lists it, having no delete.
    expect((await sidebar()).sessions.some((s) => s.acpSessionId === acp)).toBe(false)
    expect((await everywhere()).sessions.some((s) => s.acpSessionId === acp)).toBe(false)
    expect((await sidebar()).sessions.length).toBeGreaterThan(0)

    const back = await window.request('sessions.import', {
      agentId: 'fake-agent',
      projectPath: host.project,
      acpSessionId: acp,
    })
    expect(back.acpSessionId).toBe(acp)
    expect((await sidebar()).sessions.find((s) => s.acpSessionId === acp)?.imported).toBe(true)
    await window.request('sessions.delete', { sessionId: back.id })
    // Huli: what the agent keeps is noted once the recycle bin deletes it for good.
    await window.request('bin.purge', { keys: [`session:${back.id}`] })
    expect((await sidebar()).sessions.some((s) => s.acpSessionId === acp)).toBe(false)
    await host.stop()
    const kept = JSON.parse(
      await readFile(path.join(dir, 'state', 'deleted-sessions.json'), 'utf8'),
    ) as { sessions: { agentId: string; acpSessionId: string }[] }
    expect(kept.sessions.map((s) => [s.agentId, s.acpSessionId])).toEqual([['fake-agent', acp]])
  })

  it('keeps nothing of one the agent deleted itself', async () => {
    const dir = await tempFolder('kite-deleted-host-')
    const host = await startTestHost({ userDataPath: dir })
    hosts.push(host)
    const window = host.connect()
    const [id] = await promptedSession(window, host.project)
    await window.request('sessions.delete', { sessionId: id })
    await window.request('bin.purge', { keys: [`session:${id}`] })
    await host.stop()
    const kept = await readFile(path.join(dir, 'state', 'deleted-sessions.json'), 'utf8').catch(
      () => null,
    )
    expect(kept).toBeNull()
  })
})
