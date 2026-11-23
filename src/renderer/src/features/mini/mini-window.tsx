// Huli: the mini window's page (小窗): one session's status, its last reply's line, and a box to
// reply in, over the other windows. It reads the session once it is shown and then follows the
// host's events; nothing runs between them. See src/main/mini-window.ts.

import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight01Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { MiniWindowApi } from '@shared/mini-window'
import type { ThreadEntry } from '@shared/thread'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'

const api = window.kettu as unknown as MiniWindowApi

const LINE_CHARS = 240

/** The reply's first paragraph past a heading, as one line of plain text. */
function replyLine(markdown: string): string | null {
  const paragraphs = markdown
    .replace(/```[\s\S]*?(```|$)/g, '')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  const paragraph = paragraphs.find((part) => !/^#{1,6}\s/.test(part)) ?? paragraphs[0] ?? ''
  const text = paragraph
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, '')
    .replace(/(\*\*|\*|~~|`)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text
}

function lastReply(entries: readonly ThreadEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.kind === 'agent' && entry.markdown.trim()) return replyLine(entry.markdown)
  }
  return null
}

type Shown = 'working' | 'waiting' | 'failed' | 'done' | 'ready'

function shownState(summary: SessionSummary): Shown {
  if (summary.status === 'awaiting_permission' || summary.permissionCount > 0) return 'waiting'
  if (summary.status === 'running' || summary.status === 'starting') return 'working'
  if (summary.status === 'failed' || summary.status === 'auth_required') return 'failed'
  return summary.lastTurn ? 'done' : 'ready'
}

export function MiniWindow() {
  const { t } = useTranslation('tray')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [gone, setGone] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const ended = useRef<number | null>(null)

  useEffect(
    () =>
      api.mini.onTarget((target) => {
        setSessionId(target.sessionId)
        setSummary(null)
        setGone(false)
        setLine(null)
        setNote(null)
      }),
    [],
  )

  useEffect(() => {
    if (!sessionId) return
    let live = true
    const readLine = () => {
      api.agents
        .request('sessions.snapshot', { sessionId })
        .then((snapshot) => {
          if (live) setLine(lastReply(snapshot.entries))
        })
        .catch(() => {})
    }
    api.agents
      .request('sessions.list', {})
      .then((sessions) => {
        if (!live) return
        const found = sessions.find((each) => each.id === sessionId) ?? null
        setSummary(found)
        setGone(found === null)
        ended.current = found?.lastTurn?.endedAt ?? null
        if (found) readLine()
      })
      .catch(() => {})
    const offEvent = api.agents.onEvent((event) => {
      if (event.type === 'session.summary' && event.summary.id === sessionId) {
        setSummary(event.summary)
        const endedAt = event.summary.lastTurn?.endedAt ?? null
        // A turn that ended has a new reply to show.
        if (endedAt !== ended.current) {
          ended.current = endedAt
          readLine()
        }
      } else if (event.type === 'session.removed' && event.sessionId === sessionId) {
        setSummary(null)
        setGone(true)
      }
    })
    return () => {
      live = false
      offEvent()
    }
  }, [sessionId])

  const send = () => {
    const text = draft.trim()
    if (!sessionId || !text || sending || gone) return
    setSending(true)
    setNote(null)
    api.agents
      .request('sessions.queue', { sessionId, content: [{ type: 'text', text }] })
      .then(({ itemId }) => {
        setDraft('')
        setNote(itemId === null ? t('mini.sent') : t('mini.queued'))
      })
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setSending(false))
  }

  const state = summary ? shownState(summary) : null
  const status = gone
    ? t('mini.gone')
    : !summary
      ? t('mini.loading')
      : state === 'working'
        ? summary.working?.step
          ? t('mini.workingOn', { what: summary.working.step })
          : t('mini.working')
        : t(`mini.${state!}`)
  const shownLine = state === 'working' ? null : line

  return (
    <div className="flex h-screen flex-col bg-(--bg-surface) text-primary">
      <header className="app-region-drag flex h-8 shrink-0 items-center gap-2 pr-1 pl-3">
        <span
          aria-hidden
          className={cn(
            'size-2 shrink-0 rounded-full',
            state === 'working' && 'bg-(--shell-accent)',
            state === 'waiting' && 'bg-attention-dot',
            state === 'failed' && 'bg-danger',
            (state === 'done' || state === 'ready' || state === null) && 'bg-success',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-control font-semibold">
          {summary?.title ?? t('mini.untitled')}
        </span>
        <button
          type="button"
          aria-label={t('mini.open')}
          title={t('mini.open')}
          className="app-region-no-drag grid size-6 place-items-center rounded-md text-tertiary outline-none focus-ring hover:bg-hover"
          onClick={() => api.mini.showSession()}
        >
          <Glyph icon={ArrowUpRight01Icon} size={14} />
        </button>
        <button
          type="button"
          aria-label={t('mini.close')}
          title={t('mini.close')}
          className="app-region-no-drag grid size-6 place-items-center rounded-md text-tertiary outline-none focus-ring hover:bg-hover"
          onClick={() => api.mini.close()}
        >
          <Glyph icon={Cancel01Icon} size={14} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-1 px-3">
        <div role="status" className="truncate text-caption text-tertiary">
          {status}
        </div>
        <p className="line-clamp-2 min-h-0 text-small text-primary">
          {shownLine ?? (state === 'working' ? '' : t('mini.noReply'))}
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-1 px-2 pb-2">
        <textarea
          rows={1}
          value={draft}
          disabled={gone || !summary}
          placeholder={t('mini.reply')}
          aria-label={t('mini.reply')}
          className="h-8 resize-none rounded-lg bg-(--shell-chip) px-2.5 py-1.5 text-control text-primary outline-none placeholder:text-tertiary focus-ring disabled:opacity-60"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            event.preventDefault()
            send()
          }}
        />
        {note && <span className="truncate px-1 text-caption text-tertiary">{note}</span>}
      </div>
    </div>
  )
}
