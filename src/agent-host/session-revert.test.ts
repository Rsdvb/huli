import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { FakeAppServer, FakeRpcError, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost } from './testing/harness'
import { inThreadWorker } from './testing/thread-worker'
import type { ThreadWrite } from './threads/model'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

/** A Codex session with two turns, each a message and its reply, and the threads it stored. */
async function twoTurns(texts: readonly string[] = ['one', 'two']) {
  const server = new FakeAppServer()
  const writes: ThreadWrite[] = []
  // Each turn of the session's thread answers at once, and Codex's history keeps it.
  server.on('turn/start', (params, self) => {
    const threadId = params.threadId as string
    const turnId = self.nextTurnId()
    const text = (params.input as { text?: string }[])[0]?.text ?? ''
    const history = self.history.get(threadId) ?? []
    const user = { type: 'userMessage', id: `u-${turnId}`, content: [] } as const
    const reply = { type: 'agentMessage', id: `msg-${turnId}`, text: `re: ${text}` } as const
    self.history.set(threadId, [
      ...history,
      { turnId, item: user as never },
      { turnId, item: reply as never },
    ])
    setTimeout(() => {
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
  return { server, window, id, writes }
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

it('rewinds to an earlier message in Codex’s own history', async () => {
  const { server, window, id } = await twoTurns(['one', 'two', 'three'])
  const threadId = window.thread(id).session.acpSessionId!
  const turns = [...new Set(server.history.get(threadId)!.map((entry) => entry.turnId))]
  const [, second] = userIds(window, id)

  const preview = await window.request('sessions.rewindPreview', {
    sessionId: id,
    entryId: second!,
    mode: 'edit',
  })
  expect(preview).toMatchObject({ messages: 2, conversation: 'agent' })
  expect(server.sent('thread/revert')).toEqual([])

  await window.request('sessions.rewind', { sessionId: id, entryId: second!, mode: 'edit' })
  expect(server.sent('thread/revert')).toEqual([{ threadId, beforeTurnId: turns[1] }])
  await vi.waitFor(() => expect(said(window.entries(id))).toEqual(['one', 're: one']))
})

it('keeps the message and its reply when rewinding to it', async () => {
  const { server, window, id } = await twoTurns(['one', 'two', 'three'])
  const threadId = window.thread(id).session.acpSessionId!
  const turns = [...new Set(server.history.get(threadId)!.map((entry) => entry.turnId))]
  const [first] = userIds(window, id)
  await window.request('sessions.rewind', { sessionId: id, entryId: first!, mode: 'rewind' })
  expect(server.sent('thread/revert')).toEqual([{ threadId, beforeTurnId: turns[1] }])
  await vi.waitFor(() => expect(said(window.entries(id))).toEqual(['one', 're: one']))
  // Nothing comes after the latest message.
  await expect(
    window.request('sessions.rewind', { sessionId: id, entryId: first!, mode: 'rewind' }),
  ).rejects.toMatchObject({ code: 'invalid_params' })
})

it('starts over from the first message with a new session of the agent', async () => {
  const { server, window, id } = await twoTurns()
  const [first] = userIds(window, id)
  const preview = await window.request('sessions.rewindPreview', {
    sessionId: id,
    entryId: first!,
    mode: 'edit',
  })
  expect(preview).toMatchObject({ messages: 2, conversation: 'empty' })
  const started = server.sent('thread/start').length
  await window.request('sessions.rewind', { sessionId: id, entryId: first!, mode: 'edit' })
  expect(server.sent('thread/revert')).toEqual([])
  await vi.waitFor(() => expect(window.entries(id)).toEqual([]))
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'anew' }],
  })
  await window.untilEntry(id, (e) => e.kind === 'agent' && e.markdown === 're: anew')
  expect(server.sent('thread/start').length).toBe(started + 1)
})

it('carries the conversation kept to a new session when the agent cannot cut its own', async () => {
  const { server, window, id } = await twoTurns(['one', 'two', 'three'])
  server.on('thread/revert', () => {
    throw new FakeRpcError(-32600, 'thread/revert only supports paginated threads')
  })
  const [, second] = userIds(window, id)
  const started = server.sent('thread/start').length
  await window.request('sessions.rewind', { sessionId: id, entryId: second!, mode: 'edit' })
  await vi.waitFor(() => expect(said(window.entries(id))).toEqual(['one', 're: one']))
  const marker = window.entries(id).at(-1)
  expect(marker).toMatchObject({ kind: 'takeover', agentId: 'codex', rewound: true })
  const prompts = server.sent('turn/start').length
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'four' }],
  })
  await vi.waitFor(() => expect(server.sent('turn/start').length).toBe(prompts + 1))
  expect(server.sent('thread/start').length).toBe(started + 1)
  // The new session hears of the turn kept, in its history or ahead of the prompt.
  const heard = JSON.stringify([
    ...server.sent('thread/inject_items'),
    ...server.sent('turn/start'),
  ])
  expect(heard).toContain('re: one')
  expect(heard).not.toContain('re: two')
})

it('refuses a rewind while a turn runs', async () => {
  const { server, window, id } = await twoTurns()
  server.on('turn/start', (_params, self) => ({ turn: turn(self.nextTurnId()) }))
  const [first] = userIds(window, id)
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'slow' }],
  })
  await window.untilStatus(id, 'running')
  await expect(
    window.request('sessions.rewind', { sessionId: id, entryId: first!, mode: 'edit' }),
  ).rejects.toMatchObject({ code: 'busy' })
  expect(server.sent('thread/revert')).toEqual([])
})
