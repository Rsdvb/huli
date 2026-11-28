import { describe, expect, it, vi } from 'vitest'
import * as requestLog from '@shared/log/requests'
import { currentPrimitives } from '@shared/remote/primitives'
import {
  DEFAULT_CHOICES,
  decodeSealed,
  openPush,
  parsePushRequest,
  pushRequestText,
  pushTag,
  type DevicePush,
  type PushContent,
} from '@shared/remote/push'
import {
  importRelayKey,
  newRelaySeed,
  relayHostId,
  verifyRelaySignature,
} from '@shared/remote/relay'
import type { PushJob } from './notifier'
import { PushSender } from './push-sender'

const URL = 'https://push.example.test'
const DEVICE_TOKEN = 'a1'.repeat(32)
const ACCESS_TOKEN = 'secret-access-token'

async function setup(answers: (number | Error)[], push: Partial<DevicePush> = {}) {
  const key = await importRelayKey(await newRelaySeed())
  const hostId = await relayHostId(key.publicKey)
  const device = await currentPrimitives().generateKeyPair(false)
  const devicePush: DevicePush = {
    target: { apns: { token: DEVICE_TOKEN, environment: 'sandbox' } },
    choices: DEFAULT_CHOICES,
    ...push,
  }
  const requests: { url: string; headers: Record<string, string>; body: string }[] = []
  const logs: string[] = []
  let done: () => void = () => {}
  const finished = new Promise<void>((resolve) => (done = resolve))
  const sender = new PushSender({
    url: URL,
    key,
    hostId,
    hostName: () => 'Studio',
    token: () => ACCESS_TOKEN,
    device: (id) =>
      id === 'phone'
        ? { publicKey: Buffer.from(device.publicKey).toString('base64'), push: devicePush }
        : null,
    unregistered: () => {},
    log: (level, message) => logs.push(`${level}: ${message}`),
    retry: { firstMs: 1, maxMs: 5, attempts: 3 },
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        headers: init!.headers as Record<string, string>,
        body: init!.body as string,
      })
      const answer = answers.shift() ?? 200
      if (answers.length === 0) done()
      if (answer instanceof Error) throw answer
      const error = answer === 410 ? 'unregistered' : answer === 502 ? 'apns' : 'malformed'
      return Response.json(answer === 200 ? { ok: true } : { error }, { status: answer })
    },
  })
  return { sender, key, hostId, device, requests, logs, finished }
}

const job: PushJob = {
  deviceId: 'phone',
  subject: 's1',
  type: 'alert',
  event: {
    kind: 'permission',
    sessionId: 's1',
    requestId: 'r1',
    actions: { allow: { optionId: 'allow', label: 'Allow' } },
  },
  title: 'Fix the login form',
  body: 'Wants to run pnpm test',
}

async function opened(t: Awaited<ReturnType<typeof setup>>, body: string): Promise<PushContent> {
  const request = parsePushRequest(body)!
  const envelope = decodeSealed(request.push.sealed)!
  const content = (await openPush(envelope, t.device))!
  expect(await verifyRelaySignature(t.key.publicKey, content.signature, content.signed)).toBe(true)
  return JSON.parse(new TextDecoder().decode(content.body)) as PushContent
}

