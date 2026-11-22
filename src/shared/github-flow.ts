// Huli: the GitHub flow. A project's open issues, each one a session away; a session's pull request
// merged once its checks pass, or watched for what its agent should hear; and routines that run on
// GitHub events. What the desktop and the phone both read is here.

import type { IssueLabel } from './git'

/** An open issue, as the issue inbox lists it. */
export interface InboxIssue {
  url: string
  number: number
  title: string
  labels: IssueLabel[]
  /** Their logins, the first few. */
  assignees: string[]
  author: string | null
  comments: number
  createdAt: number
  updatedAt: number
}

/** A project's open issues, the most recently updated first. */
export interface IssueInbox {
  owner: string
  repo: string
  /** The account gh is signed in as, which "assigned to me" means; null when unknown. */
  viewer: string | null
  issues: InboxIssue[]
  /** More open issues than one read lists. */
  truncated: boolean
  readAt: number
}

/** The most issues the inbox reads at once. */
export const INBOX_LIMIT = 100

/** Who the inbox lists: the issues assigned to the signed-in account, or every open one. */
export type InboxFilter = 'mine' | 'all'

/** The issue a session was started for, by its canonical URL. */
export interface SessionIssue {
  url: string
  owner: string
  repo: string
  number: number
}

/**
 * What a session's pull request automation sees now: waiting for checks or a review, the checks
 * failing, a conflict, merging, merged, or stopped (closed, or a merge that failed).
 */
export type PrFlowState =
  | 'waiting'
  | 'checks_failed'
  | 'conflict'
  | 'changes_requested'
  | 'blocked'
  | 'merging'
  | 'merged'
  | 'closed'
  | 'failed'

/** A session's pull request, merged once its checks pass, watched for its agent, or both. */
export interface SessionPrFlow {
  url: string
  number: number
  /** Merge it once every required check passes and GitHub says it can be merged. */
  autoMerge: boolean
  /** Tell the agent once of each new failure, conflict and review. */
  watch: boolean
  /** null until the pull request has been read. */
  state: PrFlowState | null
  /** Why it stopped, for `failed`. */
  message?: string
}

/** A GitHub event a routine runs on, in its project's repository. */
export type GithubEvent =
  | { kind: 'issue_opened'; label: string | null } // a new issue, with that label when set
  | { kind: 'pr_opened' } // a new pull request
  | { kind: 'checks_failed' } // an open pull request's checks fail
  | { kind: 'pushed'; branch: string } // commits pushed to the branch
  | { kind: 'behind'; branch: string } // the branch falls behind the default branch

export type GithubEventKind = GithubEvent['kind']

export const GITHUB_EVENT_KINDS: readonly GithubEventKind[] = [
  'issue_opened',
  'pr_opened',
  'checks_failed',
  'pushed',
  'behind',
]

export const EVENT_LABEL_CHARS = 50
export const EVENT_BRANCH_CHARS = 200

/** What a run on an event was for: the issue, pull request or branch, said in a line. */
export interface RunCause {
  kind: GithubEventKind
  title: string
  url: string | null
}

const BRANCH_CHARS = /^[^\s~^:?*[\\\0]+$/

/** Whether `name` could be a branch name: no spaces, no `..`, nothing git refuses in a ref. */
export function isBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= EVENT_BRANCH_CHARS &&
    BRANCH_CHARS.test(name) &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.includes('@{')
  )
}

/** Whether a GitHub event has the fields its kind needs. */
export function isGithubEvent(value: unknown): value is GithubEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  const keys = Object.keys(event)
  switch (event.kind) {
    case 'issue_opened':
      return (
        keys.every((key) => key === 'kind' || key === 'label') &&
        (event.label === null ||
          (typeof event.label === 'string' &&
            event.label.trim() !== '' &&
            event.label.length <= EVENT_LABEL_CHARS &&
            !/[\n\r\0,]/.test(event.label)))
      )
    case 'pr_opened':
    case 'checks_failed':
      return keys.length === 1
    case 'pushed':
    case 'behind':
      return (
        keys.every((key) => key === 'kind' || key === 'branch') &&
        typeof event.branch === 'string' &&
        isBranchName(event.branch)
      )
    default:
      return false
  }
}

export function isRunCause(value: unknown): value is RunCause {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const cause = value as Record<string, unknown>
  return (
    (GITHUB_EVENT_KINDS as readonly unknown[]).includes(cause.kind) &&
    typeof cause.title === 'string' &&
    cause.title.length <= 500 &&
    (cause.url === null ||
      (typeof cause.url === 'string' && cause.url.startsWith('https://github.com/')))
  )
}
