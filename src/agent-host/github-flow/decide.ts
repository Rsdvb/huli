// Huli: what the GitHub flow decides from what gh read: whether a pull request is merged now, what
// a watched one's agent hears, and which GitHub events start a routine's run. No I/O here.

import type { GithubEvent, PrFlowState, RunCause } from '@shared/github-flow'
import { t } from '../i18n'
import type { StoredTriggerCursor } from '../storage'
import {
  actionsJobOf,
  type FlowPullRequest,
  type LineComment,
  type MergeMethod,
  type OpenedPullRequest,
  type PullRequestChecks,
} from './gh-api'

/** The most keys a session or a routine remembers of the events it was told of. */
export const SEEN_KEPT = 200

const REVIEW_CHARS = 1500
const COMMENT_CHARS = 800
const ISSUE_BODY_CHARS = 4000
const MESSAGE_CHARS = 8000
const LINE_COMMENTS_LISTED = 10
const CONFLICTS_LISTED = 20

// Merging

export type MergeDecision =
  | { kind: 'merge'; method: MergeMethod; headOid: string }
  | { kind: 'wait'; state: PrFlowState }
  | { kind: 'stop'; state: 'merged' | 'closed' | 'failed'; message?: string }

export interface MergeContext {
  /** The session's agent is at work, and may push more. */
  busy: boolean
  /** The head that the previous read found ready with no checks at all, if any. */
  readyBefore: string | null
  /** The methods the repository allows; null when unknown. */
  methods: MergeMethod[] | null
}

/** The method a merge uses: squash, else a merge commit, else rebase, as the repository allows. */
export function mergeMethodOf(methods: MergeMethod[] | null): MergeMethod | null {
  if (methods === null) return 'squash'
  return (['squash', 'merge', 'rebase'] as const).find((method) => methods.includes(method)) ?? null
}

/**
 * Whether the pull request is merged now: open and not a draft, every check passed, GitHub says it
 * can be merged as it stands, no change asked for, and the session's agent idle. With no checks at
 * all, two reads in a row must find the same head ready, since checks may not have shown up yet.
 */
export function mergeDecision(pr: FlowPullRequest, context: MergeContext): MergeDecision {
  if (pr.state === 'merged') return { kind: 'stop', state: 'merged' }
  if (pr.state === 'closed') return { kind: 'stop', state: 'closed' }
  if (pr.state === 'draft') return { kind: 'wait', state: 'blocked' }
  if (pr.checks.state === 'failing') return { kind: 'wait', state: 'checks_failed' }
  if (pr.mergeable === 'conflicting' || pr.mergeState === 'DIRTY') {
    return { kind: 'wait', state: 'conflict' }
  }
  if (pr.review === 'changes_requested') return { kind: 'wait', state: 'changes_requested' }
  if (pr.checks.state === 'pending') return { kind: 'wait', state: 'waiting' }
  if (pr.mergeable !== 'mergeable') return { kind: 'wait', state: 'waiting' }
  if (pr.mergeState === 'BLOCKED' || pr.mergeState === 'BEHIND') {
    return { kind: 'wait', state: 'blocked' }
  }
  if (pr.mergeState !== 'CLEAN' && pr.mergeState !== 'HAS_HOOKS') {
    return { kind: 'wait', state: 'waiting' }
  }
  if (!/^[0-9a-f]{40}$/.test(pr.headOid)) return { kind: 'wait', state: 'waiting' }
  if (pr.checks.state === 'none' && context.readyBefore !== pr.headOid) {
    return { kind: 'wait', state: 'waiting' }
  }
  if (context.busy) return { kind: 'wait', state: 'waiting' }
  const method = mergeMethodOf(context.methods)
  if (!method) return { kind: 'stop', state: 'failed', message: t('githubFlow.noMethod') }
  return { kind: 'merge', method, headOid: pr.headOid }
}

