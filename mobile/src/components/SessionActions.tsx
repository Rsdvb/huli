// What can be done to a session from the phone, by the desktop's menu rules: retry or stop it, pin,
// rename, mark unread, mute, move to a folder, fork, open its pull request, copy its resume
// command, archive it (asking first when work runs, with Undo after) or restore it, and delete it
// through the desktop's dialog. The list, the archive and search each offer their part of it, as
// the system's context menu on a long press (`menu`).
//
// A session of another computer than the active one (全部电脑) goes through that computer's own
// light link (`linkFor`); what needs the active computer's full link, deleting and forking, is
// left out of its menu.

import { useState, type ReactNode } from 'react'
import { Alert } from 'react-native'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import { runPhase } from '@shared/session-groups'
import type { HostLink } from '@shared/remote/link'
import { call, sessionFolder } from '../git'
import { useMaybeLink } from '../host'
import { isMuted, setMuted } from '../push/muted'
import { errorText, sessionTitle } from '../sessions'
import {
  canRetry,
  isRunning,
  resumeCommand,
  sessionPullRequests,
  workItems,
  workLabel,
} from '../sessionMenu'
import { haptic } from '../ui/haptics'
import { joinGroups, type MenuNode } from '../ui/menu'
import { openMenuSheet } from '../ui/MenuSheet'
import { showNotice } from '../ui/NoticeBar'
import { copyText } from '../ui/session/feedback'
import { DeleteSessionDialog } from './DeleteSessionDialog'
import { RenameDialog } from './RenameDialog'
import { openUrl } from '../system/openUrl'

export type ActionsPlace = 'list' | 'archive' | 'session'

/** What a list adds to a session's menu: its folders, forking and selecting. */
export interface MenuExtras {
  /** 移到文件夹's submenu, built by `moveToFolderNodes`; none on a computer without folders. */
  folders?: MenuNode[]
  /** Forks the whole session; none when its agent cannot. */
  fork?: () => void
  /** Starts selecting with this session. */
  select?: () => void
}

export interface SessionActions {
  /** Opens the session's menu as a sheet, where no context menu can be shown. */
  open(summary: SessionSummary): void
  /** The session's menu, for a context menu. */
  menu(summary: SessionSummary, extras?: MenuExtras): MenuNode[]
  /** The swipe actions: each at once, with a haptic for how it went. */
  togglePin(summary: SessionSummary): void
  /** Asks first when work of its runs, then archives with Undo. */
  archive(summary: SessionSummary): void
  restore(summary: SessionSummary): void
  rename(summary: SessionSummary): void
  toggleUnread(summary: SessionSummary): void
  retry(summary: SessionSummary): void
  stop(summary: SessionSummary): void
  copyResume(summary: SessionSummary): void
  copySessionId(summary: SessionSummary): void
  /** Its resume command, or null for an agent without one. */
  resumeOf(summary: SessionSummary): string | null
  /** Asks with the desktop's dialog, then deletes; refused while a turn runs. */
  remove(summary: SessionSummary): void
  /** Renders the dialogs; put it anywhere in the screen. */
  element: ReactNode
}

