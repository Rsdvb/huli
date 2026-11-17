// The Live Activity the app runs itself while it is open: one session's turn at a time, the one
// that waits for the user first, else the latest to start, with how many others run or wait. The
// app updates it as the session list changes and ends it when the turns end. It starts with a push
// token, which the computer gets (activities.ts): a computer that follows turns keeps it up to date
// while the app is away, and the app leaves it alone meanwhile. With an older computer it goes
// stale in the background, and says so, until the app comes back and sets it right. An activity
// the computer started by push for a turn is taken up the same way.

import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import type { ThreadEntry } from '@shared/thread'
import type { TurnPhaseName } from '@shared/turn-phase'
import { HuliLive } from '../../modules/huli-live'
import { isMuted } from '../push/muted'
import { needsYou, sessionTitle } from '../sessions'
import { computerFollows, followedActivities, liveSnapshot, setProgressSource } from './activities'

/** Seconds after its last update before an activity counts as stale. */
const STALE_S = 20 * 60
/** How often an activity is renewed while nothing changes, so it never goes stale in use. */
const RENEW_MS = 5 * 60_000
/** How long a finished turn stays on the Lock Screen, in seconds. */
const LINGER_S = 15 * 60
/** How long an activity just started may be missing from the module's snapshot. */
const SETTLE_MS = 10_000
const MAX_TEXT = 120

/** As HuliLiveActivity.swift's LivePhase names them. */
type Phase =
  | 'starting'
  | 'thinking'
  | 'writing'
  | 'command'
  | 'read'
  | 'search'
  | 'edit'
  | 'approval'
  | 'question'
  | 'waiting'
  | 'running'
  | 'done'
  | 'error'

/** What the summary says the turn does, as the activity names it. */
const WORK_PHASES: Record<TurnPhaseName, Phase> = {
  thinking: 'thinking',
  execute: 'command',
  read: 'read',
  search: 'search',
  fetch: 'search',
  edit: 'edit',
  writing: 'writing',
  compacting: 'running',
  approval: 'approval',
  working: 'running',
}

/** HuliLocalState in modules/huli-live/ios/HuliActivityAttributes.swift. */
interface LocalState {
  sessionId: string
  title?: string
  agent?: string
  phase: Phase
  doing?: string
  startedAt?: number
  endedAt?: number
  running: number
  waiting: number
  planDone?: number
  planTotal?: number
  subagents?: number
}

export interface LocalInput {
  sessions: Map<string, SessionSummary>
  agents: Map<string, AgentStatus>
  hostName: string | null
  link: HostLink | null
  /** The app is in front: only then may an activity start. */
  foreground: boolean
  /** Live Activities are on in Huli's settings and allowed in the system's. */
  enabled: boolean
  /** Titles and what a session does stay off the Lock Screen. */
  hidden: boolean
}

interface Tracked {
  id: string
  sessionId: string
  /** The session and its turn, which the user may have dismissed. */
  turn: string
  json: string
  at: number
}

let tracked: Tracked | null = null
/** Turns whose activity the user dismissed: they do not come back. */
const declined = new Set<string>()
/** When a session was first seen busy, for a host too old to say when its turn started. */
const firstSeen = new Map<string, number>()
/** What a waiting session asks, by the session and its last change. */
const details = new Map<string, { phase: Phase; doing: string | null }>()
let latest: LocalInput | null = null
let looping = false

/** Brings the app's own activity in step with the input; calls in a burst coalesce. */
export function syncLocal(input: LocalInput): void {
  latest = input
  if (looping) return
  looping = true
  void (async () => {
    try {
      while (latest) {
        const next = latest
        latest = null
        await reconcile(next).catch(() => {})
      }
    } finally {
      looping = false
    }
  })()
}

const topLevel = (s: SessionSummary): boolean => s.parentId === null && s.archivedAt === null

function busyAs(s: SessionSummary): 'waiting' | 'running' | null {
  if (needsYou(s)) return 'waiting'
  if (s.status === 'running' || s.status === 'starting') return 'running'
  return null
}

function startOf(s: SessionSummary): number {
  if (s.turnStartedAt) return s.turnStartedAt
  let seen = firstSeen.get(s.id)
  if (seen === undefined) {
    seen = Date.now()
    firstSeen.set(s.id, seen)
  }
  return seen
}

const turnOf = (s: SessionSummary): string => `${s.id}:${startOf(s)}`

