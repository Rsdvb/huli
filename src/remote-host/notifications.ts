// A host's notifications to its devices: what each device set over the channel, kept with it in
// the device file, what the agent host reports through the host's parent, and the notifier and the
// senders between them, the push gateway's for APNs and Web Push's for browsers. Only a host with
// its Ed25519 key has them, since every push is signed.

import type { SessionProgress } from '@shared/host-control'
import { t } from '@shared/hosts-text'
import { addLogSecret } from '@shared/log/process-log'
import type { PairedDevice } from '@shared/remote/device'
import type { DiscoveryRequestEvent } from '@shared/remote/discovery'
import {
  DEFAULT_CHOICES,
  encodeSealed,
  pushTag,
  type DevicePush,
  type NotificationsState,
  type NotificationsUpdate,
  type ProgressPhase,
  type PushActions,
  type PushQuestion,
} from '@shared/remote/push'
import type { RelayKey } from '@shared/remote/relay'
import { MAX_WITHDRAWN, type NotificationsWithdrawn } from '@shared/remote/web-push'
import type { LogFn } from '../agent-host/storage'
import { publicKeyBytes, type DeviceStore } from './devices'
import {
  DEVICE_REQUEST_SUBJECT,
  Notifier,
  type Attention,
  type AttentionKind,
  type NotifierDevice,
  type ProgressTiming,
  type PushJob,
} from './notifier'
import { PushSender, type PushSenderOptions, type PushTokenKind } from './push-sender'
import { isUsableSubscription, openWebPushSecrets, storeWebPush } from './web-push'
import { WebPushSender } from './web-push-sender'

export interface DeviceNotificationsOptions {
  devices: DeviceStore
  key: RelayKey
  hostId: string
  /** The push gateway's origin. */
  url: string
  hostName(): string
  token(): string | null
  /** Whether the device shows the session in front now. */
  showing(deviceId: string, sessionId: string): boolean
  /** Whether the device is connected and in the foreground, as a browser's page in view. */
  foreground(deviceId: string): boolean
  /** Sends a message to the device's connected sessions, if it has any. */
  tell(deviceId: string, message: NotificationsWithdrawn): void
  /** The key browsers' subscriptions are sealed with in the device file. */
  storeKey: Uint8Array
  log: LogFn
  fetch?: typeof fetch
  mergeMs?: number
  retry?: PushSenderOptions['retry']
  progressTiming?: Partial<ProgressTiming>
  now?: () => number
}

const KINDS: readonly string[] = [
  'permission',
  'turn-ended',
  'error',
  'routine-ended',
  'routine-paused',
  'plan-limit',
  'limit-resumed',
  'stalled',
  'note',
] satisfies AttentionKind[]

const MAX_TEXT = 4000
const MAX_FRONT_DEVICES = 1000

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200

const MAX_QUESTION_CHOICES = 4
const MAX_CHOICE_TEXT = 40

/** A question a notification may answer, as the agent host gives it; null when it is not one. */
function parseQuestion(value: unknown): PushQuestion | null {
  if (typeof value !== 'object' || value === null) return null
  const { choices, text } = value as Record<string, unknown>
  if (typeof text !== 'boolean' || !Array.isArray(choices)) return null
  if (choices.length > MAX_QUESTION_CHOICES) return null
  const valid = choices.every(
    (choice) => typeof choice === 'string' && choice.length > 0 && choice.length <= MAX_CHOICE_TEXT,
  )
  if (!valid || (choices.length === 0 && !text)) return null
  return { choices: [...(choices as string[])], text }
}

function parseAnswer(value: unknown): { optionId: string; label: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const { optionId, name } = value as Record<string, unknown>
  return isId(optionId) && typeof name === 'string' && name.length > 0 && name.length <= 200
    ? { optionId, label: name }
    : null
}

const ACTION_KINDS = new Set(['execute', 'edit', 'review', 'question'])