export function useSessionActions(
  place: ActionsPlace,
  /** After the session was archived, restored or deleted, as a session screen leaves then. */
  onGone?: () => void,
  /** The link of a session's computer when it is not the active one (全部电脑). */
  linkFor?: (summary: SessionSummary) => HostLink | null | undefined,
): SessionActions {
  const active = useMaybeLink()
  const [target, setTarget] = useState<SessionSummary | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)

  /** The session's computer's link: another computer's own, else the active one's. */
  const linkOf = (s: SessionSummary): HostLink | null => {
    const other = linkFor?.(s)
    return other === undefined ? active : other
  }
  const onActive = (s: SessionSummary) => linkFor?.(s) === undefined

  const run = (
    s: SessionSummary,
    failed: string,
    request: (link: HostLink) => Promise<unknown>,
    after?: () => void,
  ) => {
    const link = linkOf(s)
    if (!link) {
      haptic.warning()
      Alert.alert(failed, '现在连不上这个会话所在的电脑。')
      return
    }
    request(link).then(
      () => {
        haptic.success()
        after?.()
      },
      (error: unknown) => {
        haptic.warning()
        Alert.alert(failed, errorText(error))
      },
    )
  }

  const archiveNow = (s: SessionSummary) =>
    run(
      s,
      '没能归档',
      (link) => link.request('sessions.archive', { sessionId: s.id }),
      () => {
        onGone?.()
        showNotice({
          text: `已归档“${sessionTitle(s)}”`,
          action: {
            label: '撤销',
            onPress: () =>
              void linkOf(s)
                ?.request('sessions.unarchive', { sessionId: s.id })
                .catch((error: unknown) => Alert.alert('没能恢复', errorText(error))),
          },
        })
      },
    )

  // Archiving stops the agent's work and its terminals, so running work is named and confirmed.
  const archive = (s: SessionSummary) => {
    const link = linkOf(s)
    if (!link) return archiveNow(s)
    call(link, 'sessions.runningWork', { sessionIds: [s.id] })
      .then(({ sessions }) => workItems(sessions))
      .catch(() => [])
      .then((items) => {
        if (items.length === 0) return archiveNow(s)
        Alert.alert(
          '停止正在运行的工作并归档？',
          `归档会停止以下内容，撤销也不会恢复：\n\n${items
            .map((item) => `${item.name} · ${workLabel(item)}`)
            .join('\n')}`,
          [
            { text: '取消', style: 'cancel' },
            { text: '停止并归档', style: 'destructive', onPress: () => archiveNow(s) },
          ],
        )
      })
  }

  const remove = (s: SessionSummary) => {
    if (isRunning(s)) {
      Alert.alert('它正在运行', '先停止这个会话，才能删除。')
      return
    }
    setDeleting(s)
  }

  const rename = (s: SessionSummary) => {
    setTarget(s)
    setRenaming(true)
  }

  const resumeOf = (s: SessionSummary) => resumeCommand(s, sessionFolder(s))

  const actions = {
    togglePin: (s: SessionSummary) =>
      run(s, '没能置顶', (link) =>
        link.request('sessions.pin', { sessionId: s.id, pinned: s.pinnedAt === null }),
      ),
    restore: (s: SessionSummary) =>
      run(s, '没能恢复', (link) => link.request('sessions.unarchive', { sessionId: s.id }), onGone),
    toggleUnread: (s: SessionSummary) =>
      run(s, '没能标记', (link) =>
        link.request('sessions.markUnread', { sessionId: s.id, unread: s.attention !== 'unread' }),
      ),
    retry: (s: SessionSummary) =>
      run(s, '没能重试', (link) => link.request('sessions.retry', { sessionId: s.id })),
    stop: (s: SessionSummary) =>
      run(s, '没能停止', (link) => link.request('sessions.cancel', { sessionId: s.id })),
    copyResume: (s: SessionSummary) => {
      const command = resumeOf(s)
      if (!command) return
      void copyText(command).then(() => showNotice({ text: '已复制恢复命令', tone: 'success' }))
    },
    copySessionId: (s: SessionSummary) =>
      void copyText(s.acpSessionId ?? s.id).then(() =>
        showNotice({ text: '已复制会话 ID', tone: 'success' }),
      ),
  }

  // A best-of-N run's changes go into the project on the computer, as the desktop's Keep this
  // does; the computer checks it all again and says why when it refuses.
  const keepRun = (s: SessionSummary) => {
    haptic.warning()
    Alert.alert(
      '保留这个结果？',
      '它的改动会合并到电脑上项目当前的分支。项目里有未提交的改动，或者合并会冲突时，什么都不会改。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '保留',
          onPress: () =>
            run(
              s,
              '没能保留',
              (link) => link.request('groups.keep', { sessionId: s.id }),
              () => showNotice({ text: '已保留，改动已合并到项目里' }),
            ),
        },
      ],
    )
  }

  const menu = (s: SessionSummary, extras: MenuExtras = {}): MenuNode[] => {
    const running = isRunning(s)
    const topLevel = s.parentId === null
    const here = onActive(s)
    const muted = isMuted(s.id)
    const prs = sessionPullRequests(s)
    const resume = resumeOf(s)
    if (place === 'archive') {
      return joinGroups([
        [
          {
            key: 'restore',
            label: '恢复到会话列表',
            icon: 'arrow.uturn.backward',
            onPress: () => actions.restore(s),
          },
          { key: 'rename', label: '重命名…', icon: 'pencil', onPress: () => rename(s) },
        ],
        here && !running
          ? [
              {
                key: 'delete',
                label: '删除…',
                icon: 'trash',
                destructive: true,
                onPress: () => remove(s),
              },
            ]
          : [],
      ])
    }
    const keepable =
      !!s.group &&
      s.group.kept === null &&
      s.archivedAt === null &&
      runPhase(s) === 'done' &&
      s.worktree?.state === 'ready'
    const keep: MenuNode[] = keepable
      ? [{ key: 'keep', label: '保留这个', icon: 'checkmark.circle', onPress: () => keepRun(s) }]
      : []
    const state: MenuNode[] = running
      ? [
          {
            key: 'stop',
            label: '停止',
            icon: 'stop',
            destructive: true,
            onPress: () => actions.stop(s),
          },
        ]
      : canRetry(s)
        ? [
            {
              key: 'retry',
              label: '重试',
              icon: 'arrow.clockwise',
              onPress: () => actions.retry(s),
            },
          ]
        : []
    const own: MenuNode[] = [
      { key: 'rename', label: '重命名…', icon: 'pencil', onPress: () => rename(s) },
      ...(topLevel
        ? [
            {
              key: 'pin',
              label: s.pinnedAt !== null ? '取消置顶' : '置顶',
              icon: s.pinnedAt !== null ? ('pin.slash' as const) : ('pin' as const),
              onPress: () => actions.togglePin(s),
            },
          ]
        : []),
      {
        key: 'unread',
        label: s.attention === 'unread' ? '标为已读' : '标为未读',
        icon: s.attention === 'unread' ? 'checkmark.circle' : 'circlebadge',
        onPress: () => actions.toggleUnread(s),
      },
      {
        key: 'mute',
        label: muted ? '取消静音' : '静音通知',
        icon: muted ? 'bell' : 'bell.slash',
        onPress: () => toggleMuted(s.id, !muted),
      },
    ]
    const organize: MenuNode[] = [
      ...(topLevel && extras.folders
        ? [{ key: 'move', label: '移到文件夹', icon: 'folder' as const, items: extras.folders }]
        : []),
      ...(extras.fork && here
        ? [
            {
              key: 'fork',
              label: '分叉',
              icon: 'arrow.triangle.branch' as const,
              onPress: extras.fork,
            },
          ]
        : []),
      ...(topLevel
        ? [
            s.archivedAt !== null
              ? {
                  key: 'restore',
                  label: '恢复到会话列表',
                  icon: 'arrow.uturn.backward' as const,
                  onPress: () => actions.restore(s),
                }
              : {
                  key: 'archive',
                  label: '归档',
                  icon: 'archivebox' as const,
                  onPress: () => archive(s),
                },
          ]
        : []),
    ]
    const more: MenuNode[] = [
      ...prs.slice(0, 3).map((p) => ({
        key: `pr:${p.url}`,
        label: `打开 Pull Request #${p.number}`,
        icon: 'arrow.triangle.pull' as const,
        onPress: () => openUrl(p.url),
      })),
      ...(resume
        ? [
            {
              key: 'resume',
              label: '复制恢复命令',
              icon: 'apple.terminal' as const,
              onPress: () => actions.copyResume(s),
            },
          ]
        : []),
      {
        key: 'copy-id',
        label: '复制会话 ID',
        icon: 'doc.on.doc',
        onPress: () => actions.copySessionId(s),
      },
    ]
    const end: MenuNode[] = [
      ...(extras.select
        ? [
            {
              key: 'select',
              label: '选择',
              icon: 'checkmark.circle' as const,
              onPress: extras.select,
            },
          ]
        : []),
      { key: 'more', label: '更多', icon: 'ellipsis.circle', items: more },
    ]
    const del: MenuNode[] =
      here && !running
        ? [
            {
              key: 'delete',
              label: '删除…',
              icon: 'trash',
              destructive: true,
              onPress: () => remove(s),
            },
          ]
        : []
    return joinGroups([keep, state, own, organize, end, del])
  }

  const element = (
    <>
      <RenameDialog
        visible={renaming && target !== null}
        title={target?.title ?? ''}
        onClose={() => setRenaming(false)}
        onSave={async (title) => {
          const link = target ? linkOf(target) : null
          if (!link || !target) throw new Error('现在连不上这个会话所在的电脑。')
          await link.request('sessions.rename', { sessionId: target.id, title })
        }}
      />
      <DeleteSessionDialog
        summary={deleting}
        visible={deleting !== null}
        onClose={() => setDeleting(null)}
        onArchive={() => {
          const s = deleting
          setDeleting(null)
          if (s) archive(s)
        }}
        onDelete={() => {
          const s = deleting
          setDeleting(null)
          if (s) {
            run(
              s,
              '没能删除',
              (link) => link.request('sessions.delete', { sessionId: s.id }),
              onGone,
            )
          }
        }}
      />
    </>
  )

  return {
    open: (summary) => openMenuSheet(sessionTitle(summary), menu(summary)),
    menu,
    ...actions,
    archive,
    rename,
    resumeOf,
    remove,
    element,
  }
}

/** Asks, then forks a whole session on the active computer and opens the new one. */
/** Mutes or unmutes a session's notifications, saying so when the phone could not keep it. */
export function toggleMuted(sessionId: string, on: boolean): void {
  setMuted(sessionId, on).then(
    () => haptic.success(),
    () => {
      haptic.warning()
      showNotice({
        text: on ? '没能静音通知，请再试一次。' : '没能取消静音，请再试一次。',
        tone: 'warning',
      })
    },
  )
}

export function forkSession(link: HostLink | null, summary: SessionSummary): void {
  if (!link) return
  Alert.alert('分叉这个会话？', '新会话会带上目前的整个对话，原来的会话不受影响。', [
    { text: '取消', style: 'cancel' },
    {
      text: '分叉',
      onPress: () =>
        void link.request('sessions.fork', { sessionId: summary.id }).then(
          (made) => {
            haptic.success()
            router.push(`/session/${(made as SessionSummary).id}`)
          },
          (error: unknown) => Alert.alert('没能分叉', errorText(error)),
        ),
    },
  ])
}
