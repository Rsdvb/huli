import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost } from './testing/harness'
import { inThreadWorker } from './testing/thread-worker'
import type { ThreadWrite } from './threads/model'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

/**
 * A Codex session with a turn for each text, a message and its reply, and the threads it stored;
 * `work` runs as each turn does, as its agent's edits.
 */
async function twoTurns(
  texts: readonly string[] = ['one', 'two'],
  work?: (text: string, folder: string) => Promise<void>,
) {
  const server = new FakeAppServer()
  const writes: ThreadWrite[] = []
  // Each turn of the session's thread answers at once, and Codex's history keeps it.
  server.on('turn/start', (params, self) => {
    const threadId = params.threadId as string
    const turnId = self.nextTurnId()
    const input = params.input as { text?: string }[]
    const text = input.at(-1)?.text ?? ''
    const history = self.history.get(threadId) ?? []
    const user = { type: 'userMessage', id: `u-${turnId}`, content: [] } as const
    const reply = { type: 'agentMessage', id: `msg-${turnId}`, text: `re: ${text}` } as const
    self.history.set(threadId, [
      ...history,
      { turnId, item: user as never },
      { turnId, item: reply as never },
    ])
    setTimeout(async () => {
      await work?.(text, host.project)
      self.notify('item/completed', { threadId, turnId, item: { ...reply, phase: 'final_answer' } })
      self.notify('turn/completed', { threadId, turn: turn(turnId, 'completed') })
    }, 0)
    return { turn: turn(turnId) }
  })
  const host = await startTestHost({
    fakeAppServer: server,
    sessionTimings: { checkpointMs: 10 },
    threadWorker: (data) => {
      const worker = inThreadWorker(data)
      return {
        ...worker,
        postMessage: (request) => {
          if (request.op === 'write') writes.push(structuredClone(request.change))
          worker.postMessage(request)
        },
      }
    },
  })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'codex',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  for (const text of texts) {
    await window.request('sessions.prompt', { sessionId: id, content: [{ type: 'text', text }] })
    await window.untilEntry(id, (e) => e.kind === 'agent' && e.markdown === `re: ${text}`)
    await window.untilStatus(id, 'ready')
  }
  return { server, window, id, writes, project: () => host.project }
}

const said = (entries: ThreadEntry[]): string[] =>
  entries.flatMap((entry) => {
    if (entry.kind === 'agent') return [entry.markdown]
    if (entry.kind === 'user')
      return entry.content.flatMap((c) => (c.type === 'text' ? c.text : []))
    return []
  })

it('takes the latest turn out of Codex’s history, the thread and the stored thread', async () => {
  const { server, window, id, writes } = await twoTurns()
  const thread = window.thread(id)
  const message = window
    .entries(id)
    .filter((entry) => entry.kind === 'user')
    .at(-1)!
  const threadId = thread.session.acpSessionId!
  const [, secondTurn] = new Set(server.history.get(threadId)!.map((entry) => entry.turnId))
  const before = writes.length

  await window.request('sessions.revert', { sessionId: id, entryId: message.id })

  expect(server.sent('thread/revert')).toEqual([{ threadId, beforeTurnId: secondTurn }])
  expect(server.history.get(threadId)?.map((entry) => entry.item.id)).toHaveLength(2)
  await vi.waitFor(() => expect(said(window.entries(id))).toEqual(['one', 're: one']))
  // The store keeps no way to drop entries, so the thread is written whole without the turn.
  await vi.waitFor(() => expect(writes.slice(before).some((write) => write.replace)).toBe(true))
  const stored = writes.slice(before).find((write) => write.replace)!
  expect(said(stored.entries.map((positioned) => positioned.entry))).toEqual(['one', 're: one'])
})

it('undoes only the latest turn', async () => {
  const { server, window, id } = await twoTurns()
  const first = window.entries(id).find((entry) => entry.kind === 'user')!
  await expect(
    window.request('sessions.revert', { sessionId: id, entryId: first.id }),
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(server.sent('thread/revert')).toEqual([])
  expect(said(window.entries(id))).toEqual(['one', 're: one', 'two', 're: two'])
})

const userIds = (window: Awaited<ReturnType<typeof twoTurns>>['window'], id: string): string[] =>
  window
    .entries(id)
    .filter((entry) => entry.kind === 'user')
    .map((entry) => entry.id)

it('restores the files a message found, refuses a stale preview, and undoes the restore', async () => {
  const { server, window, id, project } = await twoTurns(['one'], async (text, folder) => {
    // What each turn's agent writes, after the checkpoint of its message.
    await writeFile(path.join(folder, 'notes.md'), `after ${text}\n`)
  })
  await writeFile(path.join(project(), 'notes.md'), 'before two\n')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'two' }],
  })
  await window.untilEntry(id, (e) => e.kind === 'agent' && e.markdown === 're: two')
  await window.untilStatus(id, 'ready')
  const [, second] = userIds(window, id)
  const preview = await window.request('sessions.rewindPreview', {
    sessionId: id,
    entryId: second!,
  })
  expect(preview.files).toMatchObject({
    state: 'ready',
    folders: [{ changes: [{ path: 'notes.md', action: 'restore', insertions: 1, deletions: 1 }] }],
  })
  const token = preview.files.state === 'ready' ? preview.files.token : ''
  await writeFile(path.join(project(), 'later.md'), 'written after the preview\n')
  await expect(
    window.request('sessions.restoreFiles', { sessionId: id, entryId: second!, token }),
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(await readFile(path.join(project(), 'notes.md'), 'utf8')).toBe('after two\n')
  const fresh = await window.request('sessions.rewindPreview', {
    sessionId: id,
    entryId: second!,
  })
  const done = await window.request('sessions.restoreFiles', {
    sessionId: id,
    entryId: second!,
    token: fresh.files.state === 'ready' ? fresh.files.token : '',
  })
  expect(done).toMatchObject({ restored: 2, failed: 0 })
  expect(await readFile(path.join(project(), 'notes.md'), 'utf8')).toBe('before two\n')
  await window.request('sessions.undoRewindFiles', { sessionId: id, backup: done.backup! })
  expect(await readFile(path.join(project(), 'notes.md'), 'utf8')).toBe('after two\n')
  expect(server.sent('thread/revert')).toEqual([])
})
