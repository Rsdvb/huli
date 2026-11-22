import { ArrowUp01Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { recapSince, type Recap } from '@shared/recap'
import { Glyph } from '@renderer/features/shell/glyph'
import { useThreadsStore } from '@renderer/stores/threads'
import { useJumpToMessage } from '../outline/use-jump'
import type { ThreadJumps } from '../thread'
import type { Item } from '../thread-items'
import { markSeen, seenMark } from './seen'

// How long the item a jump went to stays marked.
const FOUND_MS = 1800

/** What happened since this device last saw the session, from the replica's thread now. */
function recapNow(sessionId: string): Recap | null {
  const replica = useThreadsStore.getState().replicas[sessionId]
  if (!replica?.state) return null
  return recapSince(replica.state, seenMark(sessionId), {
    now: Date.now(),
    older: replica.older !== null,
  })
}

/** The recap as one line: what changed, ran and asked, then the latest reply. */
function recapText(t: TFunction<'session'>, recap: Recap): string {
  const parts: string[] = []
  if (recap.files > 0) {
    parts.push(
      t('thread.recap.files', { count: recap.files }) +
        (recap.added + recap.removed > 0
          ? t('thread.recap.lines', { added: recap.added, removed: recap.removed })
          : ''),
    )
  }
  if (recap.commands > 0) parts.push(t('thread.recap.commands', { count: recap.commands }))
  if (recap.approvals > 0) {
    parts.push(
      recap.waiting > 0
        ? t('thread.recap.approvalsWaiting', { count: recap.approvals, waiting: recap.waiting })
        : t('thread.recap.approvals', { count: recap.approvals }),
    )
  }
  if (recap.errors > 0) parts.push(t('thread.recap.errors', { count: recap.errors }))
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
 * meanwhile and the way to where they left off. Worked out once when the thread opens and again
 * when the window comes to the front, from where this device last saw it; nothing runs between.
 * Inside the message scroller.
 */
export function RecapLine({
  sessionId,
  items,
  sent,
  viewport,
  content,
  jumps,
}: {
  sessionId: string
  items: readonly Item[]
  /** The latest message sent, whose change, a new one, ends the recap. */
  sent: string | null
  viewport: RefObject<HTMLDivElement | null>
  content: RefObject<HTMLDivElement | null>
  jumps: ThreadJumps
}) {
  const { t } = useTranslation('session')
  const [recap, setRecap] = useState(() => recapNow(sessionId))
  const [sentAtRecap, setSentAtRecap] = useState(sent)
  const { jumpTo } = useJumpToMessage(sessionId, viewport, content, jumps)
  const latest = useRef(items)
  useEffect(() => {
    latest.current = items
  })

  useEffect(() => {
    markSeen(sessionId)
    const away = (): void => markSeen(sessionId)
    const back = (): void => {
      const next = recapNow(sessionId)
      if (!next) return
      setRecap(next)
      setSentAtRecap(latestSent(sessionId))
    }
    const visibility = (): void => (document.visibilityState === 'visible' ? back() : away())
    window.addEventListener('blur', away)
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('blur', away)
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', visibility)
      markSeen(sessionId)
    }
  }, [sessionId])

  if (!recap || sent !== sentAtRecap) return null
  const text = recapText(t, recap)
  const lead = t(recap.partial ? 'thread.recap.leadPartial' : 'thread.recap.lead')

  const jump = (): void => {
    const order = useThreadsStore.getState().replicas[sessionId]?.state?.order ?? []
    const key = itemFrom(latest.current, order, recap.from)
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
        onClick={() => setRecap(null)}
      >
        <Glyph icon={Cancel01Icon} size={12} />
      </button>
    </div>
  )
}

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