describe('sending a push', () => {
  it('posts the content sealed to the device, the request signed with the host key', async () => {
    const t = await setup([200])
    t.sender.send(job)
    await t.finished
    const [request] = t.requests
    expect(request!.url).toBe(`${URL}/v1/push`)
    expect(request!.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    const signature = Buffer.from(request!.headers['Kettu-Signature']!, 'base64url')
    const signed = pushRequestText(URL, t.hostId, request!.body)
    expect(await verifyRelaySignature(t.key.publicKey, signature, signed)).toBe(true)
    const parsed = parsePushRequest(request!.body)!
    const tag = await pushTag(t.device.publicKey, t.hostId, 's1')
    expect(parsed).toMatchObject({
      token: DEVICE_TOKEN,
      environment: 'sandbox',
      push: { type: 'alert', collapse: tag },
    })
    expect(await opened(t, request!.body)).toMatchObject({
      v: 1,
      host: t.hostId,
      hostName: 'Studio',
      tag,
      title: 'Fix the login form',
      body: 'Wants to run pnpm test',
      kind: 'permission',
      sessionId: 's1',
      requestId: 'r1',
      actions: { allow: { optionId: 'allow', label: 'Allow' } },
    })
  })

  it('leaves out the title, the text and the answers for a device without details', async () => {
    const t = await setup([200], { choices: { ...DEFAULT_CHOICES, details: false } })
    t.sender.send(job)
    await t.finished
    const content = await opened(t, t.requests[0]!.body)
    expect(content).not.toHaveProperty('title')
    expect(content).not.toHaveProperty('body')
    expect(content).not.toHaveProperty('actions')
    expect(content).toMatchObject({ kind: 'permission', sessionId: 's1', requestId: 'r1' })
  })

  it('carries a question to answer only to a device that wants details', async () => {
    const asks: PushJob = {
      ...job,
      event: {
        kind: 'permission',
        sessionId: 's1',
        requestId: 'r1',
        question: { choices: ['Tabs', 'Spaces'], text: true },
      },
    }
    const t = await setup([200])
    t.sender.send(asks)
    await t.finished
    expect(await opened(t, t.requests[0]!.body)).toMatchObject({
      question: { choices: ['Tabs', 'Spaces'], text: true },
    })
    const quiet = await setup([200], { choices: { ...DEFAULT_CHOICES, details: false } })
    quiet.sender.send(asks)
    await quiet.finished
    const content = await opened(quiet, quiet.requests[0]!.body)
    expect(content).not.toHaveProperty('question')
    expect(content).toMatchObject({ kind: 'permission', requestId: 'r1' })
  })

  it("seals a turn's activity state to its own token, timed as the notifier asks", async () => {
    const FOLLOW = 'd4'.repeat(32)
    const START = 'c3'.repeat(32)
    const target = {
      apns: { token: DEVICE_TOKEN, environment: 'sandbox' as const },
      activity: { start: START, progress: { token: FOLLOW, sessionId: 's1' } },
    }
    const progress = (
      action: 'start' | 'update' | 'end',
      low: boolean,
    ): Extract<PushJob, { type: 'progress' }> => ({
      deviceId: 'phone',
      subject: 'progress',
      type: 'progress',
      action,
      low,
      staleS: 1800,
      lingerS: 900,
      state: {
        title: 'Fix the login form',
        sessionId: 's1',
        phase: 'command',
        agent: 'Claude Code',
        step: 'pnpm test',
        plan: { done: 1, total: 3, current: 'Write the test' },
        startedAt: 1000,
        subagents: 2,
        running: 1,
        waiting: 0,
      },
    })
    const t = await setup([200, 200, 200], { target })
    t.sender.send(progress('update', true))
    await expect.poll(() => t.requests.length).toBe(1)
    t.sender.send(progress('end', false))
    await expect.poll(() => t.requests.length).toBe(2)
    t.sender.send(progress('start', false))
    await t.finished
    const [update, end, start] = t.requests.map((request) => parsePushRequest(request.body)!)
    expect(update).toMatchObject({
      token: FOLLOW,
      push: { type: 'liveactivity', event: 'update', stale: 1800, low: true },
    })
    expect(end).toMatchObject({ token: FOLLOW, push: { event: 'end', dismiss: 900 } })
    expect(end!.push).not.toHaveProperty('low')
    expect(start).toMatchObject({ token: START, push: { event: 'start', stale: 1800 } })
    expect(await opened(t, t.requests[0]!.body)).toMatchObject({
      v: 1,
      kind: 'progress',
      format: 1,
      title: 'Fix the login form',
      sessionId: 's1',
      phase: 'command',
      step: 'pnpm test',
      plan: { done: 1, total: 3, current: 'Write the test' },
      subagents: 2,
    })
    const envelope = decodeSealed((start!.push as { attributes: string }).attributes)!
    const attributes = (await openPush(envelope, t.device))!
    expect(JSON.parse(new TextDecoder().decode(attributes.body))).toMatchObject({
      kind: 'activity',
      progress: true,
      sessionId: 's1',
    })
  })

  it('gives the activity of what waits a stale date, and ends it at once', async () => {
    const START = 'c3'.repeat(32)
    const UPDATE = 'e5'.repeat(32)
    const target = {
      apns: { token: DEVICE_TOKEN, environment: 'sandbox' as const },
      activity: { start: START, update: UPDATE },
    }
    const waiting = (
      action: 'start' | 'update' | 'end',
      low: boolean,
    ): Extract<PushJob, { type: 'activity' }> => ({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action,
      count: 1,
      sessionId: 's1',
      title: 'Fix the login form',
      staleS: 300,
      low,
    })
    const t = await setup([200, 200, 200], { target })
    t.sender.send(waiting('start', false))
    await expect.poll(() => t.requests.length).toBe(1)
    t.sender.send(waiting('update', true))
    await expect.poll(() => t.requests.length).toBe(2)
    t.sender.send(waiting('end', false))
    await t.finished
    const [start, update, end] = t.requests.map((request) => parsePushRequest(request.body)!)
    expect(start).toMatchObject({ token: START, push: { event: 'start', stale: 300 } })
    expect(update).toMatchObject({
      token: UPDATE,
      push: { event: 'update', stale: 300, low: true },
    })
    expect(end).toMatchObject({ token: UPDATE, push: { event: 'end' } })
    expect(end!.push).not.toHaveProperty('stale')
    expect(end!.push).not.toHaveProperty('dismiss')
  })

  it('tries again after the gateway or the network fails, and logs nothing of the push', async () => {
    const t = await setup([502, new TypeError('fetch failed'), 200])
    t.sender.send(job)
    await t.finished
    await expect.poll(() => t.requests.length).toBe(3)
    expect(t.logs).toEqual([])
    const t2 = await setup([502, 502, 502])
    t2.sender.send(job)
    await expect.poll(() => t2.logs.length).toBe(1)
    expect(t2.logs).toEqual(['warn: Gave up a notification for device phone after 3 tries: apns'])
  })

  it('记录推送从入队到网关接收的总耗时、网关耗时与重试次数', async () => {
    let clock = 5000
    const spy = vi.spyOn(requestLog, 'logDevicePush')
    try {
      const key = await importRelayKey(await newRelaySeed())
      const hostId = await relayHostId(key.publicKey)
      const device = await currentPrimitives().generateKeyPair(false)
      let done: () => void = () => {}
      const finished = new Promise<void>((resolve) => (done = resolve))
      let call = 0
      const sender = new PushSender({
        url: URL,
        key,
        hostId,
        hostName: () => 'Studio',
        token: () => ACCESS_TOKEN,
        device: () => ({
          publicKey: Buffer.from(device.publicKey).toString('base64'),
          push: {
            target: { apns: { token: DEVICE_TOKEN, environment: 'sandbox' } },
            choices: DEFAULT_CHOICES,
          },
        }),
        unregistered: () => {},
        log: () => {},
        now: () => clock,
        retry: { firstMs: 1, maxMs: 5, attempts: 3 },
        fetch: async () => {
          call++
          if (call === 1) {
            clock += 120
            return Response.json({ error: 'apns' }, { status: 502 })
          }
          clock += 85
          done()
          return Response.json({ ok: true }, { status: 200 })
        },
      })
      sender.send(job)
      await finished
      // 等待 attempt 返回后记录完成
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(spy).toHaveBeenCalledWith({
        device: 'phone',
        kind: 'alert',
        ms: 205,
        gatewayMs: 85,
        attempts: 2,
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('passes alert metadata on, and leaves it out without details', async () => {
    const t = await setup([200])
    t.sender.send({
      deviceId: 'phone',
      subject: 's-meta',
      type: 'alert',
      title: '导出格式确认',
      body: '需要同时导出 CSV 吗？',
      event: {
        kind: 'permission',
        sessionId: 's-meta',
        agentId: 'codex',
        requestId: 'req-meta',
        actionKind: 'question',
      },
    })
    await t.finished
    const shown = await opened(t, t.requests[0]!.body)
    expect(shown).toMatchObject({
      kind: 'permission',
      agentId: 'codex',
      actionKind: 'question',
    })

    const tPrivate = await setup([200], { choices: { ...DEFAULT_CHOICES, details: false } })
    tPrivate.sender.send({
      deviceId: 'phone',
      subject: 's-meta',
      type: 'alert',
      title: '机密标题',
      body: '机密正文',
      event: {
        kind: 'turn-ended',
        sessionId: 's-meta',
        agentId: 'claude-code',
        changedFiles: 4,
      },
    })
    await tPrivate.finished
    const redacted = await opened(tPrivate, tPrivate.requests[0]!.body)
    expect(redacted).toMatchObject({ kind: 'turn-ended', sessionId: 's-meta' })
    expect(redacted).not.toHaveProperty('title')
    expect(redacted).not.toHaveProperty('agentId')
    expect(redacted).not.toHaveProperty('changedFiles')
  })
})
