// Huli: lean threads for remote clients. A lean page carries what folded steps show and names a
// live thread's screenshots by hash, `sessions.entry` and `sessions.blob` read the rest on demand,
// a thread the reader holds comes back without its entries, and sub-agents' rows read their counts
// with `sessions.stats` rather than whole threads.

import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostEvent } from '@shared/agent-host'
import type {
  ContentRef,
  DigestedSnapshot,
  DigestedToolEntry,
  SessionSnapshot,
  ThreadEntry,
  ToolEntry,
} from '@shared/thread'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'
import { DIGEST_INPUT_BYTES, LEAN_TITLE_CHARS } from './threads/digest'
import { INLINE_MEDIA_LIMIT } from './threads/model'

// Two hosts start and restart, with turns of a few MB; a busy machine needs more than 5 s.
vi.setConfig({ testTimeout: 120_000 })

const hosts: TestHost[] = []
let dir: string | null = null

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  dir = null
})

// `KITE_MEASURE_LEAN=1` plays a thread the size of the one that froze the phone and prints bytes.
const MEASURE = process.env.KITE_MEASURE_LEAN === '1'
const CALLS = MEASURE ? 740 : 24
const SHOTS = 4
const PHONE = {
  id: 'b'.repeat(32),
  name: 'Phone',
  imageRefs: true as const,
  toolDigests: true as const,
}
const AGENT_ENV = { FAKE_AGENT_DELAY_SCALE: '0' }

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
const tools = (entries: readonly unknown[]): DigestedToolEntry[] =>
  (entries as ThreadEntry[]).filter((e): e is ToolEntry => e.kind === 'tool') as DigestedToolEntry[]

function imagesIn(value: unknown, found: ContentRef[] = []): ContentRef[] {
  if (Array.isArray(value)) for (const item of value) imagesIn(item, found)
  else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    if (record.kind === 'image') found.push(record as ContentRef)
    for (const item of Object.values(record)) imagesIn(item, found)
  }
  return found
}

/** A session that ran the heavy-tools scenario to its end, watched by the window. */
async function heavySession(host: TestHost, window: TestPort, count = CALLS): Promise<string> {
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: `/heavy-tools --count ${count} --shots ${SHOTS} --pace 0` }],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  return id
}

