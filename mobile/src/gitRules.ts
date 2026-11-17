// The desktop's git rules, as its branch popover follows them (features/git/sync.ts, results.ts and
// switcher-model.ts): what Pull and Push offer for a repository's state, what a finished write
// says and offers next, and which branch names git takes. Its words are the desktop's zh-CN copy.

import type { CommitSummary, GitStatus, PushTarget, RepositoryVisibility } from '@shared/git'

/** A git write the phone runs, as the desktop's git store names them. */
export type GitRequest =
  | { kind: 'fetch' }
  | { kind: 'pull' }
  | { kind: 'push'; remote: string; branch: string }
  | { kind: 'publishBranch'; remote: string }
  | { kind: 'publishRepo'; name: string; visibility: RepositoryVisibility }
  | { kind: 'switch'; branch: string; create: boolean }
  | { kind: 'commit'; message: string; paths: string[] }
  | { kind: 'discard'; paths: string[] }

export type GitKind = GitRequest['kind']

/** While a write runs, as the branch line says it. */
export const RUNNING_TEXT: Record<GitKind, string> = {
  fetch: '正在抓取',
  pull: '正在拉取',
  push: '正在推送',
  publishBranch: '正在发布',
  publishRepo: '正在发布',
  switch: '正在切换分支',
  commit: '正在提交',
  discard: '正在丢弃更改',
}

export type OperationKind = 'fetch' | 'pull' | 'push' | 'publishBranch' | 'publishRepo'

export type SyncReason =
  | 'noBranch'
  | 'operation'
  | 'noRemote'
  | 'noUpstream'
  | 'nothingToPush'
  | 'diverged'
  | 'ghMissing'
  | 'ghSignedOut'
  | 'unknownRemote'
  | 'localUpstream'
  | 'otherName'

export interface SyncButton {
  kind: OperationKind
  count: number
  enabled: boolean
  /** The next step, which takes the filled look. */
  next: boolean
  reason: SyncReason | null
}

export type SyncHint =
  | 'noBranch'
  | 'operation'
  | 'publishRepo'
  | 'publishBranch'
  | 'diverged'
  | 'upToDate'
  | 'ghMissing'
  | 'ghSignedOut'
  | 'unknownRemote'
  | 'localUpstream'
  | 'otherName'

export interface SyncPlan {
  pull: SyncButton
  push: SyncButton
  hint: SyncHint | null
}

export type NoteTone = 'ok' | 'info' | 'warning' | 'error'

export const HINT_TONE: Record<SyncHint, NoteTone> = {
  noBranch: 'info',
  operation: 'warning',
  publishRepo: 'info',
  publishBranch: 'info',
  diverged: 'warning',
  upToDate: 'ok',
  ghMissing: 'warning',
  ghSignedOut: 'warning',
  unknownRemote: 'warning',
  localUpstream: 'warning',
  otherName: 'warning',
}

export type SyncStep = 'conflicts' | 'merge' | 'rebase' | 'cherryPick' | 'revert'

export function stepOf(status: GitStatus): SyncStep {
  if (status.changes.conflicted > 0) return 'conflicts'
  switch (status.operation?.kind) {
    case 'merge':
      return 'merge'
    case 'rebase':
      return 'rebase'
    case 'cherry-pick':
      return 'cherryPick'
    case 'revert':
      return 'revert'
    default:
      return 'conflicts'
  }
}

const STEP_TEXT: Record<SyncStep, string> = {
  merge: '请先完成合并。',
  rebase: '请先完成变基。',
  cherryPick: '请先完成拣选。',
  revert: '请先完成还原。',
  conflicts: '请先解决冲突。',
}

export const OPERATION_TEXT: Record<NonNullable<GitStatus['operation']>['kind'], string> = {
  merge: '合并中',
  rebase: '变基中',
  'cherry-pick': '拣选中',
  revert: '还原中',
}

