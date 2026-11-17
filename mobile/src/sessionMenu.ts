// The desktop's rules for a session's menu (features/sidebar/session-menu-model.ts and its
// neighbors): which items a session's state allows, the command that resumes it in its CLI, its
// pull requests, and what archiving or deleting it would stop, as the confirmations list it.

import { isDefaultAgent } from '@shared/agents'
import type { RunningWork, SessionPullRequest, SessionSummary } from '@shared/agent-host'
import { githubReferenceOf } from '@shared/git'

export function isRunning(summary: Pick<SessionSummary, 'status'>): boolean {
  return summary.status === 'running' || summary.status === 'awaiting_permission'
}

/** Whether 重试 applies: a session that failed or needs its agent signed in. */
export function canRetry(summary: Pick<SessionSummary, 'status'>): boolean {
  return summary.status === 'failed' || summary.status === 'auth_required'
}

/** A row's pull requests: the ones it opened and its branch's, or its branch's from an older host. */
export function sessionPullRequests(summary: SessionSummary): SessionPullRequest[] {
  if (summary.prs) return summary.prs
  const pr = summary.pr
  const ref = pr ? githubReferenceOf(pr.url) : null
  if (!pr || !ref) return []
  return [
    {
      url: pr.url,
      owner: ref.owner,
      repo: ref.repo,
      number: pr.number,
      state: pr.state,
      failing: false,
    },
  ]
}

const ORDER = ['open', 'draft', 'merged', 'closed'] as const

/** The state that still needs someone first, so merged means every one is merged. */
export function topPrState(prs: SessionPullRequest[]): SessionPullRequest['state'] {
  return ORDER.find((state) => prs.some((pr) => pr.state === state)) ?? null
}

/**
 * The command that resumes the session in its harness's own CLI, run from its folder as its host
 * writes it; null for a harness without one, or an added agent.
 */
export function resumeCommand(
  summary: Pick<SessionSummary, 'agentId' | 'acpSessionId'>,
  folder: string,
): string | null {
  const id = summary.acpSessionId
  if (!id || !isDefaultAgent(summary.agentId)) return null
  const windows = /^[a-z]:[\\/]/i.test(folder) || folder.startsWith('\\\\')
  const quote = windows ? quoteWindows : quotePosix
  const cd = `${windows ? 'pushd' : 'cd'} ${quote(folder)} && `
  switch (summary.agentId) {
    case 'claude-code':
      return `${cd}claude --resume ${quote(id)}`
    case 'codex':
      return `${cd}codex resume ${quote(id)}`
    default:
      return null
  }
}

function quotePosix(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

function quoteWindows(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`
}

/** The sessions under this one at any depth, which go with it when it is deleted. */
export function descendantCount(
  sessions: ReadonlyMap<string, SessionSummary>,
  sessionId: string,
): number {
  const children = new Map<string, string[]>()
  for (const s of sessions.values()) {
    if (s.parentId === null) continue
    children.set(s.parentId, [...(children.get(s.parentId) ?? []), s.id])
  }
  let count = 0
  const seen = new Set<string>()
  const walk = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      count++
      walk(child)
    }
  }
  walk(sessionId)
  return count
}

export type WorkKind =
  'turn' | 'waiting' | 'command' | 'task' | 'subagent' | 'scheduled' | 'background'

export interface WorkItem {
  key: string
  kind: WorkKind
  name: string
  count: number
}

/** What a kind of running work is called, as the desktop's list labels it. */
export function workLabel(item: WorkItem): string {
  switch (item.kind) {
    case 'turn':
      return '当前这一轮'
    case 'waiting':
      return `${item.count} 个请求在等你回答`
    case 'command':
      return '后台命令'
    case 'task':
      return '后台任务'
    case 'subagent':
      return '子 Agent'
    case 'scheduled':
      return `${item.count} 个定时任务`
    case 'background':
      return '后台任务'
  }
}

/** The rows of the sessions' running work, as the desktop's confirmations list them. */
export function workItems(work: RunningWork[]): WorkItem[] {
  return work.flatMap((w) => {
    const session = w.title?.trim() || '新会话'
    const item = (kind: WorkKind, name: string, index = 0, count = 0): WorkItem => ({
      key: `${w.sessionId}:${kind}:${index}`,
      kind,
      name,
      count,
    })
    return [
      ...(w.turn ? [item('turn', session)] : []),
      ...(w.waiting > 0 ? [item('waiting', session, 0, w.waiting)] : []),
      ...w.commands.map((name, i) => item('command', name, i)),
      ...w.tasks.map((name, i) => item('task', name, i)),
      ...w.subagents.map((name, i) => item('subagent', name, i)),
      ...(w.scheduled > 0 ? [item('scheduled', session, 0, w.scheduled)] : []),
      ...(w.unnamed ? [item('background', session)] : []),
    ]
  })
}

/** The folder whose uncommitted files a delete puts at stake: a live worktree's, or the project's. */
export function stakeFolder(summary: SessionSummary): string | null {
  if (!summary.worktree) return summary.projectPath
  return hasLiveWorktree(summary) ? summary.worktree.path : null
}

/** A worktree Kettu made whose folder it has not removed. */
export function hasLiveWorktree(summary: Pick<SessionSummary, 'worktree'>): boolean {
  const worktree = summary.worktree
  return (
    !!worktree && worktree.path !== '' && worktree.state !== 'removed' && worktree.state !== 'gone'
  )
}
