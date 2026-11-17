// An artifact's comment threads, read again when they change and with each new version, which
// moves their anchors, as the desktop's use-comments.ts; and how a thread's anchor reads.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostEvent } from '@shared/agent-host'
import { isAnswered, type CommentAnchor, type CommentThread } from '@shared/artifact-comments'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import { snippet, type Pin } from '@shared/artifact-runtime/page-messages'
import type { HostLink } from '@shared/remote/link'
import { errorText } from '../sessions'

export function useComments(
  link: HostLink | null,
  id: string,
): {
  threads: CommentThread[] | null
  error: string | null
  reload(): void
  /** A thread the computer answered with, shown before the event that follows it. */
  apply(thread: CommentThread): void
} {
  const [threads, setThreads] = useState<CommentThread[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reading = useRef({ busy: false, again: false })
  const live = useRef(true)

  const read = useCallback(() => {
    if (!link) return
    const state = reading.current
    if (state.busy) {
      state.again = true
      return
    }
    state.busy = true
    link
      .request('artifacts.comments', { id })
      .then(
        (next) => {
          if (!live.current) return
          setThreads(Array.isArray(next) ? (next as CommentThread[]) : [])
          setError(null)
        },
        (failure: unknown) => live.current && setError(errorText(failure)),
      )
      .finally(() => {
        state.busy = false
        if (state.again && live.current) {
          state.again = false
          read()
        }
      })
  }, [link, id])

  useEffect(() => {
    live.current = true
    read()
    if (!link) return
    const off = link.onHostEvent((value) => {
      const event = value as HostEvent
      if (
        (event.type === 'artifacts.comments' || event.type === 'artifacts.version') &&
        event.id === id
      ) {
        read()
      }
    })
    return () => {
      live.current = false
      off()
    }
  }, [link, id, read])

  const apply = useCallback((thread: CommentThread) => {
    setThreads((list) => {
      if (!list) return [thread]
      const at = list.findIndex((t) => t.id === thread.id)
      return at < 0 ? [...list, thread] : list.map((t, i) => (i === at ? thread : t))
    })
  }, [])

  return { threads, error, reload: read, apply }
}

/** 「设置」页 › button「保存」, the page alone, or the element alone. */
export function anchorLabel(anchor: CommentAnchor): string {
  const page = anchor.page ? (anchor.page.name ?? `第 ${anchor.page.number} 页`) : null
  const text = snippet(anchor.text)
  const element = anchor.tag === null ? null : text ? `${anchor.tag}「${text}」` : anchor.tag
  if (page && element) return `${page} › ${element}`
  return element ?? page ?? '整个页面'
}

/** The page a comment is on: a canvas page by number and name, or none for a single page. */
export interface CommentPage {
  /** The file the page is; an old canvas's pages are all its entry page. */
  file: string
  page: { number: number; name: string | null } | null
}

/** The pins a page shows: its open threads, numbered as the list numbers them. */
export function pinsOf(threads: readonly CommentThread[] | null, at: CommentPage): Pin[] {
  const open = threads?.filter((thread) => thread.resolvedAt === null) ?? []
  return open.flatMap((thread, i) => {
    const { anchor } = thread
    if (at.page !== null && anchor.page?.number !== at.page.number) return []
    const src = anchor.missing || anchor.path !== at.file ? null : anchor.offset
    return [{ n: i + 1, src, answered: isAnswered(thread) }]
  })
}

/** A comment on the whole page. */
export function pageAnchor(version: number, at: CommentPage | null): CommentAnchor {
  return {
    version,
    path: at?.file ?? ARTIFACT_ENTRY,
    page: at?.page ?? null,
    offset: null,
    tag: null,
    text: '',
    missing: false,
  }
}