it('gives a lean page what folded steps show, and the rest on demand', async () => {
  dir = await tempFolder('kite-lean-')
  // No checkpoint while the test runs: the screenshots stay in the live thread alone.
  const host = await startTestHost({
    userDataPath: dir,
    agentEnv: AGENT_ENV,
    sessionTimings: { checkpointMs: 600_000 },
  })
  hosts.push(host)
  const window = host.connect()
  const phone = host.connect(PHONE)
  const id = await heavySession(host, window)

  const full = await window.request('sessions.snapshot', { sessionId: id, from: 0 })
  const lean = (await phone.request('sessions.snapshot', {
    sessionId: id,
    from: 0,
    lean: true,
  })) as DigestedSnapshot
  const old = await host
    .connect({ id: 'c'.repeat(32), name: 'Old phone' })
    .request('sessions.snapshot', { sessionId: id, from: 0 })
  if (MEASURE) {
    console.log(
      `thread of ${full.entries.length} entries: window ${bytes(full)} B, device without image ` +
        `refs ${bytes(old)} B, lean ${bytes(lean)} B`,
    )
  }
  expect(tools(full.entries)).toHaveLength(CALLS)
  expect(tools(lean.entries)).toHaveLength(CALLS)
  expect(bytes(lean)).toBeLessThan(bytes(full) / 20)

  const shots = imagesIn(full.entries)
  expect(shots).toHaveLength(CALLS / SHOTS)
  for (const [i, step] of tools(lean.entries).entries()) {
    const whole = tools(full.entries)[i]!
    expect(step.id).toBe(whole.id)
    const item = step.content[0]!
    if (item.type === 'ref') {
      // A screenshot comes by the hash the thread store keeps its bytes under.
      expect(item.ref).toEqual({ kind: 'image', mimeType: 'image/jpeg', blob: expect.any(String) })
      continue
    }
    expect(item).toMatchObject({ type: 'digest', of: 'markdown' })
    if (item.type !== 'digest' || item.of !== 'markdown') throw new Error('not a digest')
    const output = (whole.content[0] as { markdown: string }).markdown
    expect(item.size).toBe(Buffer.byteLength(output))
    expect(output.startsWith(item.head!)).toBe(true)
    expect(output.endsWith(item.tail!)).toBe(true)
    expect(Buffer.byteLength(item.head!) + Buffer.byteLength(item.tail!)).toBeLessThan(1024)
    // A long command's title is cut, and its input digested past the digests' limit.
    expect(step.title).toHaveLength(LEAN_TITLE_CHARS + 1)
    expect(step.titleSize).toBe(Buffer.byteLength(whole.title))
    if (Buffer.byteLength(whole.rawInput!) > DIGEST_INPUT_BYTES) {
      expect(step).not.toHaveProperty('rawInput')
      expect(step.rawInputDigest?.size).toBe(Buffer.byteLength(whole.rawInput!))
    } else {
      expect(step.rawInput).toBe(whole.rawInput)
    }
  }

  // The whole step, and a screenshot's bytes before any checkpoint stored them.
  const step = tools(full.entries)[0]!
  expect(await phone.request('sessions.entry', { sessionId: id, entryId: step.id })).toEqual(step)
  const shot = tools(lean.entries).find((entry) => entry.content[0]?.type === 'ref')!
  const ref = (shot.content[0] as { ref: { blob: string } }).ref
  const blob = await phone.request('sessions.blob', { sessionId: id, hash: ref.blob })
  const original = imagesIn(tools(full.entries).find((entry) => entry.id === shot.id))[0]!
  expect(Buffer.from(blob.bytes).toString('base64')).toBe((original as { data: string }).data)

  // A device without image refs still gets the bytes; a window gets them as before.
  expect(imagesIn(old.entries).every((image) => 'data' in image)).toBe(true)
  expect(shots.every((image) => 'data' in image)).toBe(true)

  // A page without `lean` is as the port's features make it: digests, no preview or cut title.
  const digested = (await phone.request('sessions.snapshot', {
    sessionId: id,
    from: 0,
  })) as DigestedSnapshot
  const plain = tools(digested.entries).find((entry) => entry.content[0]?.type === 'digest')!
  expect(plain.content[0]).not.toHaveProperty('head')
  expect(plain).not.toHaveProperty('titleSize')
})

it('names a live screenshot by hash in the patches a device that reads them gets', async () => {
  dir = await tempFolder('kite-lean-patches-')
  const host = await startTestHost({ userDataPath: dir, agentEnv: AGENT_ENV })
  hosts.push(host)
  const window = host.connect()
  const phone = host.connect(PHONE)
  const old = host.connect({ id: 'c'.repeat(32), name: 'Old phone' })
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  for (const port of [window, phone, old]) await port.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: `/heavy-tools --count 8 --shots 4 --pace 0` }],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  await phone.until(() => phone.summary(id)?.status === 'ready')
  await old.until(() => old.summary(id)?.status === 'ready')

  const patches = (port: TestPort) =>
    port.events.filter((event: HostEvent) => event.type === 'session.patches')
  const large = (images: ContentRef[]) =>
    images.filter((image) => 'data' in image && image.data.length > INLINE_MEDIA_LIMIT)
  expect(large(imagesIn(patches(window)))).toHaveLength(2)
  expect(large(imagesIn(patches(old)))).toHaveLength(2)
  expect(large(imagesIn(patches(phone)))).toHaveLength(0)
  const named = imagesIn(patches(phone)).filter((image) => 'blob' in image)
  expect(named).toHaveLength(2)
  for (const image of named) {
    const blob = await phone.request('sessions.blob', {
      sessionId: id,
      hash: (image as { blob: string }).blob,
    })
    expect(blob.bytes.byteLength).toBeGreaterThan(INLINE_MEDIA_LIMIT / 2)
  }
})

