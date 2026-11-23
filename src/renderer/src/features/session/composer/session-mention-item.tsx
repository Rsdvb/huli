// Huli: a session's row in the composer's `@` list (@ a session).

import { useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import type { SessionMention } from './session-mentions'

/** A session's row in the `@` list: its agent, its title with the match tinted, its project. */
export function SessionMentionItem({
  id,
  row,
  highlighted,
  onHighlight,
  onChoose,
}: {
  id: string
  row: SessionMention
  highlighted: boolean
  onHighlight: () => void
  onChoose: (row: SessionMention) => void
}) {
  const { t } = useTranslation('composer')
  const [from, length] = row.match ?? [0, 0]
  return (
    <div
      role="option"
      id={id}
      aria-selected={highlighted}
      data-highlighted={highlighted ? '' : undefined}
      // Pressing a row keeps the focus, and with it the caret, in the box.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHighlight}
      onClick={() => onChoose(row)}
      title={row.title}
      className="flex min-h-7.5 cursor-default items-center gap-2.25 rounded-md px-2 text-menu outline-none select-none data-highlighted:bg-selected"
    >
      <AgentMark agent={row.agentId} size={15} hostId={row.hostId} />
      <span className="min-w-0 flex-1 truncate">
        {row.title.slice(0, from)}
        {length > 0 && (
          <mark className="rounded-xs bg-match text-primary">
            {row.title.slice(from, from + length)}
          </mark>
        )}
        {row.title.slice(from + length)}
      </span>
      <span className="max-w-28 shrink-0 truncate pl-3 text-hint text-tertiary">
        {row.project ?? t('mentions.noProject')}
      </span>
    </div>
  )
}
