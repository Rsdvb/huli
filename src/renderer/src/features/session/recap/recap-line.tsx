import { ArrowUp01Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { NOT_VISITED, recapStep, type Recap, type RecapEvent, type RecapVisit } from '@shared/recap'
import { Glyph } from '@renderer/features/shell/glyph'
import { useThreadsStore } from '@renderer/stores/threads'
import { useJumpToMessage } from '../outline/use-jump'
import type { ThreadJumps } from '../thread'
import type { Item } from '../thread-items'
import { markSeen, seenMark } from './seen'

// How long the item a jump went to stays marked.
const FOUND_MS = 1800

/**
 * The recap as one line: what changed, ran and asked, then the latest reply. Counts the recap
 * could not see back to read as at least so many ("16+"), without the lines.
 */
function recapText(t: TFunction<'session'>, recap: Recap): string {
  const parts: string[] = []
  const more = recap.partial ? 'More' : ''
  if (recap.files > 0) {
    parts.push(
      t(`thread.recap.files${more}`, { count: recap.files }) +
        (!recap.partial && recap.added + recap.removed > 0
          ? t('thread.recap.lines', { added: recap.added, removed: recap.removed })
          : ''),
    )
  }
  if (recap.commands > 0) parts.push(t(`thread.recap.commands${more}`, { count: recap.commands }))
  if (recap.approvals > 0) {
    parts.push(
      recap.waiting > 0
        ? t(`thread.recap.approvalsWaiting${more}`, {
            count: recap.approvals,
            waiting: recap.waiting,
          })
        : t(`thread.recap.approvals${more}`, { count: recap.approvals }),
    )
  }
  if (recap.errors > 0) parts.push(t(`thread.recap.errors${more}`, { count: recap.errors }))
  if (recap.reply) parts.push(t('thread.recap.reply', { text: recap.reply }))
  return parts.join(t('thread.recap.separator'))
}

/** The first item that holds an entry from `from` on, by the thread's whole order. */
function itemFrom(items: readonly Item[], order: readonly string[], from: string): string | null {
  const start = order.indexOf(from)
  if (start < 0) return null
  const after = new Set(order.slice(start))
  for (const item of items) {
    const ids =
      item.type === 'entry'
        ? [item.id]
        : item.type === 'run' || item.type === 'group'
          ? item.ids
          : []
    if (ids.some((id) => after.has(id))) return item.key
  }
  return null
}

/**
 * Huli: the line that greets a user back in a session they left a while ago, with what happened
 * meanwhile and the way to where they left off. The session is in view while its pane shows it
 * and the window is not hidden (minimized, or covered where the system tells): time in view
 * counts as seen, even with another app in front, as the user can still watch it. Worked out
 * when it comes into view; nothing runs between. A bar over the message scroller, which gives it
 * its room rather than lying under it; inside the scroller's provider.
 */
export const RecapLine = memo(function RecapLine({
  sessionId,
  items,
  sent,
  viewport,
  content,
  jumps,
}: {
  sessionId: string
  /** The thread's items now. */
  items: () => readonly Item[]
  /** The latest message sent, whose change, a new one, is done with the recap. */
  sent: string | null
  viewport: RefObject<HTMLDivElement | null>
  content: RefObject<HTMLDivElement | null>
  jumps: ThreadJumps
}) {
  const { t } = useTranslation('session')
  const [recap, setRecap] = useState<Recap | null>(null)
  const visit = useRef<RecapVisit | null>(null)
  const sentAtRecap = useRef(sent)
  const { jumpTo } = useJumpToMessage(sessionId, viewport, content, jumps)

  const step = useCallback(
    (event: RecapEvent) => {
      const replica = useThreadsStore.getState().replicas[sessionId]
      if (!replica?.state) return
      const was = (visit.current ??= { ...NOT_VISITED, mark: seenMark(sessionId) })
      const next = recapStep(was, event, replica.state, {
        now: Date.now(),
        older: replica.older !== null,
      })
      if (next === was) return
      visit.current = next
      if (next.mark && next.mark !== was.mark) markSeen(sessionId, next.mark)
      if (next.shown !== was.shown) {
        sentAtRecap.current = latestSent(sessionId)
        setRecap(next.shown)
      }
    },
    [sessionId],
  )

  // Before the first paint, so the thread never moves under a line that comes a frame late.
  const leaving = useRef(false)
  useLayoutEffect(() => {
    const change = (): void => step(document.visibilityState === 'visible' ? 'view' : 'leave')
    const close = (): void => step('leave')
    // StrictMode's remount, straight after its unmount, never left.
    if (leaving.current) leaving.current = false
    else change()
    document.addEventListener('visibilitychange', change)
    window.addEventListener('pagehide', close)
    return () => {
      document.removeEventListener('visibilitychange', change)
      window.removeEventListener('pagehide', close)
      leaving.current = true
      queueMicrotask(() => {
        if (!leaving.current) return
        leaving.current = false
        step('leave')
      })
    }
  }, [step])

  useEffect(() => {
    if (recap && sent !== sentAtRecap.current) step('done')
  }, [recap, sent, step])

  if (!recap) return null
  const text = recapText(t, recap)
  const lead = t('thread.recap.lead')

  const jump = (): void => {
    const order = useThreadsStore.getState().replicas[sessionId]?.state?.order ?? []
    const key = itemFrom(items(), order, recap.from)
    step('done')
    if (!key) return
    // The item is loaded, as the recap's own entries are: no page is read for it.
    void jumpTo({ entryId: key, pos: Number.MAX_SAFE_INTEGER }).then((arrived) => {
      const item = arrived
        ? content.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(key)}"]`)
        : null
      if (!item) return
      item.dataset.found = ''
      setTimeout(() => delete item.dataset.found, FOUND_MS)
    })
  }

  return (
    <div className="ks-recap" role="status">
      <p className="ks-recap__text" title={`${lead}${text}`}>
        <span className="ks-recap__lead">{lead}</span>
        {text}
      </p>
      <button type="button" className="ks-recap__jump" onClick={jump}>
        <Glyph icon={ArrowUp01Icon} size={13} />
        {t('thread.recap.jump')}
      </button>
      <button
        type="button"
        className="ks-recap__close"
        aria-label={t('thread.recap.dismiss')}
        title={t('thread.recap.dismiss')}
        onClick={() => step('done')}
      >
        <Glyph icon={Cancel01Icon} size={12} />
      </button>
    </div>
  )
})

/** The latest message the user sent in the session, as the thread's `sent` reads it. */
function latestSent(sessionId: string): string | null {
  const state = useThreadsStore.getState().replicas[sessionId]?.state
  if (!state) return null
  for (let i = state.order.length - 1; i >= 0; i--) {
    const entry = state.byId[state.order[i]!]
    if (entry?.kind === 'user' && !entry.approval) return entry.id
  }
  return null
}