/**
 * An attention message from the host's parent, as the remote host reads it; null when it is not
 * one. The parent passes on the agent host's, so it is checked like any message across processes.
 */
export function parseAttention(value: unknown): Attention | null {
  if (typeof value !== 'object' || value === null) return null
  const {
    kind,
    sessionId,
    agentId,
    changedFiles,
    window,
    key,
    level,
    title,
    body,
    request,
    front,
  } = value as Record<string, unknown>
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return null
  if (typeof title !== 'string' || typeof body !== 'string') return null
  if (title.length > MAX_TEXT || body.length > MAX_TEXT) return null
  const attention: Attention = {
    kind: kind as AttentionKind,
    title,
    body,
    inFront: false,
    devices: [],
  }
  if (kind === 'routine-paused') {
    if (!isId(agentId)) return null
    attention.agentId = agentId
  } else if (kind === 'plan-limit') {
    // The host's notice names the account and the window in its key, the window last.
    const named = isId(window)
      ? window
      : typeof key === 'string'
        ? key.slice(key.lastIndexOf(':') + 1)
        : null
    if (!isId(agentId) || !isId(named)) return null
    attention.agentId = agentId
    attention.window = named
    if (level === 'near') attention.limitLevel = 'warning'
    else if (level === 'reached') attention.limitLevel = level
  } else {
    if (!isId(sessionId)) return null
    attention.sessionId = sessionId
    if (isId(agentId)) attention.agentId = agentId
    if (
      typeof changedFiles === 'number' &&
      Number.isInteger(changedFiles) &&
      changedFiles > 0 &&
      changedFiles <= 10_000
    ) {
      attention.changedFiles = changedFiles
    }
  }
  if (kind === 'permission' && typeof request === 'object' && request !== null) {
    const { id, allow, deny, question, actionKind } = request as Record<string, unknown>
    if (isId(id)) {
      attention.requestId = id
      const allowed = parseAnswer(allow)
      if (allowed) {
        const denied = parseAnswer(deny)
        const actions: PushActions = { allow: allowed, ...(denied ? { deny: denied } : {}) }
        attention.actions = actions
      }
      const asked = allowed ? null : parseQuestion(question)
      if (asked) attention.question = asked
      if (typeof actionKind === 'string' && ACTION_KINDS.has(actionKind)) {
        attention.actionKind = actionKind as 'execute' | 'edit' | 'review' | 'question'
      }
    }
  }
  if (typeof front === 'object' && front !== null) {
    const { any, devices } = front as Record<string, unknown>
    attention.inFront = any === true
    if (Array.isArray(devices)) {
      attention.devices = devices.slice(0, MAX_FRONT_DEVICES).filter(isId)
    }
  }
  return attention
}

/** What waits for an answer by session, as the parent passes it on; null when it is not that. */
export function parseWaiting(value: unknown): Record<string, string[]> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const waiting: Record<string, string[]> = {}
  for (const [sessionId, ids] of Object.entries(value)) {
    if (!isId(sessionId) || !Array.isArray(ids) || !ids.every(isId)) return null
    waiting[sessionId] = ids
  }
  return waiting
}

const PHASES: readonly string[] = [
  'starting',
  'thinking',
  'writing',
  'command',
  'read',
  'search',
  'edit',
  'running',
  'approval',
  'question',
  'done',
  'error',
] satisfies ProgressPhase[]

const MAX_PROGRESS_SESSIONS = 1000

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isTime = (value: unknown): value is number | null => value === null || isCount(value)

const isText = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && value.length <= MAX_TEXT)

