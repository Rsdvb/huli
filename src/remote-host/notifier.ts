// When the host notifies its devices through the push gateway, decided from what the agent host
// reports: a request starts waiting, a turn ends out of view, a turn or a routine fails, a
// routine's run ends. Each device's choices decide what it hears; one that shows the session in
// front hears nothing of it; while the user is at the desktop app, its own notifications tell them
// and devices that want it only while the user is away wait until they leave. A session's
// notifications merge into one, and one that no longer applies, a request answered elsewhere or a
// turn seen since, is withdrawn. Requests that wait also drive each device's Live Activity.
//
// A device may also have a Live Activity follow a session's turn: one it started itself, whose
// token it hands over, or one the host starts by push for a turn that starts while the device is
// away, when it asked for that. While the device is connected in front it keeps the activity
// itself; otherwise the host keeps it up to date, within Apple's budget: a change that needs the
// user or a new session at once, another phase at most every 10 s and other details every 20 s,
// those as low-priority updates, a renewal before the state goes stale, and a last state that stays
// a while once nothing runs.

import type { SessionProgress } from '@shared/host-control'
import type {
  DevicePush,
  NotificationChoices,
  ProgressPhase,
  ProgressState,
  PushActions,
  PushEvent,
  PushQuestion,
} from '@shared/remote/push'

export type AttentionKind =
  'permission' | 'turn-ended' | 'error' | 'routine-ended' | 'routine-paused'

/** What the agent host says needs the user, as the remote host hears it from its parent. */
export interface Attention {
  kind: AttentionKind
  /** Every kind but `routine-paused`, which names its agent instead. */
  sessionId?: string
  agentId?: string
  title: string
  body: string
  /** The request that waits, which the waiting list names until it is answered or withdrawn. */
  requestId?: string
  /** The one-time answers a notification may offer, when the request fits in one. */
  actions?: PushActions
  /** The ask's only question, when a notification may answer it. */
  question?: PushQuestion
  /** The session was in front of a window or a device when this happened. */
  inFront: boolean
  /** The devices that had it in front then. */
  devices: string[]
}

/** A push for the sender to seal, sign and send. */
export type PushJob = {
  deviceId: string
  /** What the notification's tag is made of: a session's id, `routines:<agent>` or `activity`. */
  subject: string
} & (
  | { type: 'alert'; event: PushEvent; title: string; body: string }
  | { type: 'background'; event: PushEvent }
  | {
      type: 'activity'
      action: 'start' | 'update' | 'end'
      count: number
      sessionId: string | null
      title: string | null
    }
  | {
      type: 'progress'
      action: 'start' | 'update' | 'end'
      state: ProgressContent
      /** May wait for a good moment, so Apple does not count it against the activity's budget. */
      low: boolean
      /** How long the state stays fresh, and how long an ended activity stays, in seconds. */
      staleS: number
      lingerS: number
    }
)

/** A turn's activity's state as the host decides it, before the sender seals it. */
export type ProgressContent = { title?: string } & Omit<ProgressState, 'kind' | 'format'>

export interface NotifierDevice {
  id: string
  push: DevicePush
}

/** The timing of the activities that follow a turn; tests shorten it. */
export interface ProgressTiming {
  /** The least time between updates of another phase, and of another detail of the same. */
  phaseGapMs: number
  detailGapMs: number
  /** How long a state stays fresh, and when one that did not change is sent again before that. */
  staleS: number
  renewMs: number
  /** How long an ended turn's activity stays on the Lock Screen. */
  lingerS: number
  /** How long an activity started by push waits for its token from the device. */
  tokenWaitMs: number
  /** The least time between two activities a device's push starts. */
  startGapMs: number
}

const PROGRESS_TIMING: ProgressTiming = {
  phaseGapMs: 10_000,
  detailGapMs: 20_000,
  staleS: 30 * 60,
  renewMs: 15 * 60_000,
  lingerS: 15 * 60,
  tokenWaitMs: 10 * 60_000,
  startGapMs: 60_000,
}

