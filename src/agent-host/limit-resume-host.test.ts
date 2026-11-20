// A Codex session its plan limit stopped, end to end: it pauses until the reset Codex gave, keeps
// the pause across a restart, and goes on by itself with what the user would have sent.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionsFile } from './storage'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const PROMPT = 'refactor the parser'
const USAGE_LIMIT = {
  message: "You've hit your usage limit. Upgrade to Pro or try again later.",
  codexErrorInfo: 'usageLimitExceeded',
  additionalDetails: null,
}

/** Codex's account windows with its 5-hour one used up until `resetS`, in Unix seconds. */
function usedUp(resetS: number) {
  return {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetS },
    secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: resetS + 86_400 },
  }
}

/** A fake Codex that records each turn's text, answering a read of the limits with `limits()`. */
function codex(limits: () => unknown) {
  const server = new FakeAppServer()
  const turns: { threadId: string; turnId: string; text: string }[] = []
  server.on('turn/start', (params, self) => {
    const turnId = self.nextTurnId()
    const input = params.input as { text?: string }[]
    turns.push({ threadId: params.threadId as string, turnId, text: input[0]?.text ?? '' })
    return { turn: turn(turnId) }
  })
  server.on('account/rateLimits/read', () => ({ rateLimits: limits(), rateLimitsByLimitId: null }))
  const turnOf = (text: string) => turns.find((item) => item.text === text)
  return { server, turns, turnOf }
}

async function host(server: FakeAppServer, userDataPath?: string): Promise<TestHost> {
  const started = await startTestHost({
    fakeAppServer: server,
    ...(userDataPath ? { userDataPath } : {}),
    sessionTimings: {
      limitResume: { marginMs: 0, gapMs: 50, checkMs: 60_000, maxCheckMs: 60_000, startupMs: 0 },
    },
  })
  hosts.push(started)
  return started
}

/** A Codex session whose turn of `PROMPT` runs. */
async function running(fake: ReturnType<typeof codex>, userDataPath?: string) {
  const test = await host(fake.server, userDataPath)
  const window = test.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'codex',
    projectPath: test.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  void window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: PROMPT }],
  })
  await vi.waitFor(() => expect(fake.turnOf(PROMPT)).toBeDefined())
  return { test, window, id, started: fake.turnOf(PROMPT)! }
}

/** Codex refuses the running turn: its windows used up until `resetS`, then the error. */
function stopAtLimit(
  server: FakeAppServer,
  started: { threadId: string; turnId: string },
  resetS: number,
): void {
  server.notify('account/rateLimits/updated', { rateLimits: usedUp(resetS) })
  server.notify('error', { ...started, willRetry: false, error: USAGE_LIMIT })
  server.notify('turn/completed', {
    threadId: started.threadId,
    turn: turn(started.turnId, 'failed', USAGE_LIMIT),
  })
}

const paused = (window: TestPort, id: string) =>
  window.until(() => (window.summary(id)?.limitPause ?? null) !== null)

const soon = () => Math.ceil(Date.now() / 1000) + 1

it('pauses until the reset Codex gave, then sends the stopped message again', async () => {
  const resetS = soon()
  const fake = codex(() => usedUp(resetS))
  const { test, window, id, started } = await running(fake)
  stopAtLimit(fake.server, started, resetS)
  await paused(window, id)
  expect(window.summary(id)?.limitPause).toMatchObject({
    resetsAt: resetS * 1000,
    resumeAt: resetS * 1000,
  })
  // The stopped message stays in the thread for the pause, not in the composer.
  expect(await window.request('sessions.takeReturned', { sessionId: id })).toEqual([])

  await vi.waitFor(() => expect(fake.turns.filter((t) => t.text === PROMPT)).toHaveLength(2), {
    timeout: 5_000,
  })
  await window.until(() => window.summary(id)?.limitPause === null)
  // The same message again under its own entry, as Retry sends it.
  const users = window.entries(id).filter((entry) => entry.kind === 'user')
  expect(users).toHaveLength(1)
  expect(test.sent).toContainEqual(
    expect.objectContaining({ type: 'host:attention', sessionId: id, kind: 'limit-resumed' }),
  )
})

