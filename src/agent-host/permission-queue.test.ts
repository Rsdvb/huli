// Huli: the requests an agent waits on at once are numbered in the order they reach the host, so
// every client answers them in turn; 全部同意 answers the plain ones together but never a high
// one, and a request that no longer waits takes no answer.

import { afterEach, expect, it } from 'vitest'
import { requestQueue } from '@shared/permission-queue'
import type { ToolEntry } from '@shared/thread'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

async function readySession(): Promise<{ host: TestHost; window: TestPort; id: string }> {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  return { host, window, id }
}

function tools(window: TestPort, id: string): ToolEntry[] {
  return window.entries(id).filter((entry): entry is ToolEntry => entry.kind === 'tool')
}

/** A lint run (low), an edit of package.json (medium) and a deletion (high), asked at once. */
async function askThree(window: TestPort, id: string): Promise<ToolEntry[]> {
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/parallel-permissions' }],
  })
  await window.until(() => window.summary(id)?.permissionCount === 3)
  return tools(window, id)
}

const requestId = (entry: ToolEntry | undefined): string => {
  if (!entry?.permission) throw new Error(`${entry?.title ?? 'The entry'} does not wait`)
  return entry.permission.requestId
}

it('numbers the requests in the order they arrived, and the next waits once one is answered', async () => {
  const { window, id } = await readySession()
  const [lint, edit, remove] = await askThree(window, id)
  const numbers = [lint, edit, remove].map((entry) => entry?.permission?.queue)
  expect(numbers.every((n) => typeof n === 'number')).toBe(true)
  expect([...numbers].sort((a, b) => a! - b!)).toEqual(numbers)
  expect(requestQueue(tools(window, id)).map((entry) => entry.title)).toEqual([
    'Run pnpm lint --fix',
    'Edit package.json',
    'Delete .cache',
  ])

  await window.request('permissions.respond', {
    sessionId: id,
    requestId: requestId(lint),
    optionId: 'allow-once',
  })
  await window.until(() => window.summary(id)?.permissionCount === 2)
  expect(requestQueue(tools(window, id)).map((entry) => entry.title)).toEqual([
    'Edit package.json',
    'Delete .cache',
  ])
})

it('allows all but the high request at once, and denies that one when asked to', async () => {
  const { host, window, id } = await readySession()
  const [lint, edit, remove] = await askThree(window, id)
  const ids = [lint, edit, remove].map(requestId)
  const phone = host.connect({ id: 'phone-1', name: 'iPhone' })

  expect(
    await phone.request('permissions.respondAll', {
      sessionId: id,
      requestIds: ids,
      decision: 'allow',
    }),
  ).toEqual({ answered: [ids[0], ids[1]], skipped: [ids[2]] })
  await window.until(() => window.summary(id)?.permissionCount === 1)
  const [lintAfter, editAfter, removeAfter] = tools(window, id)
  for (const entry of [lintAfter, editAfter]) {
    expect(entry?.permission).toBeNull()
    expect(entry?.permissionResult).toMatchObject({
      kind: 'allow_once',
      device: { id: 'phone-1', name: 'iPhone' },
    })
  }
  expect(removeAfter?.permission).toMatchObject({ risk: { level: 'high' } })
  expect(removeAfter?.permissionResult).toBeNull()

  expect(
    await window.request('permissions.respondAll', {
      sessionId: id,
      requestIds: [ids[2]!],
      decision: 'deny',
    }),
  ).toEqual({ answered: [ids[2]], skipped: [] })
  await window.untilStatus(id, 'ready')
  expect(tools(window, id)[2]?.permissionResult).toMatchObject({ kind: 'reject_once' })
})

it('answers only the requests it is given', async () => {
  const { window, id } = await readySession()
  const [lint, edit] = await askThree(window, id)
  expect(
    await window.request('permissions.respondAll', {
      sessionId: id,
      requestIds: [requestId(edit)],
      decision: 'deny',
    }),
  ).toEqual({ answered: [requestId(edit)], skipped: [] })
  await window.until(() => window.summary(id)?.permissionCount === 2)
  expect(tools(window, id)[0]?.permission?.requestId).toBe(requestId(lint))
})

it('takes no answer for a request its stopped turn left behind', async () => {
  const { window, id } = await readySession()
  const [lint, edit, remove] = await askThree(window, id)
  await window.request('sessions.cancel', { sessionId: id })
  await window.untilStatus(id, 'ready')

  for (const entry of tools(window, id)) {
    expect(entry.permission).toBeNull()
    expect(entry.permissionResult).toBe('cancelled')
  }
  expect(requestQueue(tools(window, id))).toEqual([])
  await expect(
    window.request('permissions.respond', {
      sessionId: id,
      requestId: requestId(lint),
      optionId: 'allow-once',
    }),
  ).rejects.toMatchObject({ code: 'not_found' })
  const ids = [lint, edit, remove].map(requestId)
  expect(
    await window.request('permissions.respondAll', {
      sessionId: id,
      requestIds: ids,
      decision: 'allow',
    }),
  ).toEqual({ answered: [], skipped: ids })
  for (const entry of tools(window, id)) expect(entry.permissionResult).toBe('cancelled')
})
