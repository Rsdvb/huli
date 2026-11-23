// Huli: the end of a turn the model declined to continue, as Claude's `stop_reason: "refusal"`
// reports it. The API gives no reason, so the note says so, quotes what the model itself said
// when its reply holds an explanation, and offers the next steps: the same message again, the
// message back in the composer to rephrase, or another model. Huli's own; see tools/huli/README.md.

import { useState } from 'react'
import { InformationCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { ThreadState, UserContent } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { shortDuration } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { inLatestTurn } from '../turn-phase'
import { useEditable, useEditFrom } from './edit-from-here'

/** Words a model explains a refusal with, in English and Chinese. */
const EXPLAINS =
  /\b(?:I\s+(?:can(?:no|')t|won't|will\s+not|am\s+not\s+able|'m\s+not\s+able|must\s+decline|need\s+to\s+decline)|I'm\s+(?:sorry|unable)|unable\s+to\s+(?:help|assist|continue)|not\s+(?:able|comfortable)\s+to)\b|无法|不能|抱歉|拒绝/i
const QUOTE_CHARS = 280

interface Explained {
  /** The paragraph that explains it, to quote when the reply holds more than that. */
  quote: string | null
}

/** The turn's prompt and, when the model's last message explains itself, that explanation. */
function refusedTurn(
  state: ThreadState,
  endId: string,
): { prompt: UserContent[] | null; text: string; said: Explained | null; userId: string | null } {
  let at = state.order.indexOf(endId)
  if (at === -1) at = state.order.length
  let said: Explained | null = null
  let lastAgent = false
  for (let i = at - 1; i >= 0; i--) {
    const entry = state.byId[state.order[i]!]
    if (!entry) continue
    if (entry.kind === 'agent' && !lastAgent) {
      lastAgent = true
      said = explanation(entry.markdown)
    }
    if (entry.kind === 'user' && !entry.steered) {
      const text = entry.content
        .flatMap((c) => (c.type === 'text' && c.text.trim() ? [c.text] : []))
        .join('\n\n')
      return { prompt: entry.from ? null : entry.content, text, said, userId: entry.id }
    }
  }
  return { prompt: null, text: '', said, userId: null }
}

/**
 * The last paragraph of a reply that reads as the model explaining why it stopped; it is quoted
 * only when the reply says more, since a reply of that alone shows just above.
 */
function explanation(markdown: string): Explained | null {
  const paragraphs = markdown
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .replace(/[*_`#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
  for (let i = paragraphs.length - 1; i >= Math.max(0, paragraphs.length - 3); i--) {
    const paragraph = paragraphs[i]!
    if (!EXPLAINS.test(paragraph)) continue
    if (paragraphs.length === 1) return { quote: null }
    const chars = Array.from(paragraph)
    return {
      quote:
        chars.length > QUOTE_CHARS ? `${chars.slice(0, QUOTE_CHARS - 1).join('')}…` : paragraph,
    }
  }
  return null
}

export function RefusalEnd({
  sessionId,
  entryId,
  durationMs,
  className,
}: {
  sessionId: string
  /** The turn's end entry. */
  entryId: string
  durationMs: number
  className?: string
}) {
  const { t } = useTranslation('session')
  const turn = useThreadsStore(
    useShallow((s) => {
      const state = s.replicas[sessionId]?.state
      if (!state) return null
      const { prompt, text, said, userId } = refusedTurn(state, entryId)
      const { status, origin } = state.session
      return {
        prompt,
        text,
        userId,
        // The state's own values or primitives: an object made each read never compares equal.
        explained: said !== null,
        quote: said?.quote ?? null,
        // As Resume of a cut turn: while it ends the latest turn and the session is free.
        actionable:
          origin === 'user' &&
          (status === 'ready' || status === 'closed') &&
          inLatestTurn(state, entryId),
      }
    }),
  )
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const again = () => {
    if (!turn?.prompt) return
    setSending(true)
    setError(null)
    // Held after a success: the buttons go once the turn that starts reaches the replica.
    host('sessions.queue', { sessionId, content: turn.prompt }).catch((e: unknown) => {
      setError(errorMessage(e))
      setSending(false)
    })
  }
  // Edit message goes back to the message as Edit from here does, where the agent can cut its
  // conversation there; elsewhere it puts the text in the composer to send again.
  const userId = turn?.userId ?? ''
  const editable = useEditable(sessionId, userId)
  const edit = useEditFrom(sessionId, userId)
  const rephrase = (button: Element) => {
    if (editable) {
      edit.start(button)
      return
    }
    if (!turn?.text) return
    emitAppEvent({ kind: 'insert-into-composer', sessionId, text: turn.text })
  }
  const title = t('refusal.title')
  return (
    <Alert variant="warning" className={cn('ks-notice py-2.5', className)}>
      <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={1.9} aria-hidden />
      <AlertTitle className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate">{title}</span>
        {durationMs >= 1000 && (
          <span className="flex-none text-xs font-normal text-muted-foreground tabular">
            {shortDuration(durationMs)}
          </span>
        )}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-1.5 text-small">
        {turn?.quote && (
          <blockquote className="border-l-2 border-subtle pl-2.5 text-secondary italic">
            {turn.quote}
          </blockquote>
        )}
        <p>{turn?.explained ? t('refusal.saidBody') : t('refusal.body')}</p>
        {error && <p className="text-danger">{error}</p>}
        {turn?.actionable && (turn.prompt || turn.text) && (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {turn.prompt && (
              <Button size="xs" variant="outline" disabled={sending} onClick={again}>
                {t('refusal.again')}
              </Button>
            )}
            {turn.text && (
              <Button
                size="xs"
                variant="ghost"
                disabled={sending}
                onClick={(event) => rephrase(event.currentTarget)}
              >
                {t('refusal.rephrase')}
              </Button>
            )}
          </div>
        )}
      </AlertDescription>
      {edit.popover}
    </Alert>
  )
}
