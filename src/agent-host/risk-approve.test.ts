// The host answers by itself only what the user's setting allows: low requests, and with the
// edits level an edit inside the project, never a medium or high one, never with the setting off
// and never in plan mode.

import { afterEach, expect, it } from 'vitest'
import type { AutoApprove } from '@shared/risk'
import type { ToolEntry } from '@shared/thread'
import { startTestHost, testSettings, type TestHost, type TestPort } from './testing/harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

async function readySession(
  defaultLevel: AutoApprove = 'off',
): Promise<{ host: TestHost; window: TestPort; id: string }> {
  const host = await startTestHost({
    settings: { ...testSettings(['fake-agent']), autoApprove: defaultLevel },
  })
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

/** Asks for a lint run (low), an edit of package.json (medium) and a deletion (high) at once. */
async function askThree(window: TestPort, id: string, waiting: number): Promise<ToolEntry[]> {
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/parallel-permissions' }],
  })
  await window.until(() => tools(window, id).length === 3)
  await window.until(() => window.summary(id)?.permissionCount === waiting)
  return tools(window, id)
}

it('rates each request and answers none with the setting off', async () => {
  const { window, id } = await readySession()
  const [lint, edit, remove] = await askThree(window, id, 3)
  expect(lint?.permission?.risk).toMatchObject({ level: 'low' })
  expect(edit?.permission?.risk).toMatchObject({ level: 'medium' })
  expect(remove?.permission?.risk).toMatchObject({ level: 'high' })
  for (const entry of [lint, edit, remove]) expect(entry?.permissionResult).toBeNull()
})

it("allows a low request once by itself at the project's low level", async () => {
  const { host, window, id } = await readySession()
  await window.request('projects.setAutoApprove', { path: host.project, autoApprove: 'low' })
  const [lint, edit, remove] = await askThree(window, id, 2)
  expect(lint?.permission).toBeNull()
  expect(lint?.permissionResult).toMatchObject({
    kind: 'allow_once',
    by: 'risk',
    risk: { level: 'low' },
  })
  expect(edit?.permission?.risk?.level).toBe('medium')
  expect(remove?.permission?.risk?.level).toBe('high')
})

it('adds edits inside the project at the edits level, never a deletion', async () => {
  const { host, window, id } = await readySession()
  await window.request('projects.setAutoApprove', { path: host.project, autoApprove: 'edits' })
  const [lint, edit, remove] = await askThree(window, id, 1)
  expect(lint?.permissionResult).toMatchObject({ by: 'risk', kind: 'allow_once' })
  expect(edit?.permissionResult).toMatchObject({ by: 'risk', kind: 'allow_once' })
  expect(remove?.permission?.risk?.level).toBe('high')
  expect(remove?.permissionResult).toBeNull()
})

it("follows the settings' default, which a project may turn off", async () => {
  const { host, window, id } = await readySession('low')
  const [lint] = await askThree(window, id, 2)
  expect(lint?.permissionResult).toMatchObject({ by: 'risk' })

  const other = await readySession('low')
  await other.window.request('projects.setAutoApprove', {
    path: other.host.project,
    autoApprove: 'off',
  })
  const [asked] = await askThree(other.window, other.id, 3)
  expect(asked?.permissionResult).toBeNull()
  expect(host.project).not.toBe(other.host.project)
})

it('answers nothing in plan mode', async () => {
  const { host, window, id } = await readySession()
  await window.request('projects.setAutoApprove', { path: host.project, autoApprove: 'edits' })
  await window.request('sessions.setConfigOption', {
    sessionId: id,
    optionId: 'mode',
    value: 'plan',
  })
  await window.until(() =>
    window.thread(id).session.config.some((o) => o.id === 'mode' && o.value === 'plan'),
  )
  const [lint, edit] = await askThree(window, id, 3)
  expect(lint?.permission?.risk?.level).toBe('low')
  expect(lint?.permissionResult).toBeNull()
  expect(edit?.permissionResult).toBeNull()
})

it('refuses a paired device that would change what is allowed', async () => {
  const { host } = await readySession()
  const device = host.connect({ id: 'phone', name: 'Phone' })
  await expect(
    device.request('projects.setAutoApprove', { path: host.project, autoApprove: 'low' }),
  ).rejects.toThrow()
  const listed = await host.connect().request('projects.list', undefined)
  expect(listed.find((p) => p.path === host.project)?.autoApprove ?? null).toBeNull()
})