const off = (kind: OperationKind, reason: SyncReason, count = 0): SyncButton => ({
  kind,
  count,
  enabled: false,
  next: false,
  reason,
})
const on = (kind: OperationKind, count: number): SyncButton => ({
  kind,
  count,
  enabled: true,
  next: true,
  reason: null,
})

function pullButton(upstream: GitStatus['upstream']): SyncButton {
  if (!upstream) return off('pull', 'noUpstream')
  if (upstream.ahead > 0 && upstream.behind > 0) return off('pull', 'diverged', upstream.behind)
  if (upstream.behind === 0) return { ...on('pull', 0), next: false }
  return on('pull', upstream.behind)
}

/** The Pull and Push buttons for a repository; `gh` null while it is not known. */
export function planSync(
  status: GitStatus,
  gh: 'not-installed' | 'signed-out' | 'ready' | null,
): SyncPlan {
  const { head, upstream, operation, changes, push } = status
  if (operation || changes.conflicted > 0) {
    return { pull: off('pull', 'operation'), push: off('push', 'operation'), hint: 'operation' }
  }
  if (head.detached || head.branch === null || head.oid === null || push === null) {
    return { pull: off('pull', 'noBranch'), push: off('push', 'noBranch'), hint: 'noBranch' }
  }
  if (push.kind === 'noRemote') {
    if (gh !== 'ready') {
      const reason = gh === 'signed-out' ? 'ghSignedOut' : 'ghMissing'
      return { pull: off('pull', 'noRemote'), push: off('publishRepo', reason), hint: reason }
    }
    return { pull: off('pull', 'noRemote'), push: on('publishRepo', 0), hint: 'publishRepo' }
  }
  const pull = pullButton(upstream)
  if (push.kind !== 'remote') return { pull, push: off('push', push.kind), hint: push.kind }
  if (push.setUpstream) {
    return { pull, push: on('publishBranch', status.commits.length), hint: 'publishBranch' }
  }
  if (!upstream || upstream.name !== `${push.remote}/${push.branch}`) {
    return { pull, push: { ...on('push', 0), next: false }, hint: null }
  }
  const { ahead, behind } = upstream
  if (ahead > 0 && behind > 0)
    return { pull, push: off('push', 'diverged', ahead), hint: 'diverged' }
  if (behind > 0) return { pull, push: off('push', 'nothingToPush'), hint: null }
  if (ahead > 0) return { pull, push: on('push', ahead), hint: null }
  return { pull, push: off('push', 'nothingToPush'), hint: 'upToDate' }
}

interface Words {
  upstream: string
  operation: string
}

function wordsOf(status: GitStatus): Words {
  return {
    upstream: status.upstream?.name ?? status.remote?.name ?? '',
    operation: STEP_TEXT[stepOf(status)],
  }
}

/** Why a sync button cannot run, in the desktop's words. */
export function reasonText(reason: SyncReason, status: GitStatus): string {
  const w = wordsOf(status)
  switch (reason) {
    case 'noBranch':
      return '不在任何分支上'
    case 'operation':
      return w.operation
    case 'noRemote':
      return '此仓库没有远程仓库'
    case 'noUpstream':
      return '此分支尚未发布'
    case 'nothingToPush':
      return '没有可推送的提交'
    case 'diverged':
      return `此分支与 ${w.upstream} 已分叉`
    case 'ghMissing':
      return '安装 GitHub CLI 后才能发布'
    case 'ghSignedOut':
      return '登录 GitHub CLI 后才能发布'
    case 'unknownRemote':
      return '有多个远程仓库，且没有为此分支指定其中一个'
    case 'localUpstream':
      return '此分支跟踪的是本仓库的分支'
    case 'otherName':
      return `此分支跟踪的是名称不同的 ${w.upstream}`
  }
}

