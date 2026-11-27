// Huli: 接力到新会话. A session whose context grew large asks its agent for a handoff summary, and
// a new session of the same agent, in the same folder, starts from that summary alone: its
// requests upload the summary instead of the whole conversation so far.

import { LOCALES } from '@shared/locale'
import type { ThreadState } from '@shared/thread'
import { t } from './i18n'

/** What Kettu asks the agent for, as a message of its own in the old session. */
export function handoffPrompt(): string {
  return t('handoff.prompt')
}

/**
 * The new session's first message: where it comes from, the summary, and what to do first. The
 * summary is joined in, never interpolated, so nothing in it reads as i18next's markup.
 */
export function handoffMessage(title: string, summary: string): string {
  return [t('handoff.intro', { title }), summary.trim(), t('handoff.outro')].join('\n\n')
}

/**
 * The summary the agent wrote: its last message after Kettu's request, `entryId`. Null when it
 * wrote none there, so an earlier reply is never taken for it.
 */
export function handoffReply(
  thread: Pick<ThreadState, 'order' | 'byId'>,
  entryId: string,
): string | null {
  const start = thread.order.indexOf(entryId)
  if (start === -1) return null
  for (let i = thread.order.length - 1; i > start; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind === 'agent' && entry.markdown.trim() !== '') return entry.markdown
  }
  return null
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The title without the mark of an earlier handoff, in any language, so marks never pile up. */
export function handoffBase(title: string): string {
  const mark = '\u0001'
  for (const lng of LOCALES) {
    const pattern = escapeRegExp(t('handoff.title', { lng, title: mark })).replace(mark, '(.+)')
    const match = new RegExp(`^${pattern}$`, 's').exec(title)
    if (match) return match[1]!
  }
  return title
}

/** The new session's title: the old one's, marked as going on from it. */
export function handoffTitle(title: string): string {
  return t('handoff.title', { title: handoffBase(title) })
}
