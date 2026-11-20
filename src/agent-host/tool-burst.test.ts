// A turn of many fast tool calls: every port that watches it rebuilds the thread the host holds
// and stores, while what the turn does reaches the summaries a few times a second, not per call.

import { afterEach, expect, it } from 'vitest'
import type { HostEvent, SessionSummary } from '@shared/agent-host'
import { startTestHost, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const CALLS = 80
// The summary's `WORK_MS` in sessions.ts.
const WORK_MS = 500

function summariesOf(events: readonly HostEvent[], sessionId: string): SessionSummary[] {
  return events.flatMap((event) =>
    event.type === 'session.summary' && event.summary.id === sessionId ? [event.summary] : [],
  )
}

it('rebuilds and stores the thread of a burst, and sends its work at most every 500 ms', async () => {
  const dir = await tempFolder('kite-burst-')
  // The fake agent's own pace, so the turn outlasts a few of the summary's waits.
  const agentEnv = { FAKE_AGENT_DELAY_SCALE: '1' }
  const first = await startTestHost({ userDataPath: dir, agentEnv })
  hosts.push(first)
  const window = first.connect()
  const phone = first.connect({ id: 'phone', name: 'Phone', imageRefs: true })
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: first.project,
  })
  await window.open(id)
  await phone.open(id)
  await window.untilStatus(id, 'ready')

  const from = window.events.length
  const started = Date.now()
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: `/tool-storm --count ${CALLS} --pace 5` }],
  })
  await window.untilStatus(id, 'running')
  await window.untilStatus(id, 'ready')
  const elapsed = Date.now() - started
  await phone.until(() => phone.summary(id)?.status === 'ready')

  const held = await window.request('sessions.snapshot', { sessionId: id, from: 0 })
  expect(held.entries.filter((entry) => entry.kind === 'tool')).toHaveLength(CALLS)
  expect(window.entries(id)).toEqual(held.entries)
  expect(phone.entries(id)).toEqual(held.entries)

  // Each call changes what the turn does several times; the summaries say it far less often.
  const summaries = summariesOf(window.events.slice(from), id)
  let changes = 0
  for (let i = 1; i < summaries.length; i++) {
    const [before, after] = [summaries[i - 1]!.working, summaries[i]!.working]
    if (before && after && JSON.stringify(before) !== JSON.stringify(after)) changes++
  }
  expect(changes).toBeLessThanOrEqual(Math.ceil(elapsed / WORK_MS) + 2)
  expect(summaries.at(-1)).toMatchObject({ status: 'ready', working: null })

  await first.stop()
  const second = await startTestHost({ userDataPath: dir, agentEnv })
  hosts.push(second)
  const stored = await second.connect().request('sessions.snapshot', { sessionId: id, from: 0 })
  expect(stored.entries).toEqual(held.entries)
}, 60_000)
