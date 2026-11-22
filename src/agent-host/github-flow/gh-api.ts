// Huli: what the GitHub flow asks the user's gh for, and how its answers map. REST reads carry the
// last ETag, so an answer that did not change costs no rate limit; the one write is the merge.

import {
  GITHUB_LOGIN,
  GITHUB_PULL_REQUEST_URL,
  isRepositoryName,
  type IssueLabel,
  type PullRequest,
  type PullRequestState,
} from '@shared/git'
import { INBOX_LIMIT, type InboxIssue } from '@shared/github-flow'
import { describeFailure, GH_TIMEOUT_MS, type Exec } from '../git/exec'
import { summarizeChecks } from '../git/github'

const MERGE_TIMEOUT_MS = 60_000
const ASSIGNEES_KEPT = 3

export interface Repo {
  owner: string
  repo: string
}

export type GhFailure = { ok: false; reason: 'not-installed' | 'failed'; message: string }

/** A REST read: its JSON with the ETag to send next time, or `unchanged` for a 304. */
export type RestRead =
  | { ok: true; unchanged: false; json: unknown; etag: string | null; next: boolean }
  | { ok: true; unchanged: true }
  | GhFailure

/** Throws on an owner or name GitHub would not take, so neither reaches a path or an argument. */
export function checkRepo(repo: Repo): Repo {
  if (!GITHUB_LOGIN.test(repo.owner) || repo.owner.endsWith('[bot]')) {
    throw new Error(`Not a GitHub owner: ${repo.owner}`)
  }
  if (!isRepositoryName(repo.repo)) throw new Error(`Not a GitHub repository: ${repo.repo}`)
  return repo
}

/** A path under `repos/<owner>/<repo>`, each part of `rest` encoded. */
export function repoPath(repo: Repo, ...rest: string[]): string {
  checkRepo(repo)
  return ['repos', repo.owner, repo.repo, ...rest.map(encodeURIComponent)].join('/')
}

/**
 * Splits what `gh api --include` prints: the status line, the headers, a blank line and the body.
 * gh ends the status line with LF and the headers with CRLF.
 */
export function parseIncluded(stdout: string): {
  status: number
  headers: Map<string, string>
  body: string
} | null {
  const status = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout)
  if (!status) return null
  const headers = new Map<string, string>()
  let at = stdout.indexOf('\n') + 1
  while (at > 0 && at < stdout.length) {
    const end = stdout.indexOf('\n', at)
    const line = stdout.slice(at, end < 0 ? stdout.length : end).replace(/\r$/, '')
    at = end < 0 ? stdout.length : end + 1
    if (line === '') break
    const colon = line.indexOf(':')
    if (colon > 0)
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return { status: Number(status[1]), headers, body: stdout.slice(at) }
}

/** `gh api` for a REST path on github.com, with `If-None-Match` when an ETag is known. */
export async function restRead(
  exec: Exec,
  cwd: string,
  path: string,
  etag: string | null,
): Promise<RestRead> {
  const args = ['api', '--hostname', 'github.com', '--include', '--method', 'GET']
  // An ETag is GitHub's own header, quoted; anything else is not sent back.
  if (etag && /^(W\/)?"[\w+/=-]{1,200}"$/.test(etag)) args.push('-H', `If-None-Match: ${etag}`)
  args.push(path)
  const result = await exec('gh', args, { cwd, timeoutMs: GH_TIMEOUT_MS })
  if (result.failure === 'not-found') {
    return { ok: false, reason: 'not-installed', message: describeFailure(result) }
  }
  const answer = parseIncluded(result.stdout)
  // gh exits with 1 on a 304, which is no failure here.
  if (answer?.status === 304) return { ok: true, unchanged: true }
  if (result.failure !== null || result.code !== 0 || !answer || answer.status !== 200) {
    return { ok: false, reason: 'failed', message: describeFailure(result) }
  }
  try {
    return {
      ok: true,
      unchanged: false,
      json: JSON.parse(answer.body) as unknown,
      etag: answer.headers.get('etag') ?? null,
      next: /rel="next"/.test(answer.headers.get('link') ?? ''),
    }
  } catch {
    return { ok: false, reason: 'failed', message: 'gh printed a body that is not JSON' }
  }
}

