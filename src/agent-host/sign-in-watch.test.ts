// Huli: an agent's sign-in shown before a session needs it, and a sign-in that waits on a browser
// or a terminal noticed once it is done.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import type { AgentLauncher } from './agents'
import type { MessageTransport } from './driver'
import type { Env } from './find-command'
import {
  inProcessLauncher,
  loadFakeAgent,
  startTestHost,
  testSettings,
  type TestHost,
  type TestPort,
} from './testing/harness'
import { tempFolder } from './testing/temp'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

// As the fake agent, two ACP agents that report no account: Muse Code, in whose history Kettu
// opens no session of its own, and Pi, whose hidden sessions leave none in its history.
const MUSE: AgentId = 'muse'
const PI: AgentId = 'pi'

function statusOf(window: TestPort, agentId: AgentId): AgentStatus | undefined {
  return window.events.findLast(
    (event): event is Extract<typeof event, { type: 'agent.status' }> =>
      event.type === 'agent.status' && event.status.id === agentId,
  )?.status
}

const museStatus = (window: TestPort): AgentStatus | undefined => statusOf(window, MUSE)
const piStatus = (window: TestPort): AgentStatus | undefined => statusOf(window, PI)

/** The fake agent in the test's process, and the methods of every request Kettu sent it. */
async function recording(env: Env): Promise<{ launcher: AgentLauncher; sent: string[] }> {
  const base = inProcessLauncher(await loadFakeAgent(), env)
  const sent: string[] = []
  const launcher: AgentLauncher = {
    launch: (def, spec, launchEnv, output) => {
      const launched = base.launch(def, spec, launchEnv, output)
      const transport = launched.transport as MessageTransport
      const writer = transport.stream.writable.getWriter()
      const writable = new WritableStream<unknown>({
        write: (message) => {
          const method = (message as { method?: unknown }).method
          if (typeof method === 'string') sent.push(method)
          return writer.write(message)
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      })
      const tapped: MessageTransport = {
        kind: 'messages',
        stream: { readable: transport.stream.readable, writable },
        close: () => transport.close(),
      }
      return Object.create(launched, { transport: { value: tapped } }) as typeof launched
    },
  }
  return { launcher, sent }
}

it('names a turned-on agent’s sign-in methods and state without a session', async () => {
  const { launcher, sent } = await recording({ FAKE_AGENT_AUTH: 'required' })
  const settings = { ...testSettings(['fake-agent', MUSE]), disabledAgents: [MUSE] }
  const host = await startTestHost({ fakeAs: [MUSE], settings, launcher })
  hosts.push(host)
  const window = host.connect()
  const listed = await window.request('agents.list', undefined)
  expect(listed.find((status) => status.id === MUSE)?.authMethods).toEqual([])

  const turnedOn = Date.now()
  await host.host.updateSettings({ ...settings, disabledAgents: [] })
  await window.until(() => {
    const status = museStatus(window)
    return status?.signIn === 'required' && status.readingSignIn !== true
  })

  expect(Date.now() - turnedOn).toBeLessThan(5_000)
  expect(museStatus(window)?.authMethods.map((method) => method.id)).toContain('fake-login')
  // `initialize` named the methods and `auth/status` the state: no session was opened.
  expect(sent).toContain('initialize')
  expect(sent).not.toContain('session/new')
  expect(await window.request('sessions.list', {})).toEqual([])
})

/**
 * Turns the agent on and waits until its methods are named, then until its sign-in is read;
 * returns what Kettu had sent it by the time the methods were named, and whether the read still
 * showed then.
 */
async function turnOn(
  host: TestHost,
  window: TestPort,
  agentId: AgentId,
  sent: string[],
): Promise<{ sent: string[]; reading: boolean }> {
  const settings = { ...testSettings(['fake-agent', agentId]), disabledAgents: [agentId] }
  await host.host.updateSettings(settings)
  await window.request('agents.list', undefined)
  let named: { sent: string[]; reading: boolean } | null = null
  const naming = window.until(() => {
    const status = statusOf(window, agentId)
    if (!status || status.authMethods.length === 0) return false
    named ??= { sent: [...sent], reading: status.readingSignIn === true }
    return true
  })
  await host.host.updateSettings({ ...settings, disabledAgents: [] })
  await naming
  await window.until(() => statusOf(window, agentId)?.readingSignIn !== true)
  return named!
}

it('names the methods of an agent that tells its sign-in only in a session, opening none', async () => {
  const { launcher, sent } = await recording({
    FAKE_AGENT_AUTH: 'required',
    FAKE_AGENT_WITHOUT: 'auth',
  })
  const host = await startTestHost({ fakeAs: [MUSE], launcher })
  hosts.push(host)
  const window = host.connect()

  const named = await turnOn(host, window, MUSE, sent)
  expect(named).toEqual({ sent: ['initialize'], reading: true })
  expect(museStatus(window)?.authMethods.map((method) => method.id)).toContain('fake-page-login')
  // Kettu opens no session of its own where nobody checked it leaves no trace.
  expect(museStatus(window)?.signIn).toBe('unknown')
  expect(sent).not.toContain('session/new')
})

it('asks an agent whose hidden sessions leave no trace whether it is signed in', async () => {
  const { launcher, sent } = await recording({
    FAKE_AGENT_AUTH: 'required',
    FAKE_AGENT_WITHOUT: 'auth',
  })
  const host = await startTestHost({ fakeAs: [PI], launcher })
  hosts.push(host)
  const window = host.connect()

  const named = await turnOn(host, window, PI, sent)
  expect(named.sent).not.toContain('session/new')
  expect(named.reading).toBe(true)
  expect(piStatus(window)?.signIn).toBe('required')
  // One hidden session told it, and went.
  expect(sent.filter((method) => method === 'session/new')).toHaveLength(1)
  expect(await window.request('sessions.list', {})).toEqual([])
})

it('notices a sign-in finished in a terminal while it watches', async () => {
  const marker = path.join(await tempFolder('kite-sign-in-'), 'login')
  const { launcher, sent } = await recording({
    FAKE_AGENT_AUTH: 'required',
    FAKE_AGENT_WITHOUT: 'auth',
    FAKE_AGENT_LOGIN_MARKER: marker,
  })
  const host = await startTestHost({
    fakeAs: [PI],
    launcher,
    agentTimings: { signInPollMs: 200, signInWatchMs: 20_000 },
  })
  hosts.push(host)
  const window = host.connect()
  await window.request('agents.readSignIn', { agentId: PI })
  expect(piStatus(window)?.signIn).toBe('required')

  // A terminal sign-in started: the agent writes its credentials, and nothing tells Kettu.
  await window.request('agents.readSignIn', { agentId: PI, watch: true })
  const written = Date.now()
  await writeFile(marker, '')
  await window.until(() => piStatus(window)?.signIn === 'signed-in', 5_000)
  expect(Date.now() - written).toBeLessThan(2_000)

  // Signed in, the checks stop.
  const asked = sent.length
  await new Promise((resolve) => setTimeout(resolve, 800))
  expect(sent.slice(asked)).not.toContain('session/new')
})

it('stops watching a sign-in that is not done once its time is up', async () => {
  const { launcher, sent } = await recording({
    FAKE_AGENT_AUTH: 'required',
    FAKE_AGENT_WITHOUT: 'auth',
  })
  const host = await startTestHost({
    fakeAs: [PI],
    launcher,
    agentTimings: { signInPollMs: 100, signInWatchMs: 500 },
  })
  hosts.push(host)
  const window = host.connect()
  await window.request('agents.readSignIn', { agentId: PI, watch: true })
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  const asked = sent.length
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(sent.slice(asked)).not.toContain('session/new')
  expect(piStatus(window)?.signIn).toBe('required')
})

it('ends a browser sign-in the agent never answers once the agent is signed in', async () => {
  const marker = path.join(await tempFolder('kite-sign-in-'), 'login')
  const host = await startTestHost({
    fakeAs: [PI],
    agentEnv: {
      FAKE_AGENT_AUTH: 'required',
      FAKE_AGENT_WITHOUT: 'auth',
      FAKE_AGENT_LOGIN_MARKER: marker,
      // The browser flow outlasts the test: only the agent's credentials show it is done.
      FAKE_AGENT_PAGE_LOGIN_MS: '600000',
    },
    agentTimings: { signInPollMs: 200 },
  })
  hosts.push(host)
  const window = host.connect()
  await window.request('agents.readSignIn', { agentId: PI })
  expect(piStatus(window)?.signIn).toBe('required')

  const signIn = window.request('agents.authenticate', { agentId: PI, methodId: 'fake-page-login' })
  await window.until(() =>
    window.events.some((event) => event.type === 'agents.signInLink' && event.agentId === PI),
  )
  await writeFile(marker, '')
  await signIn
  expect(piStatus(window)?.signIn).toBe('signed-in')
})

it('asks again at once when the agent says its sign-in page is done', async () => {
  const host = await startTestHost({
    fakeAs: [PI],
    agentEnv: {
      FAKE_AGENT_AUTH: 'required',
      FAKE_AGENT_WITHOUT: 'auth',
      FAKE_AGENT_PAGE_LOGIN_MS: '200',
      FAKE_AGENT_PAGE_LOGIN_UNANSWERED: '1',
    },
    // No check of the watch comes within the test.
    agentTimings: { signInPollMs: 60_000 },
  })
  hosts.push(host)
  const window = host.connect()
  await window.request('agents.readSignIn', { agentId: PI })
  expect(piStatus(window)?.signIn).toBe('required')

  const started = Date.now()
  await window.request('agents.authenticate', { agentId: PI, methodId: 'fake-page-login' })
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(piStatus(window)?.signIn).toBe('signed-in')
})

it('shows a browser sign-in the agent answers as signed in at once', async () => {
  const host = await startTestHost({
    fakeAs: [MUSE],
    agentEnv: {
      FAKE_AGENT_AUTH: 'required',
      FAKE_AGENT_WITHOUT: 'auth',
      FAKE_AGENT_PAGE_LOGIN_MS: '300',
    },
  })
  hosts.push(host)
  const window = host.connect()
  await window.request('agents.readSignIn', { agentId: MUSE })

  await window.request('agents.authenticate', { agentId: MUSE, methodId: 'fake-page-login' })
  expect(museStatus(window)?.signIn).toBe('signed-in')
})