it('sends the prompt queued behind the stopped turn instead', async () => {
  const resetS = soon()
  const fake = codex(() => usedUp(resetS))
  const { window, id, started } = await running(fake)
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'then add tests' }],
  })
  stopAtLimit(fake.server, started, resetS)
  await paused(window, id)
  await vi.waitFor(() => expect(fake.turnOf('then add tests')).toBeDefined(), { timeout: 5_000 })
  expect(fake.turns.filter((t) => t.text === PROMPT)).toHaveLength(1)
})

it('asks the agent to carry on after work the stopped turn did', async () => {
  const resetS = soon()
  const fake = codex(() => usedUp(resetS))
  const { window, id, started } = await running(fake)
  fake.server.notify('item/completed', {
    ...started,
    item: { type: 'agentMessage', id: 'msg-1', text: 'Reading the parser.', phase: null },
  })
  await window.untilEntry(id, (entry) => entry.kind === 'agent')
  stopAtLimit(fake.server, started, resetS)
  await paused(window, id)
  await vi.waitFor(() => expect(fake.turnOf('Continue')).toBeDefined(), { timeout: 5_000 })
  expect(fake.turns.filter((t) => t.text === PROMPT)).toHaveLength(1)
})

it('keeps the session stopped once the pause is cancelled', async () => {
  const resetS = soon()
  const fake = codex(() => usedUp(resetS))
  const { window, id, started } = await running(fake)
  stopAtLimit(fake.server, started, resetS)
  await paused(window, id)
  await window.request('sessions.limitPause', { sessionId: id, action: 'cancel' })
  await window.until(() => window.summary(id)?.limitPause === null)
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, resetS * 1000 - Date.now()) + 500))
  expect(fake.turns.filter((t) => t.text === PROMPT)).toHaveLength(1)
})

it("waits on while the plan is still used up at the pause's time", async () => {
  const resetS = soon()
  // Read at the pause's time, the window has moved on to a later reset.
  const later = resetS + 3_600
  const fake = codex(() => usedUp(later))
  const { window, id, started } = await running(fake)
  stopAtLimit(fake.server, started, resetS)
  await paused(window, id)
  await window.until(() => window.summary(id)?.limitPause?.resetsAt === later * 1000, 5_000)
  expect(fake.turns.filter((t) => t.text === PROMPT)).toHaveLength(1)
})

it('keeps the pause across a restart and goes on after it', async () => {
  const dir = await tempFolder('kite-limit-host-')
  const resetS = soon() + 1
  const first = codex(() => usedUp(resetS))
  const { test, window, id, started } = await running(first, dir)
  stopAtLimit(first.server, started, resetS)
  await paused(window, id)
  await test.stop()

  const index = JSON.parse(
    await readFile(path.join(dir, 'state', 'sessions.json'), 'utf8'),
  ) as SessionsFile
  expect(index.sessions.find((record) => record.id === id)?.limitPause).toMatchObject({
    resetsAt: resetS * 1000,
  })

  const second = codex(() => usedUp(resetS))
  await host(second.server, dir)
  await vi.waitFor(() => expect(second.turnOf(PROMPT)).toBeDefined(), { timeout: 8_000 })
}, 20_000)

it('goes on now when asked, and with the settings off drops the pause', async () => {
  const resetS = soon() + 3_600
  const fake = codex(() => usedUp(resetS))
  const { window, id, started } = await running(fake)
  stopAtLimit(fake.server, started, resetS)
  await paused(window, id)
  await window.request('sessions.limitPause', { sessionId: id, action: 'now' })
  await vi.waitFor(() => expect(fake.turns.filter((t) => t.text === PROMPT)).toHaveLength(2))

  // Stopped again, and turned off for this session: the pause goes.
  const again = fake.turns.at(-1)!
  stopAtLimit(fake.server, again, resetS)
  await paused(window, id)
  await window.request('sessions.setAutoResume', { sessionId: id, on: false })
  await window.until(
    () => window.summary(id)?.limitPause === null && window.summary(id)?.autoResume === false,
  )
})
