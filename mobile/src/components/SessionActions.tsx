// What can be done to a session from the phone: pin, rename, mark unread, archive or restore, and
// delete. The list, the archive and a session's own menu each offer their part of it.

import { useState, type ReactNode } from 'react'
import { Alert } from 'react-native'
import type { SessionSummary } from '@shared/agent-host'
import { useHost } from '../host'
import { errorText, sessionTitle } from '../sessions'
import { RenameDialog } from './RenameDialog'
import { Sheet, type SheetItem } from './Sheet'

export type ActionsPlace = 'list' | 'archive' | 'session'

export interface SessionActions {
  open(summary: SessionSummary): void
  /** Renders the sheet and the rename dialog; put it anywhere in the screen. */
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

  const run = (failed: string, request: () => Promise<unknown>, after?: () => void) => {
    if (!link) return
    request().then(after, (error: unknown) => Alert.alert(failed, errorText(error)))
  }

  const items = (s: SessionSummary): SheetItem[] => {
    const sessionId = s.id
    const pin: SheetItem = {
      key: 'pin',
      label: s.pinnedAt !== null ? '取消置顶' : '置顶',
      onPress: () =>
        run('没能置顶', () =>
          link!.request('sessions.pin', { sessionId, pinned: s.pinnedAt === null }),
        ),
    }
    const rename: SheetItem = { key: 'rename', label: '重命名', onPress: () => setRenaming(true) }
    const unread: SheetItem = {
      key: 'unread',
      label: s.attention === 'unread' ? '标为已读' : '标为未读',
      onPress: () =>
        run('没能标记', () =>
          link!.request('sessions.markUnread', { sessionId, unread: s.attention !== 'unread' }),
        ),
    }
    const archive: SheetItem = {
      key: 'archive',
      label: '归档',
      onPress: () =>
        run('没能归档', () => link!.request('sessions.archive', { sessionId }), onGone),
    }
    const restore: SheetItem = {
      key: 'restore',
      label: '恢复到会话列表',
      onPress: () =>
        run('没能恢复', () => link!.request('sessions.unarchive', { sessionId }), onGone),
    }
    const remove: SheetItem = {
      key: 'delete',
      label: '删除',
      destructive: true,
      onPress: () =>
        Alert.alert(
          '删除这个会话？',
          `「${sessionTitle(s)}」和它的对话记录会从电脑上删除，不能撤销。`,
          [
            { text: '取消', style: 'cancel' },
            {
              text: '删除',
              style: 'destructive',
              onPress: () =>
                run('没能删除', () => link!.request('sessions.delete', { sessionId }), onGone),
            },
          ],
        ),
    }
    if (place === 'archive') return [restore, rename, remove]
    if (place === 'session') {
      return s.archivedAt !== null ? [rename, restore, remove] : [rename, pin, archive, remove]
    }
    return [pin, rename, unread, archive, remove]
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
    </>
  )

  return {
    open: (summary) => {
      setTarget(summary)
      setSheet(true)
    },
    element,
  }
}