export interface NotifierOptions {
  /** The paired devices that set notifications. */
  devices(): NotifierDevice[]
  /** Whether the device shows the session in front now. */
  showing(deviceId: string, sessionId: string): boolean
  /** Whether the device is connected in the foreground, where it keeps its own Live Activity. */
  inFront?(deviceId: string): boolean
  send(job: PushJob): void
  /** How long a device's notifications of one subject wait to merge into one. */
  mergeMs?: number
  progressTiming?: Partial<ProgressTiming>
  now?: () => number
}

/** The subject of the Live Activity's tag. */
export const ACTIVITY_SUBJECT = 'activity'
/** The subject of the tag of the activity that follows a turn. */
export const PROGRESS_SUBJECT = 'progress'

const MERGE_MS = 1000

/** Phases that need the user, which reach the activity at once. */
const NEEDS_YOU: ReadonlySet<ProgressPhase> = new Set(['approval', 'question'])
/** The turns a device remembers having had an activity for, so a push starts none again. */
const MAX_TURNS = 200

/** A device's activity that follows a turn, as the host keeps it. */
interface ProgressActivity {
  /** Its token; null while one started by push waits for it. */
  token: string | null
  /** The session it shows now. */
  sessionId: string
  /** What it showed last, as JSON, and its session and phase; when that was sent. */
  sentKey: string
  phaseKey: string
  sentAt: number
  last: ProgressContent | null
  /** When it was started by push, for one waiting for its token. */
  startedAt: number
  timer: NodeJS.Timeout | null
  dueAt: number
}

const turnOf = (sessionId: string, progress: SessionProgress): string =>
  `${sessionId}:${progress.startedAt ?? 0}`

/** What a device's notification of a subject is about now. */
interface Told {
  kind: AttentionKind
  requestId: string | undefined
}

interface Activity {
  running: boolean
  count: number
  sessionId: string | null
}

const subjectOf = (attention: Attention): string =>
  attention.kind === 'routine-paused' ? `routines:${attention.agentId}` : attention.sessionId!

function wants(choices: NotificationChoices, kind: AttentionKind): boolean {
  switch (kind) {
    case 'permission':
      return choices.permission
    case 'turn-ended':
      return choices.turnEnded
    case 'error':
      return choices.errors
    case 'routine-ended':
    case 'routine-paused':
      return choices.routines
  }
}

function pushEvent(attention: Attention): PushEvent {
  switch (attention.kind) {
    case 'permission':
      return {
        kind: 'permission',
        sessionId: attention.sessionId!,
        ...(attention.requestId ? { requestId: attention.requestId } : {}),
        ...(attention.actions ? { actions: attention.actions } : {}),
        ...(attention.question ? { question: attention.question } : {}),
      }
    case 'routine-paused':
      return { kind: 'routine-paused', agentId: attention.agentId! }
    default:
      return { kind: attention.kind, sessionId: attention.sessionId! }
  }
}

export class Notifier {
  /** Whether the user is at the desktop app; null where the host cannot tell, as the daemon. */
  private present: boolean | null = null
  /** What waits for an answer, by session: the ids the agent host listed. */
  private waiting = new Map<string, Set<string>>()
  /** Sessions by when a request in them last started waiting, the newest last. */
  private order: string[] = []
  /** Per subject, what a device may still need to hear: a request that waits or a turn not seen. */
  private readonly open = new Map<string, Attention>()
  /** Per device, what its notification of each subject is about. */
  private readonly told = new Map<string, Map<string, Told>>()
  /** Per device and subject, the notification waiting to merge with a newer one. */
  private readonly queued = new Map<string, { attention: Attention; timer: NodeJS.Timeout }>()
  private readonly activities = new Map<string, Activity>()
  private readonly activityTimers = new Map<string, NodeJS.Timeout>()
  private readonly mergeMs: number
  /** The sessions at work and the ones whose turn just ended, as the agent host last said. */
  private progress: Record<string, SessionProgress> = {}
  /** Per device, its activity that follows a turn. */
  private readonly progressActivities = new Map<string, ProgressActivity>()
  /** Per device, the turns that had an activity, and when a push last started one. */
  private readonly progressTurns = new Map<string, Set<string>>()
  private readonly progressStarted = new Map<string, number>()
  /** Per device, the token of the activity the host last ended or Apple refused, until it is gone. */
  private readonly spentTokens = new Map<string, string>()
  /** Per device, when it last left the front; a turn started before then is not started by push. */
  private readonly awaySince = new Map<string, number>()
  private readonly timing: ProgressTiming
  private readonly now: () => number
  private stopped = false

