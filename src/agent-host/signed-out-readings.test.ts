// Huli: what an agent shows of an account once it is signed out or signed in as another, its
// sign-in read again after its credentials change, and a session's sign-in notice.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

function statusOf(window: TestPort, agentId: AgentId = 'fake-agent'): AgentStatus | undefined {
  return window.events.findLast(
    (event): event is Extract<typeof event, { type: 'agent.status' }> =>
      event.type === 'agent.status' && event.status.id === agentId,
  )?.status
}

const WEEK: PlanLimit = {
  window: 'seven_day',
  label: 'Weekly',
  usedPercent: 40,
  resetsAt: null,
  state: 'ok',
  observedAt: 1,
}

/** A data folder whose agents file remembers the fake agent signed in as `email`, with a plan. */
async function remembered(email: string): Promise<string> {
  const dir = await tempFolder('kite-readings-')
  await mkdir(path.join(dir, 'state'), { recursive: true })
  await writeFile(
    path.join(dir, 'state', 'agents.json'),
    JSON.stringify({
      version: 1,
      agents: {
        'fake-agent': {
          account: { kind: 'account', label: 'Fake Pro', email },
          limits: [WEEK],
        },
      },
    }),
  )
  return dir
}

it('shows no account or plan of an earlier sign-in while the agent is signed out', async () => {
  const dir = await remembered('developer@example.com')
  // An agent that tells it is signed out only by refusing a session, so no account answer of
  // its own replaces the one remembered.
  const host = await startTestHost({
    userDataPath: dir,
    agentEnv: { FAKE_AGENT_AUTH: 'required', FAKE_AGENT_WITHOUT: 'auth' },
  })
  hosts.push(host)
  const window = host.connect()
  const listed = await window.request('agents.list', undefined)
  expect(listed.find((status) => status.id === 'fake-agent')?.limits).toEqual([WEEK])

  await window.request('agents.readSignIn', { agentId: 'fake-agent' })
  await window.until(() => statusOf(window)?.signIn === 'required')
  expect(statusOf(window)).toMatchObject({ account: null, limits: [] })
  expect(statusOf(window)?.limitsError).toBeUndefined()
})

it('drops the plan read under another account once the agent names a new one', async () => {
  const dir = await remembered('someone-else@example.com')
  const host = await startTestHost({ userDataPath: dir })
  hosts.push(host)
  const window = host.connect()

  await window.request('agents.readSignIn', { agentId: 'fake-agent' })
  await window.until(() => statusOf(window)?.account?.email === 'developer@example.com')
  expect(statusOf(window)?.limits).toEqual([])
})

it('keeps the plan of the same account when it names its address only later', async () => {
  const dir = await remembered('developer@example.com')
  const host = await startTestHost({ userDataPath: dir })
  hosts.push(host)
  const window = host.connect()

  await window.request('agents.readSignIn', { agentId: 'fake-agent' })
  await window.until(() => statusOf(window)?.signIn === 'signed-in')
  expect(statusOf(window)?.limits.map((limit) => limit.window)).toContain('seven_day')
})

it('reads the sign-in again after its key changes, never showing it unknown meanwhile', async () => {
  const config = await tempFolder('kite-claude-config-')
  const host = await startTestHost({
    fakeAs: ['claude-code'],
    agentEnv: { FAKE_AGENT_AUTH: 'required', CLAUDE_CONFIG_DIR: config },
  })
  hosts.push(host)
  const window = host.connect()
  await window.request('agents.readSignIn', { agentId: 'claude-code' })
  await window.until(() => statusOf(window, 'claude-code')?.signIn === 'required')

  const before = window.events.length
  await window.request('agents.setApiKey', { agentId: 'claude-code', key: 'sk-test-key' })
  // The fake agent takes no key, so it is still signed out once read again.
  await window.until(() => {
    const status = statusOf(window, 'claude-code')
    return status?.signIn === 'required' && status.readingSignIn !== true
  }, 15_000)
  const after = window.events
    .slice(before)
    .filter(
      (event): event is Extract<typeof event, { type: 'agent.status' }> =>
        event.type === 'agent.status' && event.status.id === 'claude-code',
    )
  expect(after.length).toBeGreaterThan(0)
  for (const { status } of after) {
    expect(status.signIn !== 'unknown' || status.readingSignIn === true).toBe(true)
  }
})

it('says in its own words that a session waits for a sign-in, and drops it once signed in', async () => {
  const marker = path.join(await tempFolder('kite-sign-in-'), 'login')
  const host = await startTestHost({
    agentEnv: { FAKE_AGENT_AUTH: 'required', FAKE_AGENT_LOGIN_MARKER: marker },
  })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
    prompt: [{ type: 'text', text: 'Hello' }],
  })
  await window.open(id)
  await window.untilStatus(id, 'auth_required')
  await window.untilEntry(id, (entry) => entry.kind === 'notice' && entry.cause === 'sign_in')
  const notices = window
    .entries(id)
    .filter((entry) => entry.kind === 'notice' && entry.cause === 'sign_in')
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({ severity: 'warning' })
  // The agent's own English words for it are not the notice's.
  expect(JSON.stringify(notices[0])).not.toContain('Sign in to the fake agent')

  await writeFile(marker, '')
  await window.request('sessions.retry', { sessionId: id })
  await window.until(
    () =>
      window.summary(id)?.status !== 'auth_required' &&
      !window.entries(id).some((entry) => entry.kind === 'notice' && entry.cause === 'sign_in'),
  )
})