function clip(text: string): string {
  const line = text.split('\n')[0]!.trim()
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1)}…` : line
}

/** What waits first, as the session's requests say. */
function detailOf(entries: ThreadEntry[]): { phase: Phase; doing: string | null } {
  for (const entry of entries) {
    if (entry.kind !== 'tool' || !entry.permission) continue
    const { permission } = entry
    if (permission.plan) return { phase: 'approval', doing: '计划等你批准' }
    const question =
      entry.question ?? permission.questions?.[0]?.question ?? permission.elicitation?.message
    if (question) return { phase: 'question', doing: question }
    return { phase: 'approval', doing: entry.title || null }
  }
  return { phase: entries.length > 0 ? 'approval' : 'waiting', doing: null }
}

async function requestDetail(
  link: HostLink | null,
  s: SessionSummary,
): Promise<{ phase: Phase; doing: string | null }> {
  const key = `${s.id}:${s.updatedAt}:${s.permissionCount}`
  const known = details.get(key)
  if (known) return known
  let result: { phase: Phase; doing: string | null } = { phase: 'waiting', doing: null }
  if (link && link.state.kind === 'connected') {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
    const answer = await Promise.race([
      link.request('sessions.requests', { sessionId: s.id }) as Promise<{ entries: ThreadEntry[] }>,
      timeout,
    ]).catch(() => null)
    if (answer) result = detailOf(answer.entries)
  }
  if (details.size > 50) details.clear()
  details.set(key, result)
  return result
}

async function stateOf(
  s: SessionSummary,
  input: LocalInput,
  counts: { running: number; waiting: number },
): Promise<LocalState> {
  const agent = input.agents.get(s.agentId)?.name
  let phase: Phase = 'running'
  let doing: string | null = null
  if (busyAs(s) === 'waiting') {
    ;({ phase, doing } = await requestDetail(input.link, s))
  } else if (s.status === 'starting') {
    phase = 'starting'
  } else {
    // A host too old to say what the turn does leaves it running.
    if (s.working) phase = WORK_PHASES[s.working.phase]
    if (s.working?.step) doing = s.working.step
    else if (s.plan?.current) doing = `正在：${s.plan.current.text}`
  }
  let subagents = 0
  for (const other of input.sessions.values()) {
    if (other.parentId === s.id && (other.status === 'running' || other.status === 'starting')) {
      subagents++
    }
  }
  return {
    sessionId: s.id,
    ...(input.hidden ? {} : { title: sessionTitle(s) }),
    ...(agent ? { agent } : {}),
    phase,
    ...(doing && !input.hidden ? { doing: clip(doing) } : {}),
    startedAt: startOf(s),
    ...counts,
    ...(s.plan && s.plan.total > 0 ? { planDone: s.plan.done, planTotal: s.plan.total } : {}),
    ...(subagents > 0 ? { subagents } : {}),
  }
}

/** The tracked turn's last state, once nothing runs or waits any more. */
function finalState(previous: Tracked, session: SessionSummary | undefined): LocalState {
  let before: LocalState | undefined
  try {
    before = (JSON.parse(previous.json) as { local?: LocalState }).local
  } catch {
    before = undefined
  }
  const failed = session ? session.status === 'failed' || session.attention === 'error' : false
  return {
    ...(before ?? { sessionId: previous.sessionId }),
    phase: failed ? 'error' : 'done',
    doing: failed ? '这一轮出错了' : '这一轮已完成',
    endedAt: Date.now(),
    running: 0,
    waiting: 0,
    subagents: 0,
  }
}

// The computer follows the activity the app keeps, by its token and the session it shows.
setProgressSource(() => {
  if (!tracked?.sessionId) return null
  const id = tracked.id
  const entry = liveSnapshot().activities.find((a) => a.id === id)
  if (!entry?.token || (entry.state !== 'active' && entry.state !== 'stale')) return null
  return { token: entry.token, sessionId: tracked.sessionId }
})

async function reconcile(input: LocalInput): Promise<void> {
  const live = HuliLive
  if (!live) return
  const snapshot = liveSnapshot()
  const locals = [
    ...snapshot.activities.filter((a) => a.local && (a.state === 'active' || a.state === 'stale')),
    // One the computer started by push for a turn is the app's to keep while it is open.
    ...(await followedActivities().catch(() => [])),
  ]
  if (!input.enabled) {
    for (const activity of locals) await live.end(activity.id, '', 0).catch(() => {})
    tracked = null
    return
  }

  if (tracked) {
    const id = tracked.id
    const entry = snapshot.activities.find((a) => a.id === id)
    const gone = entry
      ? entry.state === 'ended' || entry.state === 'dismissed'
      : Date.now() - tracked.at > SETTLE_MS
    if (gone) {
      if (entry?.state === 'dismissed') declined.add(tracked.turn)
      tracked = null
    }
  }
  // One left from before the app last ran: carry on with it, and with no other.
  if (!tracked && locals[0]) {
    tracked = { id: locals[0].id, sessionId: locals[0].sessionId ?? '', turn: '', json: '', at: 0 }
  }
  for (const activity of locals) {
    if (activity.id !== tracked?.id) await live.end(activity.id, '', 0).catch(() => {})
  }

  const busy = [...input.sessions.values()].filter((s) => topLevel(s) && busyAs(s) !== null)
  for (const id of [...firstSeen.keys()]) {
    if (!busy.some((s) => s.id === id)) firstSeen.delete(id)
  }
  const counts = {
    running: busy.filter((s) => busyAs(s) === 'running').length,
    waiting: busy.filter((s) => busyAs(s) === 'waiting').length,
  }
  const trackedId = tracked?.sessionId
  const rank = (s: SessionSummary): number => (busyAs(s) === 'waiting' ? 0 : 1)
  // A session muted on this phone still counts, but never takes the Lock Screen.
  const focus = busy
    .filter((s) => !declined.has(turnOf(s)) && !isMuted(s.id))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(b.id === trackedId) - Number(a.id === trackedId) ||
        startOf(b) - startOf(a),
    )[0]

  // Away, a computer that follows turns keeps the activity; the app sets it right when it is back.
  if (tracked && !input.foreground && computerFollows()) return

  if (focus) {
    const json = JSON.stringify({ local: await stateOf(focus, input, counts) })
    const now = Date.now()
    if (tracked) {
      if (json === tracked.json && now - tracked.at < RENEW_MS) return
      await live.update(tracked.id, json, STALE_S)
      tracked = { ...tracked, sessionId: focus.id, turn: turnOf(focus), json, at: now }
    } else if (input.foreground) {
      const attributes = JSON.stringify(input.hostName ? { hostName: input.hostName } : {})
      const id = await live.start(attributes, json, STALE_S)
      tracked = { id, sessionId: focus.id, turn: turnOf(focus), json, at: now }
    }
    return
  }
  if (tracked) {
    const done = tracked
    tracked = null
    const json = JSON.stringify({ local: finalState(done, input.sessions.get(done.sessionId)) })
    await live.end(done.id, json, LINGER_S)
  }
}
