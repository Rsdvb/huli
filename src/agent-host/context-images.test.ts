import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { startTestHost, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

// A host starts, runs a session and starts again; a busy machine takes longer than 5 s.
vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []
let dir: string | null = null

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  dir = null
})

/** The base64 lengths of the screenshots the tool calls returned, in order. */
function shots(entries: readonly ThreadEntry[]): number[] {
  return entries.flatMap((entry) =>
    entry.kind === 'tool'
      ? entry.content.flatMap((item) =>
          item.type === 'ref' && item.ref.kind === 'image' && 'data' in item.ref
            ? [item.ref.data.length]
            : [],
        )
      : [],
  )
}

const QUARTER = 900_000

it('counts the images in the context and what each request carried, across a restart', async () => {
  dir = await tempFolder('kettu-context-images-')
  const first = await startTestHost({ userDataPath: dir, sessionTimings: { checkpointMs: 10 } })
  hosts.push(first)
  const window = first.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: first.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/image-context --shots 3' }],
  })
  await window.untilEntry(id, (entry) => entry.kind === 'turn_end')
  await window.untilStatus(id, 'ready')
  const [a, b, c] = shots(window.entries(id)) as [number, number, number]
  // Each screenshot's request carried it and those before it.
  const counted = { count: 3, bytes: a + b + c, sent: 6, sentBytes: 3 * a + 2 * b + c }
  expect(window.thread(id).session.images).toEqual(counted)

  // Kite's record keeps the turn's images with its usage.
  const from = Math.floor((Date.now() - 3_600_000) / QUARTER) * QUARTER
  const to = from + 4 * 3_600_000
  let recorded: { images?: number; imageBytes?: number } | undefined
  for (let i = 0; i < 100 && !recorded; i++) {
    const summary = await window.request('usage.summary', {
      dayStarts: [from, to],
      from,
      to,
      scope: 'kettu',
    })
    recorded = summary.days.find((day) => (day.images ?? 0) > 0)
    if (!recorded) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  expect(recorded).toMatchObject({ images: 6, imageBytes: counted.sentBytes })
  await first.stop()
  hosts.splice(0)

  // Stored with the session, and counted again from the sizes the store keeps once it goes live.
  const second = await startTestHost({ userDataPath: dir, sessionTimings: { checkpointMs: 10 } })
  hosts.push(second)
  const again = second.connect()
  const opened = await again.open(id)
  expect(opened.session.images).toEqual(counted)
  // A turn whose agent reports no request of its own still made one, which carried them all.
  await again.request('sessions.prompt', { sessionId: id, content: [{ type: 'text', text: 'hi' }] })
  await again.until(() => (again.thread(id).session.images?.sent ?? 0) > counted.sent)
  await again.untilStatus(id, 'ready')
  const later = { ...counted, sent: 9, sentBytes: counted.sentBytes + counted.bytes }
  expect(again.thread(id).session.images).toEqual(later)
  await again.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/compact' }],
  })
  await again.untilEntry(id, (entry) => entry.kind === 'compaction' && entry.status === 'completed')
  // The compaction dropped them; what the requests carried stays.
  await again.until(() => again.thread(id).session.images?.count === 0)
  expect(again.thread(id).session.images).toEqual({ ...later, count: 0, bytes: 0 })
})