function parseSessionProgress(value: unknown): SessionProgress | null {
  if (typeof value !== 'object' || value === null) return null
  const { title, agent, phase, step, plan, startedAt, endedAt, subagents, waiting } =
    value as Record<string, unknown>
  if (typeof phase !== 'string' || !PHASES.includes(phase)) return null
  if (!isText(title) || !isText(agent) || !isText(step)) return null
  if (!isTime(startedAt) || !isTime(endedAt) || !isCount(subagents) || !isCount(waiting)) {
    return null
  }
  let parsedPlan: SessionProgress['plan'] = null
  if (plan !== null) {
    if (typeof plan !== 'object') return null
    const { done, total, current } = plan as Record<string, unknown>
    if (!isCount(done) || !isCount(total) || done > total || !isText(current)) return null
    parsedPlan = { done, total, current }
  }
  return {
    title,
    agent,
    phase: phase as ProgressPhase,
    step,
    plan: parsedPlan,
    startedAt,
    endedAt,
    subagents,
    waiting,
  }
}

/**
 * The sessions at work as the parent passes them on from the agent host; null when they are not
 * that, as for any message across processes.
 */
export function parseProgress(value: unknown): Record<string, SessionProgress> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_PROGRESS_SESSIONS) return null
  // No prototype, so a session id is only ever a key.
  const sessions = Object.create(null) as Record<string, SessionProgress>
  for (const [sessionId, entry] of entries) {
    const parsed = isId(sessionId) ? parseSessionProgress(entry) : null
    if (!parsed) return null
    sessions[sessionId] = parsed
  }
  return sessions
}

export class DeviceNotifications {
  private readonly notifier: Notifier
  private readonly sender: PushSender
  private readonly webSender: WebPushSender
  private readonly publicKey: string
  /**
   * Per browser, the tags of its notifications withdrawn since one of the same subject was sent,
   * by subject, oldest first. A push cannot withdraw a notification, so the page closes these.
   */
  private readonly withdrawn = new Map<string, Map<string, string>>()
  /** The discovery request the devices were told of, told once however often it changes. */
  private toldRequest: number | null = null

  constructor(private readonly options: DeviceNotificationsOptions) {
    const { devices } = options
    this.publicKey = encodeSealed(options.key.publicKey)
    this.sender = new PushSender({
      url: options.url,
      key: options.key,
      hostId: options.hostId,
      hostName: options.hostName,
      token: options.token,
      device: (id) => {
        const device = devices.get(id)
        const push = devices.push(id)
        return device && push ? { publicKey: device.publicKey, push } : null
      },
      unregistered: (deviceId, token) => void this.unregistered(deviceId, token),
      log: options.log,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
    })
    this.webSender = new WebPushSender({
      key: options.key,
      hostId: options.hostId,
      hostName: options.hostName,
      device: (id) => {
        const device = devices.get(id)
        const push = devices.push(id)
        return device && push?.web
          ? { publicKey: device.publicKey, web: push.web, details: push.choices.details }
          : null
      },
      secrets: (deviceId, web) => openWebPushSecrets(web, deviceId, options.storeKey),
      gone: (deviceId, endpoint) => void this.webGone(deviceId, endpoint),
      log: options.log,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
    })
    this.notifier = new Notifier({
      devices: () =>
        devices.list().flatMap((device): NotifierDevice[] => {
          const push = devices.push(device.id)
          return push ? [{ id: device.id, push }] : []
        }),
      showing: options.showing,
      // Huli: a device in the foreground keeps its own Live Activity.
      inFront: options.foreground,
      // A browser's page in view shows what the host tells it; Web Push is for a page in the
      // background or closed, which then shows none of its own.
      notifiesItself: (deviceId) => {
        const push = devices.push(deviceId)
        return Boolean(push?.web && !push.target && options.foreground(deviceId))
      },
      foreground: options.foreground,
      send: (job) => {
        this.sender.send(job)
        this.sendWeb(job)
        // An ended activity's token is spent; the next activity brings its own.
        if ((job.type === 'activity' || job.type === 'progress') && job.action === 'end') {
          void this.dropActivityToken(job.deviceId, job.type === 'progress' ? 'progress' : 'update')
        }
      },
      ...(options.mergeMs === undefined ? {} : { mergeMs: options.mergeMs }),
      ...(options.progressTiming ? { progressTiming: options.progressTiming } : {}),
      ...(options.now ? { now: options.now } : {}),
    })
  }