/** A GraphQL query through `gh api graphql`, its variables as strings. */
export async function graphQuery(
  exec: Exec,
  cwd: string,
  query: string,
  variables: Record<string, string>,
): Promise<{ ok: true; json: unknown } | GhFailure> {
  const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${query}`]
  for (const [name, value] of Object.entries(variables)) args.push('-f', `${name}=${value}`)
  const result = await exec('gh', args, { cwd, timeoutMs: GH_TIMEOUT_MS })
  if (result.failure === 'not-found') {
    return { ok: false, reason: 'not-installed', message: describeFailure(result) }
  }
  if (result.failure !== null || result.code !== 0) {
    return { ok: false, reason: 'failed', message: describeFailure(result) }
  }
  try {
    return { ok: true, json: JSON.parse(result.stdout) as unknown }
  } catch {
    return { ok: false, reason: 'failed', message: 'gh printed output that is not JSON' }
  }
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function timeOf(value: unknown): number {
  const time = Date.parse(text(value))
  return Number.isNaN(time) ? 0 : time
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function loginOf(value: unknown): string | null {
  const login = isObject(value) ? text(value.login) : ''
  return GITHUB_LOGIN.test(login) ? login : null
}

function labelsOf(value: unknown): IssueLabel[] {
  if (!Array.isArray(value)) return []
  const labels: IssueLabel[] = []
  for (const item of value) {
    if (!isObject(item) || !text(item.name)) continue
    const color = text(item.color)
    labels.push({ name: text(item.name), color: /^[0-9a-f]{6}$/i.test(color) ? color : '' })
  }
  return labels
}

// Issues

/** The REST path of a repository's open issues, the most recently updated first. */
export function inboxPath(repo: Repo, assignee: string | null): string {
  const query = new URLSearchParams({
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: String(INBOX_LIMIT),
  })
  if (assignee !== null) {
    if (!GITHUB_LOGIN.test(assignee)) throw new Error('Not a GitHub login')
    query.set('assignee', assignee)
  }
  return `${repoPath(repo, 'issues')}?${query}`
}

/** One issue of a REST list, every label; null for a pull request, which the list also holds. */
export function mapRestIssue(item: unknown, repo: Repo): (InboxIssue & { body: string }) | null {
  if (!isObject(item) || 'pull_request' in item) return null
  const number = item.number
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null
  const url = `https://github.com/${repo.owner}/${repo.repo}/issues/${number}`
  const assignees = Array.isArray(item.assignees)
    ? item.assignees.map(loginOf).filter((login): login is string => login !== null)
    : []
  return {
    url,
    number,
    title: text(item.title),
    labels: labelsOf(item.labels),
    assignees: assignees.slice(0, ASSIGNEES_KEPT),
    author: loginOf(item.user),
    comments: count(item.comments),
    createdAt: timeOf(item.created_at),
    updatedAt: timeOf(item.updated_at),
    body: text(item.body),
  }
}

/** A REST list of issues, pull requests left out. */
export function mapRestIssues(json: unknown, repo: Repo): (InboxIssue & { body: string })[] {
  if (!Array.isArray(json)) throw new Error('Unexpected gh output: not an issue list')
  return json.flatMap((item) => {
    const issue = mapRestIssue(item, repo)
    return issue ? [issue] : []
  })
}

/** The REST path of one issue. */
export function issuePath(repo: Repo, number: number): string {
  return repoPath(repo, 'issues', String(number))
}

// Repository

export type MergeMethod = 'squash' | 'merge' | 'rebase'

export interface RepoInfo {
  defaultBranch: string | null
  /** The methods the repository allows; null when GitHub did not say, as for a reader. */
  methods: MergeMethod[] | null
}

export function mapRepoInfo(json: unknown): RepoInfo {
  if (!isObject(json)) throw new Error('Unexpected gh output: not a repository')
  const flags: [MergeMethod, unknown][] = [
    ['squash', json.allow_squash_merge],
    ['merge', json.allow_merge_commit],
    ['rebase', json.allow_rebase_merge],
  ]
  const known = flags.every(([, flag]) => typeof flag === 'boolean')
  return {
    defaultBranch: text(json.default_branch) || null,
    methods: known ? flags.filter(([, flag]) => flag === true).map(([method]) => method) : null,
  }
}

/** The tip of a branch, from `git/ref/heads/<branch>`. */
export function refPath(repo: Repo, branch: string): string {
  checkRepo(repo)
  const parts = branch.split('/').map(encodeURIComponent).join('/')
  return `repos/${repo.owner}/${repo.repo}/git/ref/heads/${parts}`
}

