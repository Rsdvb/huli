// A session's title menu, by the desktop's menu model for the session in front: a first line that
// names its agent, model and tokens; 停止 or 重试 by its state; rename, pin and unread; fork and a
// new sub-session; its pull requests and the copy actions; then archive and delete, which waits
// for a running turn. A sub-agent's menu only stops it or finds its parent.

import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { canRetry, hasLiveWorktree, isRunning, sessionPullRequests } from '../sessionMenu'
import { prIcon } from '../ui/session/gitIcons'
import { G } from '../ui/session/icons'
import { tokensText } from '../ui/session/limits'
import type { MenuEntry, MenuPage, MenuRow } from '../ui/session/Popover'
import type { SessionActions } from './SessionActions'
import { optionOf, shownChoice } from './ConfigMenus'
import { shortModelName } from '../ui/session/optionText'

export interface SessionMenuContext {
  summary: SessionSummary
  session: SessionView | undefined
  agent: AgentStatus | undefined
  actions: SessionActions
  canFork: boolean
  muted: boolean
  onMute(): void
  onFork(worktree?: 'same'): void
  onNewSubSession(): void
  onShowParent(): void
  onOpenUrl(url: string): void
}

/** The model as the composer's chip names it: 「Opus 5.5」, not its id or 「Default (recommended)」. */
function modelName(session: SessionView | undefined): string | null {
  const option = session ? optionOf(session.config, 'model') : undefined
  if (!option) return null
  const choice = shownChoice(option)
  return shortModelName(choice ?? { name: String(option.value) })
}

/** The menu's head: the agent that runs it, its model and the tokens used, not a button. */
function headRow(ctx: SessionMenuContext): MenuRow {
  const { agent, session, summary } = ctx
  const harness = agent?.harnessName ?? agent?.name ?? summary.agentId
  const name = agent && agent.name !== agent.harnessName ? `${harness} · ${agent.name}` : harness
  const used = session?.usage?.tokens?.total
  const detail = [
    modelName(session),
    used !== undefined && used > 0 ? `${tokensText(used)} tokens` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return {
    key: 'head',
    label: name,
    icon: G.subagent,
    ...(detail ? { subtitle: detail } : {}),
    disabled: true,
  }
}

function joined(groups: MenuEntry[][]): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const group of groups.filter((g) => g.length > 0)) {
    if (out.length > 0) out.push({ kind: 'divider', key: `rule-${out.length}` })
    out.push(...group)
  }
  return out
}

export function sessionMenuPages(ctx: SessionMenuContext): (id: string) => MenuPage | null {
  const { summary, actions } = ctx
  const running = isRunning(summary)
  const prs = sessionPullRequests(summary)

  const title = (): MenuPage => {
    if (summary.origin === 'subagent') {
      return {
        entries: joined([
          [headRow(ctx)],
          running
            ? [
                {
                  key: 'stop',
                  label: '停止',
                  icon: G.stopOutline,
                  destructive: true,
                  onPress: () => actions.stop(summary),
                },
              ]
            : [],
          summary.parentId
            ? [{ key: 'parent', label: '在父会话中显示', icon: G.child, onPress: ctx.onShowParent }]
            : [],
          [
            {
              key: 'copy-id',
              label: '复制会话 ID',
              icon: G.copy,
              onPress: () => actions.copySessionId(summary),
            },
          ],
        ]),
      }
    }
    const topLevel = summary.parentId === null
    const archived = summary.archivedAt !== null
    const worktree = hasLiveWorktree(summary)
    const state: MenuEntry[] = running
      ? [
          {
            key: 'stop',
            label: '停止',
            icon: G.stopOutline,
            destructive: true,
            onPress: () => actions.stop(summary),
          },
        ]
      : canRetry(summary)
        ? [{ key: 'retry', label: '重试', icon: G.retry, onPress: () => actions.retry(summary) }]
        : []
    const own: MenuEntry[] = [
      { key: 'rename', label: '重命名…', icon: G.pencil, onPress: () => actions.rename(summary) },
      ...(topLevel
        ? [
            {
              key: 'pin',
              label: summary.pinnedAt !== null ? '取消置顶' : '置顶',
              icon: summary.pinnedAt !== null ? G.unpin : G.pin,
              onPress: () => actions.togglePin(summary),
            },
          ]
        : []),
      {
        key: 'unread',
        label: summary.attention === 'unread' ? '标为已读' : '标为未读',
        icon: summary.attention === 'unread' ? G.read : G.unread,
        onPress: () => actions.toggleUnread(summary),
      },
      {
        key: 'mute',
        label: ctx.muted ? '取消静音' : '静音通知',
        icon: ctx.muted ? G.unmute : G.mute,
        onPress: ctx.onMute,
      },
    ]
    const forks: MenuEntry[] =
      topLevel && ctx.canFork
        ? [
            {
              key: 'fork',
              label: worktree ? '在新 worktree 中分叉' : '分叉',
              icon: G.fork,
              onPress: () => ctx.onFork(),
            },
            ...(worktree
              ? [
                  {
                    key: 'fork-same',
                    label: '在同一个 worktree 中分叉',
                    icon: G.fork,
                    onPress: () => ctx.onFork('same'),
                  },
                ]
              : []),
          ]
        : []
    const make: MenuEntry[] = [
      ...forks,
      { key: 'child', label: '新建子会话', icon: G.child, onPress: ctx.onNewSubSession },
    ]
    const resume = actions.resumeOf(summary)
    const links: MenuEntry[] = [
      ...(prs.length === 1
        ? [
            {
              key: 'pr',
              label: `打开 Pull Request #${prs[0]!.number}`,
              icon: prIcon(prs[0]!.state),
              onPress: () => ctx.onOpenUrl(prs[0]!.url),
            },
          ]
        : prs.length > 1
          ? [{ key: 'prs', label: 'Pull Request', icon: prIcon(null), page: 'title-prs' }]
          : []),
      ...(resume
        ? [
            {
              key: 'resume',
              label: '复制恢复命令',
              icon: G.terminal,
              onPress: () => actions.copyResume(summary),
            },
          ]
        : []),
      {
        key: 'copy-id',
        label: '复制会话 ID',
        icon: G.copy,
        onPress: () => actions.copySessionId(summary),
      },
    ]
    const ending: MenuEntry[] = [
      ...(topLevel
        ? [
            archived
              ? {
                  key: 'restore',
                  label: '恢复到会话列表',
                  icon: G.archive,
                  onPress: () => actions.restore(summary),
                }
              : {
                  key: 'archive',
                  label: '归档',
                  icon: G.archive,
                  onPress: () => actions.archive(summary),
                },
          ]
        : []),
      {
        key: 'delete',
        label: '删除…',
        icon: G.trash,
        destructive: true,
        // A session cannot be removed mid-turn; 停止 comes first.
        disabled: running,
        ...(running ? { detail: '先停止' } : {}),
        onPress: () => actions.remove(summary),
      },
    ]
    return { entries: joined([[headRow(ctx)], state, own, make, links, ending]) }
  }

  return (id) => {
    if (id === 'title') return title()
    if (id === 'title-prs') {
      return {
        title: 'Pull Request',
        entries: prs.map((pr) => ({
          key: pr.url,
          label: `${pr.repo}#${pr.number}`,
          icon: prIcon(pr.state),
          ...(pr.failing ? { detail: '检查失败' } : {}),
          onPress: () => ctx.onOpenUrl(pr.url),
        })),
      }
    }
    return null
  }
}
