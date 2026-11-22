import { memo, useState } from 'react'
import { AiBrain01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { RecalledMemory } from '@shared/thread'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { Marker, MarkerContent, MarkerIcon } from '@renderer/components/ui/marker'
import { basename } from '@renderer/lib/format'
import { Markdown } from '../markdown'
import { useEntry, useEntryAnimation } from '../use-thread'
import type { EntryProps } from './basic'
import { PANEL } from './helpers'

/** A memory's name: its file's, without `.md`, or what stands in for one with none. */
function memoryName(memory: RecalledMemory, summary: string): string {
  if (memory.path.startsWith('<synthesis:')) return summary
  if (/^https?:\/\//i.test(memory.path)) return memory.path
  return basename(memory.path).replace(/\.md$/i, '')
}

/**
 * Huli: the agent's own memory at work in a turn, as a quiet line across the thread: how many it
 * recalled or saved. It opens on which, each by name with its scope, and the text the agent sent.
 */
export const RecallEntry = memo(function RecallEntry({ sessionId, entryId }: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'recall')
  const animation = useEntryAnimation(sessionId, entryId)
  const [open, setOpen] = useState(false)
  if (!entry) return null
  const count = entry.memories.length
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={animation}>
      <Marker variant="separator" className="text-xs">
        <CollapsibleTrigger className="group/recall inline-flex h-7 flex-none items-center gap-1.5 rounded-full px-2.5 pr-2 outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-foreground focus-visible:bg-hover focus-visible:text-foreground">
          <MarkerIcon className="grid size-3.5 place-items-center">
            <HugeiconsIcon
              icon={AiBrain01Icon}
              strokeWidth={1.9}
              aria-hidden
              className="size-3.5"
            />
          </MarkerIcon>
          <MarkerContent>{t(`recall.${entry.action}`, { count })}</MarkerContent>
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={1.9}
            aria-hidden
            className="size-3 transition-transform duration-(--duration-fast) group-data-panel-open/recall:rotate-90"
          />
        </CollapsibleTrigger>
      </Marker>
      <CollapsibleContent className={PANEL}>
        <ul
          className="mx-px mt-1.5 mb-px grid gap-2 rounded-xl bg-card px-3.5 py-2.5 text-muted-foreground shadow-card"
          data-selectable=""
        >
          {entry.memories.map((memory) => (
            <li key={memory.path} className="grid min-w-0 gap-0.5">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-medium text-foreground" title={memory.path}>
                  {memoryName(memory, t('recall.summary'))}
                </span>
                <span className="flex-none text-[11px] text-tertiary">
                  {t(`recall.scope.${memory.scope}`)}
                </span>
              </div>
              {memory.content && (
                <Markdown markdown={memory.content} className="markdown-muted text-xs" />
              )}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
})