  constructor(private readonly options: NotifierOptions) {
    this.mergeMs = options.mergeMs ?? MERGE_MS
    this.timing = { ...PROGRESS_TIMING, ...options.progressTiming }
    this.now = options.now ?? Date.now
  }

  /** Something needs the user. */
  attention(attention: Attention): void {
    if (attention.kind === 'routine-paused' ? !attention.agentId : !attention.sessionId) return
    // A turn that ended in front of someone was seen there.
    if (attention.kind === 'turn-ended' && attention.inFront) return
    const subject = subjectOf(attention)
    if (attention.kind !== 'routine-paused') this.open.set(subject, attention)
    if (attention.kind === 'permission') {
      this.order = [...this.order.filter((id) => id !== subject), subject]
    }
    for (const device of this.options.devices()) this.consider(device, subject, attention)
    if (attention.kind === 'permission') this.activitiesChanged()
  }

  /** What waits for an answer now, by session; requests answered or withdrawn are gone from it. */
  setWaiting(sessions: Record<string, string[]>): void {
    this.waiting = new Map(
      Object.entries(sessions)
        .filter(([, ids]) => ids.length > 0)
        .map(([sessionId, ids]) => [sessionId, new Set(ids)]),
    )
    this.order = this.order.filter((sessionId) => this.waiting.has(sessionId))
    for (const [subject, attention] of this.open) {
      if (attention.kind === 'permission' && !this.stillWaiting(attention))
        this.open.delete(subject)
    }
    for (const [key, queued] of this.queued) {
      if (queued.attention.kind === 'permission' && !this.stillWaiting(queued.attention)) {
        clearTimeout(queued.timer)
        this.queued.delete(key)
      }
    }
    for (const [deviceId, told] of this.told) {
      for (const [subject, what] of told) {
        // Another request of the session may still wait, whose answer finds out it was answered.
        if (what.kind === 'permission' && !this.waiting.has(subject)) {
          this.withdraw(deviceId, subject, told)
        }
      }
    }
    this.activitiesChanged()
  }

  /** A session was seen: its turn's notifications no longer apply. */
  seen(sessionId: string): void {
    const attention = this.open.get(sessionId)
    if (attention && attention.kind !== 'permission') this.open.delete(sessionId)
    for (const [key, queued] of this.queued) {
      if (subjectOf(queued.attention) === sessionId && queued.attention.kind !== 'permission') {
        clearTimeout(queued.timer)
        this.queued.delete(key)
      }
    }
    for (const [deviceId, told] of this.told) {
      const what = told.get(sessionId)
      if (what && what.kind !== 'permission') this.withdraw(deviceId, sessionId, told)
    }
  }

  /**
   * Whether the user is at the desktop app now. Once they leave, what still waits and the turns
   * not seen reach the devices that held them back.
   */
  setPresent(present: boolean): void {
    const was = this.present
    this.present = present
    if (present || was !== true) return
    for (const device of this.options.devices()) {
      for (const [subject, attention] of this.open) {
        const what = this.told.get(device.id)?.get(subject)
        if (what?.kind === attention.kind && what.requestId === attention.requestId) continue
        this.consider(device, subject, attention)
      }
      this.updateProgress(device.id)
    }
    this.activitiesChanged()
  }

  /** A device changed its target or choices: its Live Activities follow. */
  deviceChanged(): void {
    this.activitiesChanged()
    for (const device of this.options.devices()) this.updateProgress(device.id)
  }

  /** The sessions at work now, and the ones whose turn just ended, once, with how. */
  setProgress(sessions: Record<string, SessionProgress>): void {
    this.progress = sessions
    for (const device of this.options.devices()) this.updateProgress(device.id)
  }