export function mapRefOid(json: unknown): string | null {
  const object = isObject(json) && isObject(json.object) ? json.object : null
  const sha = object ? text(object.sha) : ''
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

const BEHIND_QUERY = `query($owner: String!, $repo: String!, $branch: String!, $base: String!) {
  repository(owner: $owner, name: $repo) {
    ref(qualifiedName: $branch) { compare(headRef: $base) { aheadBy } }
  }
}`

/** How many commits `base` has that `branch` lacks, through GraphQL's ref comparison. */
export async function readBehind(
  exec: Exec,
  cwd: string,
  repo: Repo,
  branch: string,
  base: string,
): Promise<{ ok: true; behind: number | null } | GhFailure> {
  checkRepo(repo)
  const answer = await graphQuery(exec, cwd, BEHIND_QUERY, {
    owner: repo.owner,
    repo: repo.repo,
    branch: `refs/heads/${branch}`,
    base,
  })
  if (!answer.ok) return answer
  const data = isObject(answer.json) && isObject(answer.json.data) ? answer.json.data : null
  const repository = data && isObject(data.repository) ? data.repository : null
  const ref = repository && isObject(repository.ref) ? repository.ref : null
  const compare = ref && isObject(ref.compare) ? ref.compare : null
  return { ok: true, behind: compare ? count(compare.aheadBy) : null }
}

// Pull requests

/** A new pull request, from the REST list of the open ones. */
export interface OpenedPullRequest {
  url: string
  number: number
  title: string
  createdAt: number
}

export function pullsPath(repo: Repo): string {
  const query = new URLSearchParams({
    state: 'open',
    sort: 'created',
    direction: 'desc',
    per_page: '30',
  })
  return `${repoPath(repo, 'pulls')}?${query}`
}

export function mapRestPulls(json: unknown, repo: Repo): OpenedPullRequest[] {
  if (!Array.isArray(json)) throw new Error('Unexpected gh output: not a pull request list')
  return json.flatMap((item) => {
    if (!isObject(item) || typeof item.number !== 'number') return []
    const url = `https://github.com/${repo.owner}/${repo.repo}/pull/${item.number}`
    return [
      { url, number: item.number, title: text(item.title), createdAt: timeOf(item.created_at) },
    ]
  })
}

/** An open pull request's head and checks, from `gh pr list`. */
export interface PullRequestChecks {
  url: string
  number: number
  title: string
  headOid: string
  checks: PullRequest['checks']
}

export function prChecksArgs(repo: Repo): string[] {
  checkRepo(repo)
  return [
    'pr',
    'list',
    '--repo',
    `${repo.owner}/${repo.repo}`,
    '--state',
    'open',
    '--limit',
    '30',
    '--json',
    'number,url,title,headRefOid,statusCheckRollup',
  ]
}

export function mapPrChecks(json: unknown): PullRequestChecks[] {
  if (!Array.isArray(json)) throw new Error('Unexpected gh output: not a pull request list')
  return json.flatMap((item) => {
    if (!isObject(item) || typeof item.number !== 'number') return []
    const url = text(item.url)
    if (!GITHUB_PULL_REQUEST_URL.test(url)) return []
    return [
      {
        url,
        number: item.number,
        title: text(item.title),
        headOid: text(item.headRefOid),
        checks: summarizeChecks(item.statusCheckRollup),
      },
    ]
  })
}

/** A review on a pull request, by someone other than its author or by its author. */
export interface FlowReview {
  id: string
  author: string | null
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  body: string
  submittedAt: number
}

export interface FlowComment {
  id: string
  author: string | null
  body: string
  createdAt: number
}

/** What merging and watching a pull request need to know of it. */
export interface FlowPullRequest {
  url: string
  owner: string
  repo: string
  number: number
  title: string
  state: PullRequestState
  head: string
  headOid: string
  base: string
  /** GitHub's own answer: MERGEABLE, CONFLICTING or UNKNOWN while it works it out. */
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  /** GitHub's mergeStateStatus: CLEAN, HAS_HOOKS, UNSTABLE, BLOCKED, BEHIND, DIRTY, DRAFT, UNKNOWN. */
  mergeState: string
  review: PullRequest['review']
  checks: PullRequest['checks']
  author: string | null
  reviews: FlowReview[]
  comments: FlowComment[]
}

const FLOW_FIELDS =
  'number,url,title,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,reviews,comments,author'

export function flowViewArgs(url: string): string[] {
  if (!GITHUB_PULL_REQUEST_URL.test(url)) throw new Error('Not a GitHub pull request URL')
  return ['pr', 'view', url, '--json', FLOW_FIELDS]
}

function reviewState(value: unknown): FlowReview['state'] {
  const state = text(value).toUpperCase()
  return state === 'APPROVED' ||
    state === 'CHANGES_REQUESTED' ||
    state === 'DISMISSED' ||
    state === 'PENDING'
    ? state
    : 'COMMENTED'
}

function reviewOf(value: unknown): PullRequest['review'] {
  switch (text(value).toUpperCase()) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'REVIEW_REQUIRED':
      return 'review_required'
    default:
      return null
  }
}

// gh names a GitHub App's bot `app/<slug>`.
function authorLogin(value: unknown): string | null {
  if (!isObject(value)) return null
  const app = /^app\/(.+)$/.exec(text(value.login))
  const login = app ? `${app[1]}[bot]` : text(value.login)
  return GITHUB_LOGIN.test(login) ? login : null
}

