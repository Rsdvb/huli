// Huli: forking a session of an agent that cannot fork, as Antigravity cannot: the fork is a new
// session of the same agent that starts from Kettu's copy of the thread, carried to the agent with
// its first prompt as a takeover's conversation is.

import { afterEach, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { startTestHost, type TestHost } from './testing/harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const userText = (entry: ThreadEntry): string =>
  entry.kind === 'user'
    ? entry.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''

it("forks from Kettu's copy of the thread when the agent cannot fork", async () => {
  const host = await startTestHost({ agentEnv: { FAKE_AGENT_WITHOUT: 'fork' } })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'remember the word pineapple' }],
  })
  await window.untilEntry(id, (entry) => entry.kind === 'agent')
  await window.untilStatus(id, 'ready')

  const fork = await window.request('sessions.fork', { sessionId: id })
  expect(fork.id).not.toBe(id)
  expect(fork.agentId).toBe('fake-agent')
  await window.open(fork.id)
  await window.untilEntry(fork.id, (entry) => entry.kind === 'takeover')
  const copied = window.entries(fork.id)
  expect(copied.some((entry) => userText(entry).includes('pineapple'))).toBe(true)

  await window.request('sessions.prompt', {
    sessionId: fork.id,
    content: [{ type: 'text', text: 'which word?' }],
  })
  await window.until(() =>
    window
      .entries(fork.id)
      .some((entry) => entry.kind === 'takeover' && entry.carried.includes('pineapple')),
  )
  // The source keeps its own thread, untouched by the fork's turn.
  expect(window.entries(id).some((entry) => userText(entry).includes('which word?'))).toBe(false)
})
