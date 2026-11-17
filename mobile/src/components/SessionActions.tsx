// What can be done to a session from the phone, by the desktop's menu rules: retry or stop it, pin,
// rename, mark unread, open its pull request, copy its resume command, archive it (asking first
// when work runs, with Undo after) or restore it, and delete it through the desktop's dialog. The
// list, the archive and a session's own menu each offer their part of it.

import { useState, type ReactNode } from 'react'
import { ActionSheetIOS, Alert, Linking, Platform } from 'react-native'
import type { SessionSummary } from '@shared/agent-host'
import { call, sessionFolder } from '../git'
import { useHost } from '../host'
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
import { showNotice } from '../ui/NoticeBar'
import { copyText } from '../ui/session/feedback'
import { DeleteSessionDialog } from './DeleteSessionDialog'
import { RenameDialog } from './RenameDialog'
import { Sheet, type SheetItem } from './Sheet'

export type ActionsPlace = 'list' | 'archive' | 'session'

export interface SessionActions {
  open(summary: SessionSummary): void
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
  /** Renders the sheet and the dialogs; put it anywhere in the screen. */
  element: ReactNode
}

export function useSessionActions(
  place: ActionsPlace,
  /** After the session was archived, restored or deleted, as a session screen leaves then. */
  onGone?: () => void,
  /** Items of the place's own, listed first, such as a session's changes. */
  extra?: (summary: SessionSummary) => SheetItem[],
): SessionActions {
  const { link } = useHost()
  const [target, setTarget] = useState<SessionSummary | null>(null)
  const [sheet, setSheet] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)

  const run = (failed: string, request: () => Promise<unknown>, after?: () => void) => {
    if (!link) return
    request().then(
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
      '没能归档',
      () => link!.request('sessions.archive', { sessionId: s.id }),
      () => {
        onGone?.()
        showNotice({
          text: `已归档“${sessionTitle(s)}”`,
          action: {
            label: '撤销',
            onPress: () =>
              void link
                ?.request('sessions.unarchive', { sessionId: s.id })
                .catch((error: unknown) => Alert.alert('没能恢复', errorText(error))),
          },
        })
      },
    )

  // Archiving stops the agent's work and its terminals, so running work is named and confirmed.
  const archive = (s: SessionSummary) => {
    if (!link) return
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

  const resumeOf = (s: SessionSummary) => resumeCommand(s, sessionFolder(s))

  const actions = {
    togglePin: (s: SessionSummary) =>
      run('没能置顶', () =>
        link!.request('sessions.pin', { sessionId: s.id, pinned: s.pinnedAt === null }),
      ),
    restore: (s: SessionSummary) =>
      run('没能恢复', () => link!.request('sessions.unarchive', { sessionId: s.id }), onGone),
    toggleUnread: (s: SessionSummary) =>
      run('没能标记', () =>
        link!.request('sessions.markUnread', { sessionId: s.id, unread: s.attention !== 'unread' }),
      ),
    retry: (s: SessionSummary) =>
      run('没能重试', () => link!.request('sessions.retry', { sessionId: s.id })),
    stop: (s: SessionSummary) =>
      run('没能停止', () => link!.request('sessions.cancel', { sessionId: s.id })),
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

  const items = (s: SessionSummary): SheetItem[] => {
    const running = isRunning(s)
    const prs = sessionPullRequests(s)
    const state: SheetItem[] = running
      ? [{ key: 'stop', label: '停止', destructive: true, onPress: () => actions.stop(s) }]
      : canRetry(s)
        ? [{ key: 'retry', label: '重试', onPress: () => actions.retry(s) }]
        : []
    const pin: SheetItem = {
      key: 'pin',
      label: s.pinnedAt !== null ? '取消置顶' : '置顶',
      onPress: () => actions.togglePin(s),
    }
    const rename: SheetItem = {
      key: 'rename',
      label: '重命名…',
      onPress: () => {
        setTarget(s)
        setRenaming(true)
      },
    }
    const unread: SheetItem = {
      key: 'unread',
      label: s.attention === 'unread' ? '标为已读' : '标为未读',
      onPress: () => actions.toggleUnread(s),
    }
    const pr: SheetItem[] = prs.slice(0, 3).map((p) => ({
      key: `pr:${p.url}`,
      label: `打开 Pull Request #${p.number}`,
      onPress: () => void Linking.openURL(p.url),
    }))
    const resume: SheetItem[] = resumeOf(s)
      ? [{ key: 'resume', label: '复制恢复命令', onPress: () => actions.copyResume(s) }]
      : []
    const archiveItem: SheetItem = { key: 'archive', label: '归档', onPress: () => archive(s) }
    const restore: SheetItem = {
      key: 'restore',
      label: '恢复到会话列表',
      onPress: () => actions.restore(s),
    }
    const del: SheetItem[] = running
      ? []
      : [{ key: 'delete', label: '删除…', destructive: true, onPress: () => remove(s) }]
    const topLevel = s.parentId === null
    if (place === 'archive') return [restore, rename, ...del]
    return [
      ...state,
      ...(topLevel ? [pin] : []),
      rename,
      unread,
      ...pr,
      ...resume,
      ...(topLevel ? [s.archivedAt !== null ? restore : archiveItem] : []),
      ...del,
    ]
  }

  const element = (
    <>
      <Sheet
        visible={sheet && target !== null}
        title={target ? sessionTitle(target) : undefined}
        items={target ? [...(extra?.(target) ?? []), ...items(target)] : []}
        onClose={() => setSheet(false)}
      />
      <RenameDialog
        visible={renaming && target !== null}
        title={target?.title ?? ''}
        onClose={() => setRenaming(false)}
        onSave={async (title) => {
          if (!link || !target) return
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
          if (s)
            run('没能删除', () => link!.request('sessions.delete', { sessionId: s.id }), onGone)
        }}
      />
    </>
  )

  return {
    open: (summary) => {
      setTarget(summary)
      // iOS has the system's own action sheet, glass on iOS 26; elsewhere ours.
      if (Platform.OS !== 'ios') return setSheet(true)
      const list = [...(extra?.(summary) ?? []), ...items(summary)]
      const destructive = list.flatMap((item, index) => (item.destructive ? [index] : []))
      haptic.tap()
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: sessionTitle(summary),
          options: [...list.map((item) => item.label), '取消'],
          cancelButtonIndex: list.length,
          ...(destructive.length > 0 ? { destructiveButtonIndex: destructive } : {}),
        },
        (index) => list[index]?.onPress(),
      )
    },
    ...actions,
    archive,
    rename: (s) => {
      setTarget(s)
      setRenaming(true)
    },
    resumeOf,
    remove,
    element,
  }
}
