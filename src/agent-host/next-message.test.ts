// Huli: the next-message suggestions of agents without their own cost a request of the user's plan
// each turn, so they wait for their own switch; Claude Code's own follow the main switch alone.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpConnection } from './acp/connection'
import { SUGGEST_QUESTION, suggestionRoute, suggestsWith } from './next-message'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, testSettings, type TestHost, type TestPort } from './testing/harness'

const hosts: TestHost[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.stop()
})

describe('the way an agent suggests', () => {
  it('keeps Claude Code on its own suggestions, whatever it could do else', () => {
    for (const id of ['claude-code', 'claude-code~work'] as const) {
      expect(suggestionRoute(id, { forkSession: true }, true)).toBe('claude')
    }
    expect(suggestionRoute('codex', { forkSession: true }, false)).toBe('codex')
    expect(suggestionRoute('fake-agent', { forkSession: true }, false)).toBe('fork')
    expect(suggestionRoute('fake-agent', { forkSession: false }, true)).toBe('tool')
  })

  it('is on for Claude Code with the main switch, for the others only with both', () => {
    const off = { promptSuggestions: true, otherAgentSuggestions: false }
    const on = { promptSuggestions: true, otherAgentSuggestions: true }
    expect(suggestsWith('claude', off)).toBe(true)
    // A host whose parent is older than the second switch has none.
    expect(suggestsWith('claude', { promptSuggestions: true })).toBe(true)
    for (const route of ['codex', 'fork', 'tool'] as const) {
      expect(suggestsWith(route, off)).toBe(false)
      expect(suggestsWith(route, { promptSuggestions: true })).toBe(false)
      expect(suggestsWith(route, on)).toBe(true)
    }
    for (const route of ['claude', 'codex', 'fork', 'tool', null] as const) {
      expect(suggestsWith(route, { promptSuggestions: false, otherAgentSuggestions: true })).toBe(
        false,
      )
    }
    expect(suggestsWith(null, on)).toBe(false)
  })
})

async function prompt(window: TestPort, id: string, text: string): Promise<void> {
  await window.request('sessions.prompt', { sessionId: id, content: [{ type: 'text', text }] })
  await window.untilEntry(
    id,
    (entry) =>
      entry.kind === 'user' && entry.content.some((b) => b.type === 'text' && b.text === text),
  )
  await window.untilStatus(id, 'ready')
}

describe('a fake agent that forks its sessions', () => {
  async function session(otherAgentSuggestions: boolean) {
    const forks = vi.spyOn(AcpConnection.prototype, 'forkSession')
    const host = await startTestHost({
      settings: { ...testSettings(['fake-agent']), otherAgentSuggestions },
    })
    hosts.push(host)
    const window = host.connect()
    const { id } = await window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: host.project,
    })
    await window.open(id)
    await window.untilStatus(id, 'ready')
    return { forks, window, id }
  }

  it('asks no fork for a suggestion while the second switch is off', async () => {
    const { forks, window, id } = await session(false)
    await prompt(window, id, 'first')
    // A fork asked after the first turn would have been opened by the end of the second.
    await prompt(window, id, 'second')
    expect(forks).not.toHaveBeenCalled()
    expect(window.thread(id).session.suggestion ?? null).toBeNull()
  })

  it('asks a fork once a turn ends while it is on', async () => {
    const { forks, window, id } = await session(true)
    await prompt(window, id, 'first')
    await window.until(() => forks.mock.calls.length === 1)
  })
})

describe('Codex', () => {
  async function session(otherAgentSuggestions: boolean) {
    const server = new FakeAppServer()
    // Every turn answers at once, a suggestion's in its fork as the session's own.
    server.on('turn/start', (params, self) => {
      const threadId = params.threadId as string
      const turnId = self.nextTurnId()
      const input = params.input as { text?: string }[]
      const text = input.at(-1)?.text ?? ''
      const reply = { type: 'agentMessage', id: `msg-${turnId}`, text: `re: ${text}` } as const
      setTimeout(() => {
        self.notify('item/completed', {
          threadId,
          turnId,
          item: { ...reply, phase: 'final_answer' },
        })
        self.notify('turn/completed', { threadId, turn: turn(turnId, 'completed') })
      }, 0)
      return { turn: turn(turnId) }
    })
    const host = await startTestHost({
      fakeAppServer: server,
      settings: { ...testSettings(['fake-agent', 'codex']), otherAgentSuggestions },
    })
    hosts.push(host)
    const window = host.connect()
    const { id } = await window.request('sessions.create', {
      agentId: 'codex',
      projectPath: host.project,
    })
    await window.open(id)
    await window.untilStatus(id, 'ready')
    return { server, window, id }
  }

  const asked = (server: FakeAppServer): number =>
    server
      .sent('turn/start')
      .filter((params) =>
        (params.input as { text?: string }[]).some((input) =>
          input.text?.includes(SUGGEST_QUESTION),
        ),
      ).length

  it('forks no thread for a suggestion while the second switch is off', async () => {
    const { server, window, id } = await session(false)
    await prompt(window, id, 'first')
    // A fork asked once the turn ended would be opened before the fork of a side question after it.
    await window.request('sessions.sideAsk', { sessionId: id, question: 'Why?' })
    await window.until(() => window.thread(id).session.sideChat?.entries[0]?.status === 'answered')
    expect(server.sent('thread/fork')).toHaveLength(1)
    expect(asked(server)).toBe(0)
    expect(window.thread(id).session.suggestion ?? null).toBeNull()
  })

  it('forks the thread and asks it once a turn ends while it is on', async () => {
    const { server, window, id } = await session(true)
    await prompt(window, id, 'first')
    await server.until(() => asked(server) === 1)
    expect(server.sent('thread/fork')).toHaveLength(1)
    await window.until(() => (window.thread(id).session.suggestion ?? null) !== null)
  })
})