/** The line under the sync buttons. */
export function hintText(hint: SyncHint, status: GitStatus): string {
  const w = wordsOf(status)
  switch (hint) {
    case 'noBranch':
      return '切换到一个分支后才能拉取或推送。'
    case 'operation':
      return w.operation
    case 'publishRepo':
      return '发布会在 GitHub 上创建仓库并推送此分支。'
    case 'publishBranch':
      return '发布此分支即可推送，并创建 Pull Request。'
    case 'diverged':
      return `已与 ${w.upstream} 分叉：请在终端中变基或合并，再推送。`
    case 'upToDate':
      return `已与 ${w.upstream} 同步。`
    case 'ghMissing':
      return '安装 GitHub CLI 后即可把此仓库发布到 GitHub。'
    case 'ghSignedOut':
      return '运行 gh auth login 登录 GitHub CLI 后即可发布此仓库。'
    case 'unknownRemote':
      return '此仓库有多个远程仓库，且没有为此分支指定其中一个；请在终端中指定远程仓库推送。'
    case 'localUpstream':
      return '此分支跟踪的是本仓库的分支，推送没有目标。'
    case 'otherName':
      return `此分支跟踪的是名称不同的 ${w.upstream}，git 不会推送它；请在终端中指定推送目标。`
  }
}

type RemoteTarget = Extract<PushTarget, { kind: 'remote' }>

export function pushTargetOf(status: GitStatus): RemoteTarget | null {
  return status.push?.kind === 'remote' ? status.push : null
}

/** A push or publish that would land straight on the default branch, which asks first. */
export function pushesToDefault(status: GitStatus, kind: OperationKind): boolean {
  const target = pushTargetOf(status)
  return (
    (kind === 'push' || kind === 'publishBranch') &&
    target !== null &&
    status.defaultBranch !== null &&
    target.branch === status.defaultBranch
  )
}

/** Push, or publish to where push goes when the branch has no upstream yet. */
export function pushRequest(status: GitStatus): GitRequest | null {
  const target = pushTargetOf(status)
  if (!target) return null
  return target.setUpstream
    ? { kind: 'publishBranch', remote: target.remote }
    : { kind: 'push', remote: target.remote, branch: target.branch }
}

/** The pull request's head as GitHub names it, or null when it is not on GitHub or is the base. */
export function pullRequestHead(status: GitStatus): string | null {
  const base = status.remote?.github
  const target = pushTargetOf(status)
  if (!base || !target || target.setUpstream || !target.github) return null
  const sameRepo = target.github.owner === base.owner && target.github.repo === base.repo
  if (sameRepo && target.branch === status.defaultBranch) return null
  return sameRepo ? target.branch : `${target.github.owner}:${target.branch}`
}

/** Whether a pull request is the step after a push: a GitHub branch other than the default. */
export function offersPullRequest(status: GitStatus, hasPr: boolean): boolean {
  return (
    !hasPr &&
    !!status.remote?.github &&
    status.head.branch !== null &&
    status.head.branch !== status.defaultBranch
  )
}

export type FailureKind =
  | 'rejected'
  | 'notFastForward'
  | 'auth'
  | 'network'
  | 'localChanges'
  | 'remoteMissing'
  | 'nameTaken'
  | 'timeout'
  | 'busy'
  | 'other'

const FAILURES: [FailureKind, RegExp][] = [
  ['timeout', /timed out after/i],
  [
    'rejected',
    /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|updates were rejected/i,
  ],
  ['notFastForward', /not possible to fast-forward|diverging branches|have diverged/i],
  ['localChanges', /would be overwritten by merge|commit your changes or stash them/i],
  [
    'auth',
    /authentication failed|permission denied|could not read username|terminal prompts disabled|could not read from remote repository|403/i,
  ],
  [
    'network',
    /could not resolve host|unable to access|connection (timed out|refused)|network is unreachable/i,
  ],
  ['remoteMissing', /does not appear to be a git repository|repository not found/i],
  ['nameTaken', /name already exists/i],
]

