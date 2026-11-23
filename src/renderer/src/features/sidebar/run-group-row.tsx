import { memo, useMemo } from 'react'
import { ArrowDown01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { SessionGroupRef } from '@shared/run-groups'
import { phaseCounts } from '@shared/run-groups'
import { Glyph } from '@renderer/features/shell/glyph'
import { GROUP_ICON } from '@renderer/features/groups/group-icon'
import { cn } from '@renderer/lib/utils'
import { groupExpanded, type SessionNode } from '@renderer/stores/sessions'
import { openGroup, useViewStore } from '@renderer/stores/view'
import { isReturning, rowVariants } from './row-exit'
import type { RowStatus } from './row-status'
import { RowEnd, SessionIndicator } from './session-indicator'
import { INDENT_PAD, ROW_PAD, SessionRow } from './session-row'

/**
 * Huli: a best-of-N group in its project, as a task's row: the caret, the group's mark, the
 * prompt's first line, how many runs are done and the loudest status of its runs. Its runs hang
 * under it as sub-sessions do; the row opens the group's page, where they are compared.
 */
export const RunGroupRow = memo(function RunGroupRow({
  group,
  runs,
  tabStopId,
  indent = false,
}: {
  group: SessionGroupRef
  runs: SessionNode[]
  tabStopId: string | null
  indent?: boolean
}) {
  const { t } = useTranslation('session')
  const current = useViewStore(
    (s) => !s.settings.open && s.main.kind === 'group' && s.main.groupId === group.id,
  )
  const expanded = useViewStore((s) => groupExpanded(s, { id: group.id, runs }))
  const setExpanded = (value: boolean) =>
    useViewStore.setState((s) => ({ expandedParents: { ...s.expandedParents, [group.id]: value } }))
  const variants = useMemo(() => rowVariants(group.id), [group.id])
  const counts = phaseCounts(runs.map((run) => run.summary))
  const status: RowStatus = {
    waiting: runs.reduce((n, run) => n + run.permissionCount, 0),
    failed: counts.failed > 0,
    running: runs.some((run) => run.running),
    starting: runs.some((run) => run.summary.status === 'starting'),
    unread: runs.some((run) => run.summary.attention === 'unread'),
  }
  const base = indent ? INDENT_PAD : ROW_PAD
  const kept = group.kept !== null

  return (
    <motion.li
      className="flex flex-col"
      variants={variants}
      initial={isReturning(group.id) ? 'hidden' : false}
      animate="shown"
      exit="exit"
    >
      <div className="ui-as-chat-row" data-indent={indent || undefined}>
        <button
          type="button"
          className="ui-as-side__item ui-as-chat-row__link"
          data-sidebar-row=""
          data-group-id={group.id}
          tabIndex={tabStopId === group.id ? 0 : -1}
          aria-current={current ? 'page' : undefined}
          aria-expanded={expanded}
          onClick={() => openGroup(group.id)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' && !expanded) {
              event.preventDefault()
              setExpanded(true)
            } else if (event.key === 'ArrowLeft' && expanded) {
              event.preventDefault()
              setExpanded(false)
            }
          }}
          style={{ paddingLeft: base }}
        >
          <span
            role="button"
            tabIndex={-1}
            aria-label={expanded ? t('group.row.collapse') : t('group.row.expand')}
            onClick={(event) => {
              event.stopPropagation()
              setExpanded(!expanded)
            }}
            className="-mr-1.5 -ml-4 grid size-3.5 shrink-0 place-items-center rounded-sm text-(--faint) hover:text-(--ink)"
          >
            <Glyph icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
          </span>
          <span className="ui-as-chat-row__logo relative">
            <Glyph icon={GROUP_ICON} size={14} />
          </span>
          <span className="ui-as-side__text" dir="auto">
            {group.title}
          </span>
          <span
            className={cn(
              'shrink-0 text-[12px] font-normal tabular-nums',
              kept ? 'text-success' : 'text-(--faint)',
            )}
            aria-label={
              kept
                ? t('group.row.kept')
                : t('group.row.doneOf', { done: counts.done, total: runs.length })
            }
          >
            {kept ? t('group.row.kept') : `${counts.done}/${runs.length}`}
          </span>
          <RowEnd>
            <SessionIndicator status={status} expiring={null} />
          </RowEnd>
        </button>
      </div>
      {expanded && (
        <ul className="flex flex-col">
          <AnimatePresence initial={false}>
            {runs.map((run, i) => (
              <SessionRow
                key={run.summary.id}
                node={run}
                tabStopId={tabStopId}
                indent={indent}
                branch={i === runs.length - 1 ? 'last' : 'middle'}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </motion.li>
  )
})