/** The head a read found ready to merge but for its missing checks, for the next decision. */
export function readyHead(pr: FlowPullRequest): string | null {
  const ready =
    pr.state === 'open' &&
    pr.checks.state === 'none' &&
    pr.mergeable === 'mergeable' &&
    (pr.mergeState === 'CLEAN' || pr.mergeState === 'HAS_HOOKS')
  return ready ? pr.headOid : null
}

// Watching

export type WatchEvent =
  | { key: string; kind: 'checks_failed'; runs: { name: string; url: string | null }[] }
  | { key: string; kind: 'conflict' }
  | { key: string; kind: 'review'; author: string | null; state: string; body: string; at: number }
  | { key: string; kind: 'comment'; author: string | null; body: string; at: number }

/**
 * What the watched pull request's agent has not been told yet: failing checks and a conflict of
 * the current head, and each review and comment by someone other than the pull request's author.
 * Reviews and comments from before the watch began are taken as seen, not told; failing checks and
 * a conflict that are there when it begins are told, as the agent has something to fix.
 */
export function watchEvents(
  pr: FlowPullRequest,
  seen: ReadonlySet<string>,
  baselined: boolean,
): { events: WatchEvent[]; quiet: string[] } {
  const events: WatchEvent[] = []
  const quiet: string[] = []
  if (pr.state !== 'open' && pr.state !== 'draft') return { events, quiet }
  const add = (event: WatchEvent): void => {
    if (!seen.has(event.key)) events.push(event)
  }
  if (pr.checks.state === 'failing' && pr.headOid) {
    add({
      key: `checks:${pr.headOid}`,
      kind: 'checks_failed',
      runs: pr.checks.runs
        .filter((run) => run.outcome === 'failed')
        .map((run) => ({ name: run.name, url: run.url })),
    })
  }
  if (pr.mergeable === 'conflicting' && pr.headOid) {
    add({ key: `conflict:${pr.headOid}`, kind: 'conflict' })
  }
  const other = (login: string | null): boolean => login === null || login !== pr.author
  for (const review of pr.reviews) {
    if (!other(review.author)) continue
    if (review.state !== 'CHANGES_REQUESTED' && review.state !== 'COMMENTED') continue
    const key = `review:${review.id}`
    if (!baselined) {
      quiet.push(key)
      continue
    }
    add({
      key,
      kind: 'review',
      author: review.author,
      state: review.state,
      body: review.body,
      at: review.submittedAt,
    })
  }
  for (const comment of pr.comments) {
    if (!other(comment.author) || isBot(comment.author)) continue
    const key = `comment:${comment.id}`
    if (!baselined) {
      quiet.push(key)
      continue
    }
    add({ key, kind: 'comment', author: comment.author, body: comment.body, at: comment.createdAt })
  }
  return { events, quiet }
}

function isBot(login: string | null): boolean {
  return login !== null && (login.endsWith('[bot]') || login === 'github-actions')
}

/** Keeps the newest keys, the order they were told in. */
export function remember(seen: readonly string[], keys: readonly string[]): string[] {
  const next = [...seen.filter((key) => !keys.includes(key)), ...keys]
  return next.slice(-SEEN_KEPT)
}

function cut(value: string, chars: number): string {
  const trimmed = value.trim()
  const list = Array.from(trimmed)
  return list.length > chars ? `${list.slice(0, chars).join('').trimEnd()}…` : trimmed
}