/** Maps `gh pr view --json FLOW_FIELDS`; throws when it is not a pull request on github.com. */
export function mapFlowPullRequest(raw: unknown): FlowPullRequest {
  if (!isObject(raw)) throw new Error('Unexpected gh output: not a pull request object')
  const url = text(raw.url)
  const parts = GITHUB_PULL_REQUEST_URL.exec(url)
  if (!parts) throw new Error(`Unexpected pull request URL: ${url || '(none)'}`)
  const upper = text(raw.state).toUpperCase()
  const state: PullRequestState =
    upper === 'MERGED'
      ? 'merged'
      : upper === 'CLOSED'
        ? 'closed'
        : raw.isDraft === true
          ? 'draft'
          : 'open'
  const mergeable = text(raw.mergeable).toUpperCase()
  const reviews: FlowReview[] = (Array.isArray(raw.reviews) ? raw.reviews : []).flatMap(
    (item: unknown) =>
      isObject(item) && text(item.id)
        ? [
            {
              id: text(item.id),
              author: authorLogin(item.author),
              state: reviewState(item.state),
              body: text(item.body),
              submittedAt: timeOf(item.submittedAt),
            },
          ]
        : [],
  )
  const comments: FlowComment[] = (Array.isArray(raw.comments) ? raw.comments : []).flatMap(
    (item: unknown) =>
      isObject(item) && text(item.id)
        ? [
            {
              id: text(item.id),
              author: authorLogin(item.author),
              body: text(item.body),
              createdAt: timeOf(item.createdAt),
            },
          ]
        : [],
  )
  return {
    url,
    owner: parts[1]!,
    repo: parts[2]!,
    number: Number(parts[3]),
    title: text(raw.title),
    state,
    head: text(raw.headRefName),
    headOid: text(raw.headRefOid),
    base: text(raw.baseRefName),
    mergeable:
      mergeable === 'MERGEABLE'
        ? 'mergeable'
        : mergeable === 'CONFLICTING'
          ? 'conflicting'
          : 'unknown',
    mergeState: text(raw.mergeStateStatus).toUpperCase() || 'UNKNOWN',
    review: reviewOf(raw.reviewDecision),
    checks: summarizeChecks(raw.statusCheckRollup),
    author: authorLogin(raw.author),
    reviews,
    comments,
  }
}

/** A line comment of a review, from the REST list of a pull request's review comments. */
export interface LineComment {
  author: string | null
  path: string
  line: number | null
  body: string
  createdAt: number
}

export function lineCommentsPath(repo: Repo, number: number, since: number): string {
  const query = new URLSearchParams({
    sort: 'created',
    direction: 'desc',
    per_page: '50',
    since: new Date(since).toISOString(),
  })
  return `${repoPath(repo, 'pulls', String(number), 'comments')}?${query}`
}

export function mapLineComments(json: unknown): LineComment[] {
  if (!Array.isArray(json)) throw new Error('Unexpected gh output: not a comment list')
  return json.flatMap((item) => {
    if (!isObject(item)) return []
    const line = typeof item.line === 'number' ? item.line : null
    return [
      {
        author: loginOf(item.user),
        path: text(item.path),
        line,
        body: text(item.body),
        createdAt: timeOf(item.created_at),
      },
    ]
  })
}

/**
 * Merges the pull request at `url` with `method`, only while its head is still `headOid`, the
 * commit whose checks passed. Run outside any checkout, so gh touches no local branch.
 */
export async function mergePullRequest(
  exec: Exec,
  cwd: string,
  url: string,
  method: MergeMethod,
  headOid: string,
): Promise<{ ok: true } | GhFailure> {
  if (!GITHUB_PULL_REQUEST_URL.test(url)) throw new Error('Not a GitHub pull request URL')
  if (!/^[0-9a-f]{40}$/.test(headOid)) throw new Error('Not a commit id')
  const result = await exec(
    'gh',
    ['pr', 'merge', url, `--${method}`, '--match-head-commit', headOid],
    { cwd, timeoutMs: MERGE_TIMEOUT_MS },
  )
  if (result.failure === 'not-found') {
    return { ok: false, reason: 'not-installed', message: describeFailure(result) }
  }
  if (result.failure !== null || result.code !== 0) {
    return { ok: false, reason: 'failed', message: describeFailure(result) }
  }
  return { ok: true }
}

/** The run and job of a GitHub Actions check, from its details link; null for any other check. */
export function actionsJobOf(url: string | null): { run: string; job: string | null } | null {
  if (!url) return null
  const match =
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url)
  return match ? { run: match[1]!, job: match[2] ?? null } : null
}