  /**
   * The device came to the front or left it. Leaving, it hands its activity over as it showed it,
   * so the host sends only what changes after.
   */
  frontChanged(deviceId: string): void {
    const state = this.progressActivities.get(deviceId)
    const away = !this.options.inFront?.(deviceId)
    if (away) this.awaySince.set(deviceId, this.now())
    if (state && away) {
      const device = this.options.devices().find((entry) => entry.id === deviceId)
      const next = device && this.progressNext(device, state)
      if (next && next.content.sessionId === state.sessionId) {
        state.sentKey = JSON.stringify(next.content)
        state.phaseKey = `${next.content.sessionId}:${next.content.phase}`
        state.last = next.content
        state.sentAt = this.now()
      }
    }
    this.updateProgress(deviceId)
  }

  /**
   * Apple no longer takes the token of the device's activity that follows a turn: the user removed
   * it, or it ended. Its turn gets no other by push.
   */
  progressGone(deviceId: string): void {
    const state = this.progressActivities.get(deviceId)
    const progress = state && this.progress[state.sessionId]
    if (state && progress) this.rememberTurn(deviceId, turnOf(state.sessionId, progress))
    this.dropProgress(deviceId)
  }

  /** A device was removed: nothing more goes to it. */
  forget(deviceId: string): void {
    this.told.delete(deviceId)
    this.activities.delete(deviceId)
    const timer = this.activityTimers.get(deviceId)
    if (timer) clearTimeout(timer)
    this.activityTimers.delete(deviceId)
    for (const [key, queued] of this.queued) {
      if (key.startsWith(`${deviceId}\n`)) {
        clearTimeout(queued.timer)
        this.queued.delete(key)
      }
    }
    this.dropProgress(deviceId)
    this.progressTurns.delete(deviceId)
    this.progressStarted.delete(deviceId)
    this.spentTokens.delete(deviceId)
    this.awaySince.delete(deviceId)
  }

