import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import {
  rowWaitingSources,
  waitingKey,
  waitingKind,
  type WaitingKind,
  type WaitingSource,
} from './waiting'

// The sources the tooltip names; the rest are counted under them.
const NAMED = 3

/** The count of requests waiting for the user, in the fox orange that marks them everywhere. */
export function WaitingCount({ count, className }: { count: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid h-4 min-w-4 place-items-center rounded-full bg-attention-dot px-[3px] text-[10px] leading-none font-semibold text-attention-foreground tabular-nums',
        className,
      )}
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}

/**
 * A row's requests waiting for the user, as a button in its tools: its tooltip says what waits and
 * where, and a click opens the session the first one waits in, a sub-agent's own page included.
 */
export function WaitingMark({
  rootId,
  count,
}: {
  rootId: string
  /** The row's count, which the sources add up to. */
  count: number
}) {
  const { t } = useTranslation('sidebar')
  // A key rather than the sources, so the mark renders again only when what it says changes.
  useSessionsStore((s) => waitingKey(rowWaitingSources(s.byId, rootId, count)))
  const sources = rowWaitingSources(useSessionsStore.getState().byId, rootId, count)
  const [kinds, setKinds] = useState<Record<string, WaitingKind[]>>({})

  const load = (): void => {
    for (const source of sources.slice(0, NAMED)) {
      const id = source.summary.id
      host('sessions.requests', { sessionId: id })
        .then(({ entries }) => {
          const found = entries.flatMap((entry) => {
            const kind = waitingKind(entry)
            return kind ? [kind] : []
          })
          setKinds((before) => ({ ...before, [id]: found }))
        })
        .catch(() => {})
    }
  }

  const where = (source: WaitingSource): string => {
    const title = sessionTitle(source.summary)
    return source.place === 'here'
      ? t('waiting.here')
      : t(source.place === 'subagent' ? 'waiting.subagent' : 'waiting.subSession', { title })
  }
  const what = (source: WaitingSource): string => {
    const known = kinds[source.summary.id]
    if (!known || known.length === 0) return t('waiting.requests', { count: source.count })
    const unique = [...new Set(known)]
    return unique.map((kind) => t(`waiting.kind.${kind}`)).join(t('waiting.separator'))
  }
  const first = sources[0]
  const label = first
    ? t('waiting.label', { count, where: where(first) })
    : t('indicator.waiting', { count })

  return (
    <Tooltip
      onOpenChange={(open) => {
        if (open) load()
      }}
    >
      <TooltipTrigger
        delay={250}
        render={
          <button
            type="button"
            aria-label={label}
            disabled={!first}
            onClick={() => first && openSession(first.summary.id, first.summary.projectPath)}
            className="ui-as-chat-row__tool kettu-waiting-mark focus-ring"
          />
        }
      >
        <WaitingCount count={count} />
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="flex-col items-start gap-1.5 py-1.5">
        <span className="font-medium">{t('waiting.title', { count })}</span>
        {sources.slice(0, NAMED).map((source) => (
          <span key={source.summary.id} className="flex max-w-64 min-w-0 flex-col">
            <span className="truncate">{where(source)}</span>
            <span className="opacity-70">{what(source)}</span>
          </span>
        ))}
        {sources.length > NAMED && (
          <span className="opacity-80">{t('waiting.more', { count: sources.length - NAMED })}</span>
        )}
        {first && <span className="opacity-60">{t('waiting.go')}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