export function failureOf(log: string): FailureKind {
  for (const [kind, pattern] of FAILURES) if (pattern.test(log)) return kind
  return 'other'
}

/** The log's last meaningful line, for a failure with no sentence of its own. */
export function lastLine(log: string): string {
  const lines = log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines.at(-1) ?? ''
}

/** What a new pull request starts with, as the desktop suggests it. */
export function suggestPullRequest(
  branch: string,
  commits: readonly CommitSummary[],
): { title: string; body: string } {
  if (commits.length === 1) return { title: commits[0]!.subject, body: '' }
  const name =
    branch
      .replace(/^[^/]+\//, '')
      .replace(/[-_]+/g, ' ')
      .trim() || branch
  return {
    title: name.charAt(0).toUpperCase() + name.slice(1),
    body: [...commits]
      .reverse()
      .map((commit) => `- ${commit.subject}`)
      .join('\n'),
  }
}

/** The step a result offers, as the desktop's toast action. */
export type NextStep = 'pull' | 'push' | 'createPr' | 'pullAndRetry' | 'showLog'

export const NEXT_LABEL: Record<NextStep, string> = {
  pull: '拉取',
  push: '推送',
  createPr: '创建 PR',
  pullAndRetry: '拉取后重试',
  showLog: '查看日志',
}

export interface ResultNote {
  text: string
  tone: 'success' | 'info' | 'warning'
  next: NextStep | null
}

function upstreamBranch(status: GitStatus): string | null {
  const { upstream, remote } = status
  if (!upstream) return null
  const prefix = remote ? `${remote.name}/` : ''
  return prefix && upstream.name.startsWith(prefix)
    ? upstream.name.slice(prefix.length)
    : upstream.name
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

const note = (
  text: string,
  tone: ResultNote['tone'],
  next: NextStep | null = null,
): ResultNote => ({ text, tone, next })

/** What a finished write says, and the step it offers next. */
export function successNote(
  request: GitRequest,
  before: GitStatus | null,
  after: GitStatus,
  hasPr: boolean,
): ResultNote {
  const branch = after.head.branch ?? ''
  const remote = after.remote?.name ?? ''
  const prNext = offersPullRequest(after, hasPr) ? 'createPr' : null
  switch (request.kind) {
    case 'fetch': {
      const name = upstreamBranch(after)
      const behind = after.upstream?.behind ?? 0
      if (name && behind > 0)
        return note(`已获取 · ${name} 上有 ${behind} 个新提交`, 'info', 'pull')
      const { base, defaultBranch } = after
      if (base && defaultBranch) {
        const count = base.behind - (before?.base?.behind ?? 0)
        return count > 0
          ? note(`已获取 · ${defaultBranch} 上有 ${count} 个新提交`, 'info')
          : note(`已获取 · ${defaultBranch} 上没有新内容`, 'info')
      }
      return name ? note(`已获取 · ${name} 上没有新内容`, 'info') : note(`已获取 ${remote}`, 'info')
    }
    case 'pull':
      if (before && after.head.oid === before.head.oid) {
        return note(`已拉取 · ${upstreamBranch(after) ?? branch} 上没有新内容`, 'info')
      }
      return note(`已拉取 ${Math.max(1, before?.upstream?.behind ?? 1)} 个提交`, 'success')
    case 'push': {
      const count = before?.upstream?.ahead ?? 0
      return count > 0
        ? note(`已推送 ${count} 个提交到 ${request.remote}`, 'success', prNext)
        : note(`已推送 ${branch} 到 ${request.remote}`, 'success', prNext)
    }
    case 'publishBranch':
      return note(`已发布 ${branch} 到 ${request.remote}`, 'success', prNext)
    case 'publishRepo':
      return note(`已将 ${request.name} 发布到 GitHub`, 'success')
    case 'switch':
      return note(
        request.create ? `已新建 ${request.branch}` : `已切换到 ${request.branch}`,
        'success',
      )
    case 'commit': {
      const next = after.push?.kind === 'remote' || after.push?.kind === 'noRemote' ? 'push' : null
      const count = request.paths.length
      return after.head.branch === null
        ? note(`已提交 ${count} 个文件`, 'success')
        : note(`已向 ${branch} 提交 ${count} 个文件`, 'success', next)
    }
    case 'discard':
      return request.paths.length === 1
        ? note(`已丢弃 ${fileName(request.paths[0]!)} 的更改`, 'success')
        : note(`已丢弃 ${request.paths.length} 个文件的更改`, 'success')
  }
}

const OPERATION_NAME: Record<GitKind, string> = {
  fetch: '抓取',
  pull: '拉取',
  push: '推送',
  publishBranch: '发布',
  publishRepo: '发布',
  switch: '切换',
  commit: '提交',
  discard: '丢弃',
}

/** A failed write in the user's terms. */
export function failureNote(request: GitRequest, log: string, busy: boolean): ResultNote {
  if (busy) return note('此仓库正在执行另一个 git 操作。', 'warning')
  const kind = failureOf(log)
  if (request.kind === 'push' && kind === 'rejected') {
    return note(`推送被拒绝 · ${request.remote} 上有新提交`, 'warning', 'pullAndRetry')
  }
  const op = OPERATION_NAME[request.kind]
  const text = {
    rejected: `${op}被拒绝：远程仓库有新提交。`,
    notFastForward: `${op}已停止：两边的分支已分叉。`,
    localChanges: `${op}已停止：本地更改会被覆盖。`,
    auth: `${op}失败：git 无法登录远程仓库。`,
    network: `${op}失败：无法连接远程仓库。`,
    remoteMissing: `${op}失败：找不到远程仓库。`,
    nameTaken: `${op}失败：已有同名仓库。`,
    timeout: `${op}耗时过长，已停止。`,
    busy: '此仓库正在执行另一个 git 操作。',
    other: `${op}失败：${lastLine(log)}`,
  }[kind]
  return note(text, 'warning', log ? 'showLog' : null)
}

/** The title of a failed write's log. */
export function logTitle(kind: GitKind): string {
  return `${OPERATION_NAME[kind]}日志`
}

/** Whether git takes `name` as a new branch's name, by `git check-ref-format --branch`. */
export function isBranchName(name: string): boolean {
  if (name === '' || name === '@' || name === 'HEAD') return false
  if (name.startsWith('-') || name.startsWith('/')) return false
  if (name.endsWith('/') || name.endsWith('.')) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  if ([...name].some((char) => char <= ' ' || char === '\u007f')) return false
  if (/[~^:?*[\\]/.test(name)) return false
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
}

/** The branches to switch to, newest first as given, with the default branch on top. */
export function recentBranches(
  names: readonly string[],
  current: string | null,
  defaultBranch: string | null,
): string[] {
  const others = names.filter((name) => name !== current && name !== defaultBranch)
  return defaultBranch !== null && defaultBranch !== current && names.includes(defaultBranch)
    ? [defaultBranch, ...others]
    : others
}

/** Whether two folders are one, as the host writes them; Windows paths ignore case. */
export function sameFolder(a: string, b: string): boolean {
  const windows = a.includes('\\') || b.includes('\\') || /^[a-z]:/i.test(a)
  const norm = (path: string): string => {
    const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
    return windows ? slashed.toLowerCase() : slashed
  }
  return norm(a) === norm(b)
}

/** The branch as the branch line names it: its name, a detached commit, or none yet. */
export function branchLabel(status: GitStatus): string {
  if (status.head.branch) return status.head.branch
  if (status.head.detached && status.head.oid) return `HEAD 已分离于 ${status.head.oid.slice(0, 7)}`
  return '尚无提交'
}

/** A linked worktree's git folder is inside the main repository's, under worktrees/. */
export function isLinkedWorktree(gitDir: string): boolean {
  return /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitDir)
}
