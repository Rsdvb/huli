import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestHost, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

// A host starts and restarts; a busy machine takes longer than the 5 s default.
vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []
let dir: string | null = null

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  dir = null
})

it("reads a review prompt's findings, acts on them and keeps them across a restart", async () => {
  dir = await tempFolder('kite-review-')
  const first = await startTestHost({ userDataPath: dir, sessionTimings: { checkpointMs: 10 } })
  hosts.push(first)
  await writeFile(path.join(first.project, 'a.ts'), 'const a = 1\nconst b = a\n')
  const window = first.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: first.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  const started = await window.request('sessions.reviewStart', { sessionId: id })
  expect(started).toMatchObject({ source: 'prompt', mode: 'inline', status: 'running' })
  await expect(window.request('sessions.reviewStart', { sessionId: id })).rejects.toMatchObject({
    code: 'busy',
  })
  await window.until(() => window.thread(id).session.review?.status === 'done')
  const done = window.thread(id).session.review!
  expect(done.id).toBe(started.id)
  expect(done.dropped).toBe(1)
  expect(done.findings).toEqual([
    {
      id: 'f1',
      severity: 'high',
      title: 'Line 1 of a.ts looks wrong',
      body: 'The value is used before it is checked, so an empty one throws. Check it first.',
      path: 'a.ts',
      start: 1,
      end: 2,
      anchor: 'const a = 1',
      state: 'open',
    },
  ])
  // The prompt is Kite's, never the user's.
  const prompt = window.entries(id).find((entry) => entry.kind === 'user')
  expect(prompt).toMatchObject({ kettu: true })

  const dismissed = await window.request('sessions.reviewAct', {
    sessionId: id,
    reviewId: done.id,
    findingIds: ['f1'],
    action: 'dismiss',
  })
  expect(dismissed.findings[0]!.state).toBe('dismissed')
  await expect(
    window.request('sessions.reviewAct', {
      sessionId: id,
      reviewId: 'other',
      findingIds: ['f1'],
      action: 'fix',
    }),
  ).rejects.toMatchObject({ code: 'not_found' })

  await window.request('sessions.reviewAct', {
    sessionId: id,
    reviewId: done.id,
    findingIds: ['f1'],
    action: 'fix',
  })
  await window.until(() => window.thread(id).session.review?.findings[0]?.state === 'sent')
  await window.untilEntry(
    id,
    (entry) =>
      entry.kind === 'user' &&
      !entry.kettu &&
      entry.content.some((part) => part.type === 'text' && part.text.includes('a.ts:1-2')),
  )
  await window.untilStatus(id, 'ready')
  const kept = window.thread(id).session.review
  await first.stop()
  hosts.splice(0)

  const second = await startTestHost({ userDataPath: dir, sessionTimings: { checkpointMs: 10 } })
  hosts.push(second)
  const opened = await second.connect().open(id)
  expect(opened.session.review).toEqual(kept)
  expect(await second.connect().request('sessions.review', { sessionId: id })).toEqual(kept)
})

it('fails a review whose reply holds no findings block, and ends it as failed', async () => {
  const host = await startTestHost()
  hosts.push(host)
  await writeFile(path.join(host.project, 'a.ts'), '/review-garbage\n')
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.reviewStart', { sessionId: id })
  await window.until(() => window.thread(id).session.review?.status === 'failed')
  expect(window.thread(id).session.review).toMatchObject({
    findings: [],
    error: expect.any(String),
  })
})