function quote(value: string): string {
  return value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/**
 * The message the watched pull request's agent gets: what failed with links to the logs and the
 * command that prints them, the files in conflict, and what reviewers wrote.
 */
export function wakeMessage(
  pr: FlowPullRequest,
  events: readonly WatchEvent[],
  extra: { conflicts: string[] | null; lineComments: LineComment[] },
): string {
  const parts: string[] = [
    t('githubFlow.wake.intro', { number: pr.number, title: pr.title, url: pr.url }),
  ]
  for (const event of events) {
    switch (event.kind) {
      case 'checks_failed': {
        const lines = event.runs.map((run) => {
          const job = actionsJobOf(run.url)
          const log = job
            ? job.job
              ? ` — \`gh run view ${job.run} --job ${job.job} --log-failed\``
              : ` — \`gh run view ${job.run} --log-failed\``
            : ''
          return `- ${run.name}${run.url ? ` (${run.url})` : ''}${log}`
        })
        parts.push(
          `${t('githubFlow.wake.checks', { count: event.runs.length })}\n${lines.join('\n')}`,
        )
        break
      }
      case 'conflict': {
        const files = extra.conflicts ?? []
        const listed = files.slice(0, CONFLICTS_LISTED).map((file) => `- ${file}`)
        parts.push(
          [
            t('githubFlow.wake.conflict', { base: pr.base }),
            ...listed,
            ...(files.length > CONFLICTS_LISTED
              ? [t('githubFlow.wake.more', { count: files.length - CONFLICTS_LISTED })]
              : []),
          ].join('\n'),
        )
        break
      }
      case 'review': {
        const head =
          event.state === 'CHANGES_REQUESTED'
            ? t('githubFlow.wake.changesRequested', { author: event.author ?? '?' })
            : t('githubFlow.wake.reviewed', { author: event.author ?? '?' })
        const lines = extra.lineComments
          .filter((comment) => comment.author === event.author)
          .slice(0, LINE_COMMENTS_LISTED)
          .map(
            (comment) =>
              `- ${comment.path}${comment.line === null ? '' : `:${comment.line}`}: ${cut(comment.body, COMMENT_CHARS).replace(/\n+/g, ' ')}`,
          )
        parts.push(
          [
            head,
            ...(event.body.trim() ? [quote(cut(event.body, REVIEW_CHARS))] : []),
            ...lines,
          ].join('\n'),
        )
        break
      }
      case 'comment':
        parts.push(
          `${t('githubFlow.wake.commented', { author: event.author ?? '?' })}\n${quote(cut(event.body, COMMENT_CHARS))}`,
        )
        break
    }
  }
  parts.push(t('githubFlow.wake.outro'))
  return cut(parts.join('\n\n'), MESSAGE_CHARS)
}

// Routine triggers

/** What a routine's trigger remembers between reads; kept in the host's file. */
export type TriggerCursor = StoredTriggerCursor

/** What one read of the repository found, for the trigger's kind. */
export type TriggerSnapshot =
  | {
      kind: 'issue_opened'
      issues: {
        url: string
        number: number
        title: string
        body: string
        createdAt: number
        labels: string[]
      }[]
    }
  | { kind: 'pr_opened'; pulls: OpenedPullRequest[] }
  | { kind: 'checks_failed'; prs: PullRequestChecks[] }
  | { kind: 'pushed'; branch: string; oid: string | null }
  | { kind: 'behind'; branch: string; base: string; oid: string | null; behind: number | null }

/** An event that starts a run: what it is, and what the run's prompt gets about it. */
export interface TriggerFire {
  key: string
  cause: RunCause
  context: string
}

/**
 * The events a read found that the routine has not run for, oldest first, and the keys that the
 * first read takes as the state things are in. Only issues and pull requests opened after the
 * trigger was armed count; checks, pushes and a branch behind count from the first read on.
 */
export function triggerFires(
  event: GithubEvent,
  snapshot: TriggerSnapshot,
  cursor: TriggerCursor,
): { fires: TriggerFire[]; quiet: string[] } {
  const seen = new Set(cursor.seen)
  const fires: TriggerFire[] = []
  const quiet: string[] = []
  const found = (fire: TriggerFire, baseline: boolean): void => {
    if (seen.has(fire.key)) return
    if (baseline && !cursor.baselined) quiet.push(fire.key)
    else fires.push(fire)
  }
  if (event.kind === 'issue_opened' && snapshot.kind === 'issue_opened') {
    const label = event.label?.toLowerCase() ?? null
    for (const issue of [...snapshot.issues].sort((a, b) => a.number - b.number)) {
      if (issue.createdAt <= cursor.armedAt) continue
      if (label !== null && !issue.labels.some((name) => name.toLowerCase() === label)) continue
      const title = `#${issue.number} ${issue.title}`
      found(
        {
          key: `issue:${issue.number}`,
          cause: { kind: 'issue_opened', title, url: issue.url },
          context: [
            t('githubFlow.event.issue', { title }),
            issue.url,
            ...(issue.body.trim() ? ['', cut(issue.body, ISSUE_BODY_CHARS)] : []),
          ].join('\n'),
        },
        false,
      )
    }
  } else if (event.kind === 'pr_opened' && snapshot.kind === 'pr_opened') {
    for (const pull of [...snapshot.pulls].sort((a, b) => a.number - b.number)) {
      if (pull.createdAt <= cursor.armedAt) continue
      const title = `#${pull.number} ${pull.title}`
      found(
        {
          key: `pr:${pull.number}`,
          cause: { kind: 'pr_opened', title, url: pull.url },
          context: `${t('githubFlow.event.pr', { title })}\n${pull.url}`,
        },
        false,
      )
    }
  } else if (event.kind === 'checks_failed' && snapshot.kind === 'checks_failed') {
    for (const pr of [...snapshot.prs].sort((a, b) => a.number - b.number)) {
      if (pr.checks.state !== 'failing' || !pr.headOid) continue
      const title = `#${pr.number} ${pr.title}`
      const failed = pr.checks.runs
        .filter((run) => run.outcome === 'failed')
        .map((run) => `- ${run.name}${run.url ? ` (${run.url})` : ''}`)
      found(
        {
          key: `checks:${pr.number}:${pr.headOid}`,
          cause: { kind: 'checks_failed', title, url: pr.url },
          context: [t('githubFlow.event.checks', { title }), pr.url, ...failed].join('\n'),
        },
        true,
      )
    }
  } else if (event.kind === 'pushed' && snapshot.kind === 'pushed' && snapshot.oid) {
    if (!seen.has(`push:${snapshot.oid}`)) {
      const fire: TriggerFire = {
        key: `push:${snapshot.oid}`,
        cause: {
          kind: 'pushed',
          title: `${snapshot.branch} @ ${snapshot.oid.slice(0, 7)}`,
          url: null,
        },
        context: t('githubFlow.event.pushed', {
          branch: snapshot.branch,
          oid: snapshot.oid.slice(0, 12),
        }),
      }
      // Only the latest push is remembered, so a branch put back to an older tip runs again.
      if (!cursor.baselined) quiet.push(fire.key)
      else fires.push(fire)
    }
  } else if (event.kind === 'behind' && snapshot.kind === 'behind' && snapshot.oid) {
    if (snapshot.behind !== null && snapshot.behind > 0) {
      found(
        {
          key: `behind:${snapshot.oid}`,
          cause: {
            kind: 'behind',
            title: t('githubFlow.event.behindTitle', {
              branch: snapshot.branch,
              base: snapshot.base,
              count: snapshot.behind,
            }),
            url: null,
          },
          context: t('githubFlow.event.behind', {
            branch: snapshot.branch,
            base: snapshot.base,
            count: snapshot.behind,
          }),
        },
        true,
      )
    }
  }
  return { fires, quiet }
}

/** The cursor after a read: its quiet keys and the fires that ran remembered, pushes by the last. */
export function advanceCursor(
  cursor: TriggerCursor,
  event: GithubEvent,
  quiet: readonly string[],
  ran: readonly string[],
): TriggerCursor {
  const keys = [...quiet, ...ran]
  const seen =
    event.kind === 'pushed' && keys.length > 0
      ? [keys[keys.length - 1]!]
      : remember(cursor.seen, keys)
  return { ...cursor, baselined: true, seen }
}

/** The prompt a run on an event gets: the routine's own, then what happened. */
export function eventPrompt(prompt: string, context: string): string {
  return `${prompt}\n\n---\n${t('githubFlow.event.header')}\n\n${context}`
}
