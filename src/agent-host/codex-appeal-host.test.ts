// Huli: a Codex call its auto-review denied, allowed by the user anyway: the host checks the
// appeal and its risk, hands Codex its own record of the denial, and asks the model to retry.

import { afterEach, expect, it } from 'vitest'
import type { ToolEntry } from '@shared/thread'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost } from './testing/harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const PROMPT = 'clean the build'

/** A fake Codex of `version` that records each turn's text and each denial it is given back. */
function codex(version: string) {
  const server = new FakeAppServer()
  server.on('initialize', () => ({
    userAgent: `Kettu/${version} (Mac OS 27.0.1; arm64) unknown (Kettu; 0.0.0-test)`,
  }))
  const turns: { threadId: string; turnId: string; text: string }[] = []
  server.on('turn/start', (params, self) => {
    const turnId = self.nextTurnId()
    const input = params.input as { text?: string }[]
    turns.push({ threadId: params.threadId as string, turnId, text: input[0]?.text ?? '' })
    return { turn: turn(turnId) }
  })
  server.on('thread/approveGuardianDeniedAction', () => ({}))
  return { server, turns }
}

/** A Codex session whose turn's command the auto-review denied, after which the turn ended. */
async function deniedCall(version: string) {
  const fake = codex(version)
  const test = await startTestHost({ fakeAppServer: fake.server })
  hosts.push(test)
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
  const first = () => fake.turns.find((item) => item.text === PROMPT)
  await fake.server.until(() => first() !== undefined)
  const { threadId, turnId } = first()!
  fake.server.notify('item/autoApprovalReview/completed', {
    threadId,
    turnId,
    reviewId: 'review-1',
    targetItemId: 'cmd-1',
    startedAtMs: 1,
    completedAtMs: 2,
    decisionSource: 'agent',
    action: { type: 'command', source: 'shell', command: 'rm -rf /etc/hosts', cwd: test.project },
    review: { status: 'denied', riskLevel: 'medium', rationale: 'Deletes a system file' },
  })
  fake.server.notify('turn/completed', { threadId, turn: turn(turnId, 'completed') })
  await window.untilStatus(id, 'ready')
  const tool = () =>
    window
      .entries(id)
      .find((entry): entry is ToolEntry => entry.id === 't:cmd-1' && entry.kind === 'tool')
  return { fake, window, id, threadId, turnId, tool }
}

it('allows a denied call once its high risk is confirmed, and asks Codex to retry it', async () => {
  const { fake, window, id, threadId, turnId, tool } = await deniedCall('0.171.0')
  // The host judges the call as it would a permission request: a file outside the project.
  await window.until(() => tool()?.review?.appeal?.risk?.level === 'high')
  expect(tool()).toMatchObject({
    status: 'cancelled',
    denied: { by: 'review', reason: 'Deletes a system file' },
    review: { status: 'denied', risk: 'medium' },
  })
  await expect(
    window.request('sessions.allowDenied', { sessionId: id, entryId: 't:cmd-1' }),
  ).rejects.toMatchObject({ code: 'invalid_params' })
  expect(fake.server.sent('thread/approveGuardianDeniedAction')).toEqual([])

  await window.request('sessions.allowDenied', {
    sessionId: id,
    entryId: 't:cmd-1',
    confirmed: true,
  })
  expect(fake.server.sent('thread/approveGuardianDeniedAction')).toEqual([
    {
      threadId,
      event: expect.objectContaining({
        id: 'review-1',
        status: 'denied',
        turn_id: turnId,
        rationale: 'Deletes a system file',
        action: expect.objectContaining({ type: 'command', command: 'rm -rf /etc/hosts' }),
      }),
    },
  ])
  await window.until(() => tool()?.review?.appeal?.allowed === true)
  // With the turn over, a message asks the model to try the step again.
  await fake.server.until(
    () => fake.turns.filter((item) => item.threadId === threadId).length === 2,
  )
  expect(fake.turns.filter((item) => item.threadId === threadId)[1]!.text).toContain('try it again')
  await expect(
    window.request('sessions.allowDenied', { sessionId: id, entryId: 't:cmd-1', confirmed: true }),
  ).rejects.toMatchObject({ code: 'conflict' })
})

it('offers nothing to allow on a Codex that takes no denial back', async () => {
  const { fake, window, id, tool } = await deniedCall('0.166.0')
  await window.until(() => tool()?.review?.status === 'denied')
  expect(tool()?.review).not.toHaveProperty('appeal')
  await expect(
    window.request('sessions.allowDenied', { sessionId: id, entryId: 't:cmd-1', confirmed: true }),
  ).rejects.toMatchObject({ code: 'not_found' })
  expect(fake.server.sent('thread/approveGuardianDeniedAction')).toEqual([])
})
