import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { handoffBase, handoffMessage, handoffReply, handoffTitle } from './handoff'
import { startTestHost, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

// A host starts, runs two sessions and starts again; a busy machine takes longer than 5 s.
vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

type UserEntry = Extract<ThreadEntry, { kind: 'user' }>

it('takes the summary from the reply after its request alone, never an earlier one', () => {
  const thread = {
    order: ['1', '2', '3', '4', '5'],
    byId: {
      '1': { kind: 'user', id: '1', content: [] },
      '2': { kind: 'agent', id: '2', markdown: 'Earlier reply', attachments: [], streaming: false },
      '3': { kind: 'user', id: '3', content: [], kettu: true },
      '4': { kind: 'agent', id: '4', markdown: 'Looking…', attachments: [], streaming: false },
      '5': {
        kind: 'agent',
        id: '5',
        markdown: '## Goal\nShip it',
        attachments: [],
        streaming: false,
      },
    },
  } as const satisfies { order: string[]; byId: Record<string, ThreadEntry> }
  expect(handoffReply(thread, '3')).toBe('## Goal\nShip it')
  expect(handoffReply({ ...thread, order: ['1', '2', '3'] }, '3')).toBeNull()
  expect(handoffReply(thread, 'gone')).toBeNull()
})

it('joins the summary in as written, and marks the title once', () => {
  const message = handoffMessage('Fix login', '  Goal: {{title}} $t(handoff.prompt)  ')
  expect(message).toContain('“Fix login”')
  expect(message).toContain('Goal: {{title}} $t(handoff.prompt)')
  expect(handoffTitle('Fix login')).toBe('Fix login (continued)')
  expect(handoffTitle(handoffTitle('Fix login'))).toBe('Fix login (continued)')
  expect(handoffBase('Fix login（续）')).toBe('Fix login')
})

it('hands a session off to a new one that starts from its summary, and keeps both linked', async () => {
  const dir = await tempFolder('kettu-handoff-')
  const first = await startTestHost({ userDataPath: dir, sessionTimings: { checkpointMs: 10 } })
  hosts.push(first)
  const window = first.connect()
  const { id: oldId } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: first.project,
  })
  await window.open(oldId)
  await window.untilStatus(oldId, 'ready')

  await window.request('sessions.handoff', { sessionId: oldId })
  // Kettu asks the agent for it in a message of its own, not the user's.
  const asked = window.entries(oldId).findLast((entry): entry is UserEntry => entry.kind === 'user')
  expect(asked?.kettu).toBe(true)
  // A second handoff waits for the first.
  await expect(window.request('sessions.handoff', { sessionId: oldId })).rejects.toThrow()

  await window.untilEntry(oldId, (entry) => entry.kind === 'session_started' && !!entry.handoff)
  const link = window
    .entries(oldId)
    .find((entry) => entry.kind === 'session_started' && entry.handoff)
  if (link?.kind !== 'session_started') throw new Error('No link to the new session')
  const newId = link.sessionId
  const summary = handoffReply(window.thread(oldId), asked!.id)
  expect(summary).not.toBeNull()

  await window.open(newId)
  const firstMessage = window
    .entries(newId)
    .find((entry): entry is UserEntry => entry.kind === 'user')
  expect(firstMessage?.from).toMatchObject({ sessionId: oldId, report: false, handoff: true })
  const text = firstMessage?.content[0]
  expect(text?.type === 'text' && text.text).toContain(summary!.trim())
  await window.untilStatus(newId, 'ready')

  // The old session stays where it was, idle and listed; the new one works in its folder.
  await window.until(() => window.summary(oldId)?.handedOffTo === newId)
  expect(window.summary(oldId)).toMatchObject({ status: 'ready', archivedAt: null })
  expect(window.summary(newId)).toMatchObject({
    handedOffFrom: oldId,
    projectPath: window.summary(oldId)!.projectPath,
    parentId: null,
    agentId: 'fake-agent',
  })
  // No report of the new session's turns goes back to the old one.
  expect(
    window.entries(oldId).filter((entry) => entry.kind === 'user' && entry.from?.ended),
  ).toEqual([])
  await first.stop()
  hosts.splice(0)

  const second = await startTestHost({ userDataPath: dir, sessionTimings: { checkpointMs: 10 } })
  hosts.push(second)
  const again = second.connect()
  const listed = await again.request('sessions.list', {})
  expect(listed.find((session) => session.id === oldId)?.handedOffTo).toBe(newId)
  expect(listed.find((session) => session.id === newId)?.handedOffFrom).toBe(oldId)
  const opened = await again.open(oldId)
  expect(
    opened.entries.some(
      (entry) => entry.kind === 'session_started' && entry.handoff && entry.sessionId === newId,
    ),
  ).toBe(true)
})

it('hands off no sub-session', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id: parentId } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(parentId)
  await window.untilStatus(parentId, 'ready')
  const childId = await host.host.sessions.startFromTool(parentId, {
    prompt: 'Check the login page.',
    options: {},
    report: false,
  })
  await expect(window.request('sessions.handoff', { sessionId: childId })).rejects.toThrow()
})