  /** What `notifications.get` answers the device. */
  state(deviceId: string): NotificationsState {
    const push = this.options.devices.push(deviceId)
    const target = push?.target
    const withdrawn = this.withdrawn.get(deviceId)
    return {
      choices: push?.choices ?? DEFAULT_CHOICES,
      target: {
        apns: Boolean(target),
        activityStart: Boolean(target?.activity?.start),
        activityUpdate: Boolean(target?.activity?.update),
        progress: Boolean(target?.activity?.progress),
      },
      web: push?.web
        ? { endpoint: push.web.endpoint, withdrawn: withdrawn ? [...withdrawn.values()] : [] }
        : null,
      signedIn: this.options.token() !== null,
      host: { id: this.options.hostId, key: this.publicKey },
    }
  }

  /**
   * `notifications.set`: the device's new target, subscription or choices, kept with it; null when
   * the device is gone, `invalid` for a subscription whose keys are not ones.
   */
  async update(
    deviceId: string,
    update: NotificationsUpdate,
  ): Promise<NotificationsState | 'invalid' | null> {
    const { devices } = this.options
    const before = devices.push(deviceId)
    const target = update.target === undefined ? (before?.target ?? null) : update.target
    const { activity } = target ?? {}
    for (const token of [
      target?.apns.token,
      activity?.start,
      activity?.update,
      activity?.progress?.token,
    ]) {
      if (token) addLogSecret(token)
    }
    let web = before?.web
    if (update.web === null) web = undefined
    else if (update.web) {
      if (!isUsableSubscription(update.web)) return 'invalid'
      const { endpoint, auth, vapid } = update.web
      for (const secret of [endpoint, auth, vapid.privateKey]) addLogSecret(secret)
      web = storeWebPush(update.web, deviceId, this.options.storeKey)
    }
    // A new subscription shows none of the old one's notifications.
    if (web?.endpoint !== before?.web?.endpoint) this.withdrawn.delete(deviceId)
    const next: DevicePush = {
      target,
      ...(web ? { web } : {}),
      choices: { ...(before?.choices ?? DEFAULT_CHOICES), ...update.choices },
    }
    if (!(await devices.setPush(deviceId, next))) return null
    this.notifier.deviceChanged()
    return this.state(deviceId)
  }

  attention(attention: Attention): void {
    this.notifier.attention(attention)
  }

  setWaiting(sessions: Record<string, string[]>): void {
    this.notifier.setWaiting(sessions)
  }

  setProgress(sessions: Record<string, SessionProgress>): void {
    this.notifier.setProgress(sessions)
  }

  /** The device came to the front or left it. */
  frontChanged(deviceId: string): void {
    this.notifier.frontChanged(deviceId)
  }

  seen(sessionId: string): void {
    this.notifier.seen(sessionId)
  }

  setPresent(present: boolean): void {
    this.notifier.setPresent(present)
  }

  /** A device of the account asks to be added, which the devices hear until it ends. */
  discoveryChanged({ requestId, request }: DiscoveryRequestEvent): void {
    if (request.state === 'closed') {
      if (this.toldRequest !== requestId) return
      this.toldRequest = null
      this.notifier.withdrawNotice(DEVICE_REQUEST_SUBJECT)
      return
    }
    if (this.toldRequest === requestId) return
    this.toldRequest = requestId
    const host = this.options.hostName()
    this.notifier.deviceNotice({
      subject: DEVICE_REQUEST_SUBJECT,
      event: { kind: 'device-request', requestId },
      title: t('push.deviceRequestTitle', { device: request.device.name, host }),
      body: t('push.deviceRequestBody'),
    })
  }

  /** A device joined: every other device hears it. */
  deviceJoined(device: PairedDevice): void {
    const host = this.options.hostName()
    this.notifier.deviceNotice(
      {
        subject: `device-joined:${device.id}`,
        event: { kind: 'device-joined', deviceId: device.id },
        title: t('push.deviceJoinedTitle', { device: device.name, host }),
        body: t('push.deviceJoinedBody'),
      },
      device.id,
    )
  }