it('leaves out the entries of a thread the reader holds as it is', async () => {
  dir = await tempFolder('kite-lean-known-')
  const first = await startTestHost({ userDataPath: dir, agentEnv: AGENT_ENV })
  hosts.push(first)
  const window = first.connect()
  const phone = first.connect(PHONE)
  const id = await heavySession(first, window, 4)

  const opened = (await phone.request('sessions.open', { sessionId: id, lean: true })) as
    SessionSnapshot | DigestedSnapshot
  expect(opened.epoch).toEqual(expect.any(String))
  expect(opened.unchanged).toBeUndefined()
  const known = { epoch: opened.epoch!, seq: opened.seq }
  const again = await phone.request('sessions.snapshot', { sessionId: id, lean: true, known })
  expect(again).toMatchObject({ unchanged: true, entries: [], seq: opened.seq })
  expect(again.session.id).toBe(id)
  expect(bytes(again)).toBeLessThan(bytes(opened))
  expect(await phone.request('sessions.open', { sessionId: id, known })).toMatchObject({
    unchanged: true,
  })

  // Another epoch, another seq, or a turn since: the entries come.
  for (const other of [
    { ...known, epoch: `${known.epoch}x` },
    { ...known, seq: known.seq + 1 },
  ]) {
    const read = await phone.request('sessions.snapshot', { sessionId: id, known: other })
    expect(read.unchanged).toBeUndefined()
    expect(read.entries.length).toBeGreaterThan(0)
  }
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'hello' }],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  const after = await phone.request('sessions.snapshot', { sessionId: id, known })
  expect(after.unchanged).toBeUndefined()
  expect(after.seq).toBeGreaterThan(known.seq)

  // A restart starts another copy of every thread: what a reader held is read again.
  const latest = { epoch: after.epoch!, seq: after.seq }
  await first.stop()
  hosts.splice(0)
  const second = await startTestHost({ userDataPath: dir, agentEnv: AGENT_ENV })
  hosts.push(second)
  const device = second.connect(PHONE)
  const stored = await device.request('sessions.snapshot', { sessionId: id, known: latest })
  expect(stored.unchanged).toBeUndefined()
  expect(stored.entries.length).toBeGreaterThan(0)
  const storedKnown = { epoch: stored.epoch!, seq: stored.seq }
  expect(
    await device.request('sessions.snapshot', { sessionId: id, from: 0, known: storedKnown }),
  ).toMatchObject({ unchanged: true, entries: [] })
})

it("tells sub-agents' rows their tool calls and latest run, live and stored", async () => {
  dir = await tempFolder('kite-lean-stats-')
  const first = await startTestHost({ userDataPath: dir, agentEnv: AGENT_ENV })
  hosts.push(first)
  const window = first.connect()
  const phone = first.connect(PHONE)
  const id = await heavySession(first, window, 6)
  const other = await heavySession(first, window, 2)

  const live = await phone.request('sessions.stats', { sessionIds: [id, other, 'gone'] })
  expect(Object.keys(live).sort()).toEqual([id, other].sort())
  expect(live[id]).toEqual({ tools: 6, durationMs: expect.any(Number), stopReason: 'end_turn' })
  expect(live[other]?.tools).toBe(2)

  await first.stop()
  hosts.splice(0)
  const second = await startTestHost({ userDataPath: dir, agentEnv: AGENT_ENV })
  hosts.push(second)
  const stored = await second.connect(PHONE).request('sessions.stats', { sessionIds: [id] })
  expect(stored).toEqual({ [id]: live[id] })
})

it("reads a device an entry only of the session it names, and that session's own", async () => {
  dir = await tempFolder('kite-lean-entry-')
  const host = await startTestHost({ userDataPath: dir, agentEnv: AGENT_ENV })
  hosts.push(host)
  const window = host.connect()
  const phone = host.connect(PHONE)
  const id = await heavySession(host, window, 2)
  const other = await heavySession(host, window, 3)
  // The third step, which the first session has no step of the same id as.
  const step = tools(
    (await window.request('sessions.snapshot', { sessionId: other, from: 0 })).entries,
  )[2]!

  await expect(
    phone.request('sessions.entry', { sessionId: other, entryId: step.id }),
  ).resolves.toMatchObject({ id: step.id })
  await expect(
    phone.request('sessions.entry', { sessionId: id, entryId: step.id }),
  ).rejects.toMatchObject({ code: 'not_found' })
  await expect(
    phone.request('sessions.entry', { sessionId: 'nope', entryId: step.id }),
  ).rejects.toMatchObject({ code: 'not_found' })
  await expect(
    phone.request('sessions.blob', { sessionId: id, hash: 'a'.repeat(64) }),
  ).rejects.toMatchObject({ code: 'not_found' })
})