  stop(): void {
    this.stopped = true
    for (const queued of this.queued.values()) clearTimeout(queued.timer)
    this.queued.clear()
    for (const timer of this.activityTimers.values()) clearTimeout(timer)
    this.activityTimers.clear()
    for (const state of this.progressActivities.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    this.progressActivities.clear()
  }

  private held(choices: NotificationChoices): boolean {
    return choices.onlyAway && this.present === true
  }

  /** Queues the attention for a device that wants it now. */
  private consider(device: NotifierDevice, subject: string, attention: Attention): void {
    const { target, choices } = device.push
    if (!target || !wants(choices, attention.kind) || this.held(choices)) return
    const { sessionId } = attention
    if (sessionId !== undefined) {
      if (choices.muted.includes(sessionId)) return
      if (attention.devices.includes(device.id)) return
      if (this.options.showing(device.id, sessionId)) return
    }
    const key = `${device.id}\n${subject}`
    const queued = this.queued.get(key)
    if (queued) clearTimeout(queued.timer)
    const timer = setTimeout(() => {
      this.queued.delete(key)
      this.deliver(device.id, subject, attention)
    }, this.mergeMs)
    timer.unref?.()
    this.queued.set(key, { attention, timer })
  }

  private deliver(deviceId: string, subject: string, attention: Attention): void {
    const device = this.options.devices().find((entry) => entry.id === deviceId)
    if (!device?.push.target || this.held(device.push.choices)) return
    if (attention.sessionId !== undefined && this.options.showing(deviceId, attention.sessionId)) {
      return
    }
    if (!this.applies(subject, attention)) return
    let told = this.told.get(deviceId)
    if (!told) {
      told = new Map()
      this.told.set(deviceId, told)
    }
    told.set(subject, { kind: attention.kind, requestId: attention.requestId })
    this.options.send({
      deviceId,
      subject,
      type: 'alert',
      event: pushEvent(attention),
      title: attention.title,
      body: attention.body,
    })
  }

  /** Whether the attention still needs the user: its request waits, or its turn was not seen. */
  private applies(subject: string, attention: Attention): boolean {
    if (attention.kind === 'routine-paused') return true
    if (attention.kind === 'permission') return this.stillWaiting(attention)
    return this.open.get(subject) === attention
  }

  private stillWaiting(attention: Attention): boolean {
    const ids = this.waiting.get(attention.sessionId!)
    if (!ids) return false
    // A routine's request names none: its session waiting is enough.
    return attention.requestId === undefined || ids.has(attention.requestId)
  }

  private withdraw(deviceId: string, subject: string, told: Map<string, Told>): void {
    told.delete(subject)
    const event: PushEvent = subject.startsWith('routines:')
      ? { kind: 'withdraw' }
      : { kind: 'withdraw', sessionId: subject }
    this.options.send({ deviceId, subject, type: 'background', event })
  }

  /** Each device's Live Activity catches up after a moment, so a burst sends one update. */
  private activitiesChanged(): void {
    for (const device of this.options.devices()) {
      if (this.activityTimers.has(device.id)) continue
      const timer = setTimeout(() => {
        this.activityTimers.delete(device.id)
        this.updateActivity(device.id)
      }, this.mergeMs)
      timer.unref?.()
      this.activityTimers.set(device.id, timer)
    }
  }

  private updateActivity(deviceId: string): void {
    const device = this.options.devices().find((entry) => entry.id === deviceId)
    const state = this.activities.get(deviceId) ?? { running: false, count: 0, sessionId: null }
    const target = device?.push.target
    const tokens = target?.activity
    const choices = device?.push.choices
    const enabled = Boolean(target && choices?.permission && (tokens?.start || tokens?.update))
    let count = 0
    let latest: string | null = null
    if (enabled && choices) {
      for (const [sessionId, ids] of this.waiting) {
        if (!choices.muted.includes(sessionId)) count += ids.size
      }
      latest = this.order.findLast((sessionId) => !choices.muted.includes(sessionId)) ?? null
    }
    const title = latest ? (this.open.get(latest)?.title ?? null) : null
    const send = (action: 'start' | 'update' | 'end'): void =>
      this.options.send({
        deviceId,
        subject: ACTIVITY_SUBJECT,
        type: 'activity',
        action,
        count,
        sessionId: latest,
        title,
      })
    if (count > 0) {
      if (!state.running) {
        if (!tokens?.start || this.held(choices!)) return
        // An activity that follows a turn says what waits too.
        if (this.progressActivities.has(deviceId)) return
        send('start')
      } else {
        if (count === state.count && latest === state.sessionId) return
        // The activity's own token comes from the device after it starts; the update waits for it.
        if (!tokens?.update) return
        send('update')
      }
      this.activities.set(deviceId, { running: true, count, sessionId: latest })
      return
    }
    if (!state.running) return
    // Without the activity's own token it cannot be ended by push; the app ends it when it opens.
    if (tokens?.update) send('end')
    this.activities.delete(deviceId)
  }

  /** Brings the device's activity that follows a turn in step with the sessions at work. */
  private updateProgress(deviceId: string): void {
    if (this.stopped) return
    const device = this.options.devices().find((entry) => entry.id === deviceId)
    const target = device?.push.target
    if (!device || !target) {
      this.dropProgress(deviceId)
      return
    }
    const given = target.activity?.progress
    const handed = given && given.token !== this.spentTokens.get(deviceId) ? given : undefined
    let state = this.progressActivities.get(deviceId)
    if (handed && handed.token !== state?.token) {
      if (state?.timer) clearTimeout(state.timer)
      // One started by push carries on with what it was started with.
      const started = state && state.token === null ? state : null
      state = {
        token: handed.token,
        sessionId: started?.sessionId ?? handed.sessionId,
        sentKey: started?.sentKey ?? '',
        phaseKey: started?.phaseKey ?? '',
        sentAt: started?.sentAt ?? 0,
        last: started?.last ?? null,
        startedAt: 0,
        timer: null,
        dueAt: 0,
      }
      this.progressActivities.set(deviceId, state)
    } else if (!handed && state?.token) {
      // The device ended its activity.
      this.dropProgress(deviceId)
      state = undefined
    }
    if (this.options.inFront?.(deviceId)) {
      if (state && handed) state.sessionId = handed.sessionId
      return
    }
    const next = this.progressNext(device, state)
    if (state?.token) {
      if (next) this.progressUpdate(deviceId, state, next.content)
      else this.progressEnd(device, state)
      return
    }
    if (state) {
      // Started by push, it waits a while for its token.
      if (this.now() - state.startedAt > this.timing.tokenWaitMs) this.dropProgress(deviceId)
      return
    }
    if (next) this.progressStart(device, next.content, next.turn)
  }

  /** What the device's activity shows now: the session that needs the user first, else the one it
   * shows, else the latest to start; null when no session it hears of is at work. */
  private progressNext(
    device: NotifierDevice,
    state: ProgressActivity | undefined,
  ): { content: ProgressContent; turn: string } | null {
    const { choices } = device.push
    const counts = { running: 0, waiting: 0 }
    let focus: [string, SessionProgress] | null = null
    const rank = ([id, progress]: [string, SessionProgress]): number[] => [
      progress.waiting > 0 ? 1 : 0,
      id === state?.sessionId ? 1 : 0,
      progress.startedAt ?? 0,
    ]
    for (const entry of Object.entries(this.progress)) {
      const [id, progress] = entry
      if (progress.endedAt !== null) continue
      if (progress.waiting > 0) counts.waiting++
      else counts.running++
      // A muted session still counts, but never takes the Lock Screen.
      if (choices.muted.includes(id)) continue
      if (!focus || isAhead(rank(entry), rank(focus))) focus = entry
    }
    if (!focus) return null
    const [id, progress] = focus
    return {
      content: progressContent(id, progress, counts, choices.details),
      turn: turnOf(id, progress),
    }
  }

  private progressUpdate(
    deviceId: string,
    state: ProgressActivity,
    content: ProgressContent,
  ): void {
    const now = this.now()
    const key = JSON.stringify(content)
    const phaseKey = `${content.sessionId}:${content.phase}`
    if (key === state.sentKey) {
      // Sent again before it goes stale, at the low priority.
      const renewAt = state.sentAt + this.timing.renewMs
      if (now < renewAt) this.progressLater(deviceId, state, renewAt)
      else this.progressSend(deviceId, state, 'update', content, true)
      return
    }
    const sameSession = state.phaseKey.startsWith(`${content.sessionId}:`)
    const urgent =
      state.phaseKey === '' ||
      !sameSession ||
      (phaseKey !== state.phaseKey && NEEDS_YOU.has(content.phase))
    const gap = urgent
      ? 0
      : phaseKey !== state.phaseKey
        ? this.timing.phaseGapMs
        : this.timing.detailGapMs
    if (now < state.sentAt + gap) {
      this.progressLater(deviceId, state, state.sentAt + gap)
      return
    }
    this.progressSend(deviceId, state, 'update', content, !urgent)
  }

  /** Nothing runs any more: the last state, how the turn it showed ended, stays a while. */
  private progressEnd(device: NotifierDevice, state: ProgressActivity): void {
    const ended = this.progress[state.sessionId]
    const now = this.now()
    const content: ProgressContent =
      ended && ended.endedAt !== null
        ? progressContent(
            state.sessionId,
            ended,
            { running: 0, waiting: 0 },
            device.push.choices.details,
          )
        : {
            ...(state.last?.title === undefined ? {} : { title: state.last.title }),
            sessionId: state.sessionId,
            phase: 'done',
            ...(state.last?.agent === undefined ? {} : { agent: state.last.agent }),
            ...(state.last?.startedAt === undefined ? {} : { startedAt: state.last.startedAt }),
            endedAt: now,
            subagents: 0,
            running: 0,
            waiting: 0,
          }
    if (ended) this.rememberTurn(device.id, turnOf(state.sessionId, ended))
    this.progressSend(device.id, state, 'end', content, false)
    this.dropProgress(device.id)
  }

  /** Starts an activity by push for a turn that started while the device was away. */
  private progressStart(device: NotifierDevice, content: ProgressContent, turn: string): void {
    const { choices, target } = device.push
    if (!choices.liveProgress || !target?.activity?.start || this.held(choices)) return
    // The activity of what waits shows the user already.
    if (this.activities.get(device.id)?.running) return
    if (this.progressTurns.get(device.id)?.has(turn)) return
    // A turn that started in front of the device was the device's to follow, or to decline.
    const since = this.awaySince.get(device.id) ?? 0
    if (content.startedAt === undefined || content.startedAt < since) return
    const now = this.now()
    const last = this.progressStarted.get(device.id)
    if (last !== undefined && now - last < this.timing.startGapMs) return
    this.progressStarted.set(device.id, now)
    const state: ProgressActivity = {
      token: null,
      sessionId: content.sessionId,
      sentKey: '',
      phaseKey: '',
      sentAt: 0,
      last: null,
      startedAt: now,
      timer: null,
      dueAt: 0,
    }
    this.progressActivities.set(device.id, state)
    this.rememberTurn(device.id, turn)
    this.progressSend(device.id, state, 'start', content, false)
  }

  private progressSend(
    deviceId: string,
    state: ProgressActivity,
    action: 'start' | 'update' | 'end',
    content: ProgressContent,
    low: boolean,
  ): void {
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    state.sentKey = JSON.stringify(content)
    state.phaseKey = `${content.sessionId}:${content.phase}`
    state.sessionId = content.sessionId
    state.last = content
    state.sentAt = this.now()
    this.options.send({
      deviceId,
      subject: PROGRESS_SUBJECT,
      type: 'progress',
      action,
      state: content,
      low,
      staleS: this.timing.staleS,
      lingerS: this.timing.lingerS,
    })
    if (action !== 'end') this.progressLater(deviceId, state, state.sentAt + this.timing.renewMs)
  }

  /** Looks at the device's activity again at `at`, or sooner when that was due already. */
  private progressLater(deviceId: string, state: ProgressActivity, at: number): void {
    if (state.timer && state.dueAt <= at) return
    if (state.timer) clearTimeout(state.timer)
    state.dueAt = at
    state.timer = setTimeout(
      () => {
        state.timer = null
        this.updateProgress(deviceId)
      },
      Math.max(0, at - this.now()),
    )
    state.timer.unref?.()
  }

  private dropProgress(deviceId: string): void {
    const state = this.progressActivities.get(deviceId)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    // Its token may still be in the device's target for a moment; it is not followed again.
    if (state.token) this.spentTokens.set(deviceId, state.token)
    this.progressActivities.delete(deviceId)
  }

  private rememberTurn(deviceId: string, turn: string): void {
    let turns = this.progressTurns.get(deviceId)
    if (!turns) {
      turns = new Set()
      this.progressTurns.set(deviceId, turns)
    }
    turns.delete(turn)
    turns.add(turn)
    for (const old of turns) {
      if (turns.size <= MAX_TURNS) break
      turns.delete(old)
    }
  }
}

/** Whether a rank comes before another, compared part by part. */
function isAhead(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

/** A turn's activity's state; without details, the phase and the counts alone. */
function progressContent(
  sessionId: string,
  progress: SessionProgress,
  counts: { running: number; waiting: number },
  details: boolean,
): ProgressContent {
  const { plan } = progress
  return {
    ...(details && progress.title ? { title: progress.title } : {}),
    sessionId,
    phase: progress.phase,
    ...(progress.agent ? { agent: progress.agent } : {}),
    ...(details && progress.step ? { step: progress.step } : {}),
    ...(plan
      ? {
          plan: {
            done: plan.done,
            total: plan.total,
            ...(details && plan.current ? { current: plan.current } : {}),
          },
        }
      : {}),
    ...(progress.startedAt === null ? {} : { startedAt: progress.startedAt }),
    ...(progress.endedAt === null ? {} : { endedAt: progress.endedAt }),
    subagents: progress.subagents,
    ...counts,
  }
}