  /** A device was removed, and its notifications with it. */
  forget(deviceId: string): void {
    this.notifier.forget(deviceId)
    this.withdrawn.delete(deviceId)
  }

  stop(): void {
    this.notifier.stop()
    this.sender.stop()
    this.webSender.stop()
  }

  /**
   * A job for a browser: an alert goes as Web Push. A withdrawal cannot, since every push shows
   * something, so its tag is kept for the page to close and sent to it if it is connected.
   */
  private sendWeb(job: PushJob): void {
    // Huli: a turn's Live Activity, as the device's own, is never a browser's either.
    if (job.type === 'activity' || job.type === 'progress') return
    if (!this.options.devices.push(job.deviceId)?.web) return
    const kept = this.withdrawn.get(job.deviceId)
    if (job.type === 'alert') {
      kept?.delete(job.subject)
      this.webSender.send(job)
      return
    }
    void this.withdraw(job.deviceId, job.subject)
  }

  private async withdraw(deviceId: string, subject: string): Promise<void> {
    const key = publicKeyBytes(this.options.devices.get(deviceId)?.publicKey)
    if (!key) return
    const tag = await pushTag(key, this.options.hostId, subject)
    const kept = this.withdrawn.get(deviceId) ?? new Map<string, string>()
    kept.delete(subject)
    kept.set(subject, tag)
    for (const oldest of kept.keys()) {
      if (kept.size <= MAX_WITHDRAWN) break
      kept.delete(oldest)
    }
    this.withdrawn.set(deviceId, kept)
    this.options.tell(deviceId, { type: 'notifications.withdrawn', tags: [tag] })
  }

  /** The push service dropped the subscription: the browser hears nothing until it sends one. */
  private async webGone(deviceId: string, endpoint: string): Promise<void> {
    const { devices } = this.options
    const push = devices.push(deviceId)
    if (push?.web?.endpoint !== endpoint) return
    await devices.setPush(deviceId, { target: push.target, choices: push.choices })
    this.withdrawn.delete(deviceId)
    this.notifier.deviceChanged()
  }

  private async unregistered(deviceId: string, token: PushTokenKind): Promise<void> {
    const { devices } = this.options
    const push = devices.push(deviceId)
    if (!push?.target) return
    // A dead device token ends every push to it; a dead activity token only that activity's.
    if (token === 'activity-progress') this.notifier.progressGone(deviceId)
    const target =
      token === 'device'
        ? null
        : withoutEmptyActivity({
            ...push.target,
            activity: {
              ...push.target.activity,
              ...(token === 'activity-start'
                ? { start: undefined }
                : token === 'activity-update'
                  ? { update: undefined }
                  : { progress: undefined }),
            },
          })
    await devices.setPush(deviceId, { ...push, target })
    this.notifier.deviceChanged()
  }

  private async dropActivityToken(deviceId: string, which: 'update' | 'progress'): Promise<void> {
    const { devices } = this.options
    const push = devices.push(deviceId)
    if (!push?.target?.activity?.[which]) return
    const target = withoutEmptyActivity({
      ...push.target,
      activity: { ...push.target.activity, [which]: undefined },
    })
    await devices.setPush(deviceId, { ...push, target })
  }
}

/** A target without the Live Activity tokens that are gone, and without the object when none is left. */
function withoutEmptyActivity(target: NonNullable<DevicePush['target']>): DevicePush['target'] {
  const start = target.activity?.start
  const update = target.activity?.update
  const progress = target.activity?.progress
  const { apns } = target
  if (!start && !update && !progress) return { apns }
  return {
    apns,
    activity: {
      ...(start ? { start } : {}),
      ...(update ? { update } : {}),
      ...(progress ? { progress } : {}),
    },
  }
}
