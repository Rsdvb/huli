// Huli: the sidebar's two groups out of the active list (会话整理): 已推迟, the snoozed sessions,
// the soonest back first, open by default; and 已收起, the settled ones, the latest first, closed
// by default and showing its first few rows once opened.

import { useMemo, useState } from 'react'
import { ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useEntry } from '@renderer/lib/features'
import { Glyph } from '@renderer/features/shell/glyph'
import {
  byParked,
  hostOfSession,
  inParkedTree,
  keepSameNodes,
  parkedOpen,
  parkedTree,
  sidebarRows,
  useSessionsStore,
  type ParkedKind,
  type SessionNode,
  type SidebarTabStop,
} from '@renderer/stores/sessions'
import { isSessionInArchivedProject, useProjectsStore } from '@renderer/stores/projects'
import { SETTLED_GROUP, SNOOZED_GROUP, showAllRows, useViewStore } from '@renderer/stores/view'
import { GroupRenameHints } from './rename-hints'
import { RenameScope } from './rename-scope'
import { limitRows, rowInSight, ROWS_SHOWN } from './row-limit'
import { RunGroupRow } from './run-group-row'
import { SessionRow } from './session-row'

const KEY: Record<ParkedKind, string> = { snoozed: SNOOZED_GROUP, settled: SETTLED_GROUP }

function toggle(kind: ParkedKind): void {
  useViewStore.setState((s) => {
    if (kind === 'snoozed') {
      const collapsedProjects = { ...s.collapsedProjects }
      if (collapsedProjects[SNOOZED_GROUP]) delete collapsedProjects[SNOOZED_GROUP]
      else collapsedProjects[SNOOZED_GROUP] = true
      return { collapsedProjects }
    }
    const expandedParents = { ...s.expandedParents }
    if (expandedParents[SETTLED_GROUP]) delete expandedParents[SETTLED_GROUP]
    else expandedParents[SETTLED_GROUP] = true
    return { expandedParents }
  })
}

/** `next`, with the nodes of rows that did not change kept from before. */
function useKeptNodes(next: SessionNode[]): SessionNode[] {
  const [kept, setKept] = useState({ from: next, nodes: next })
  if (kept.from === next) return kept.nodes
  const nodes = keepSameNodes(kept.nodes, next)
  setKept({ from: next, nodes })
  return nodes
}

/** One parked group across the projects of the hosts shown; nothing while it holds no session. */
export function ParkedGroup({
  kind,
  stop,
  hosts,
}: {
  kind: ParkedKind
  stop: SidebarTabStop | null
  hosts?: readonly (string | null)[]
}) {
  const { t } = useTranslation('sidebar')
  const key = KEY[kind]
  const open = useViewStore((s) => parkedOpen(s, kind))
  const allShown = useViewStore((s) => !!s.allRowsShown[key])
  const shownId = useViewStore((s) => (s.main.kind === 'session' ? s.main.sessionId : null))
  const summaries = useSessionsStore(
    useShallow((s) => Object.values(s.byId).filter((x) => inParkedTree(s.byId, x, kind))),
  )
  const projects = useProjectsStore((s) => s.projects)
  const tree = useKeptNodes(
    useMemo(
      () =>
        parkedTree(Object.fromEntries(summaries.map((x) => [x.id, x])), kind).filter(
          (node) =>
            (!hosts || hosts.includes(hostOfSession(node.summary))) &&
            !isSessionInArchivedProject(node.summary, projects),
        ),
      [summaries, kind, hosts, projects],
    ),
  )
  const fold = useEntry('sidebar.runGroup')
  const rows = useMemo(() => sidebarRows(tree, [], byParked(kind), fold), [tree, kind, fold])
  if (rows.length === 0) return null
  const limited = limitRows(rows, allShown, (row) => rowInSight(row, shownId))
  const tabStopId = stop?.kind === 'session' ? stop.id : null
  const label = t(kind === 'snoozed' ? 'tidy.snoozedGroup' : 'tidy.settledGroup')
  return (
    <div className="ui-as-side__group" role="group" aria-label={label}>
      <button
        type="button"
        data-sidebar-row=""
        tabIndex={stop?.kind === 'group' && stop.key === key ? 0 : -1}
        aria-expanded={open}
        onClick={() => toggle(kind)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !open) toggle(kind)
          else if (event.key === 'ArrowLeft' && open) toggle(kind)
        }}
        className="ui-as-side__label kettu-side-label"
      >
        {label}
        <span className="ml-1.5 font-normal text-(--faint) tabular-nums">{rows.length}</span>
        <span className="kettu-side-label__arrow" aria-hidden>
          <Glyph icon={ArrowRight01Icon} size={12} />
        </span>
      </button>
      {open && (
        <ul className="flex flex-col">
          <RenameScope value={key}>
            <AnimatePresence initial={false}>
              {limited.rows.map((row) =>
                row.kind === 'session' ? (
                  <SessionRow
                    key={row.id}
                    node={row.node}
                    tabStopId={tabStopId}
                    showHost={!!hosts}
                  />
                ) : row.kind === 'group' ? (
                  <RunGroupRow
                    key={row.id}
                    group={row.group}
                    runs={row.runs}
                    tabStopId={tabStopId}
                  />
                ) : null,
              )}
            </AnimatePresence>
          </RenameScope>
          {(limited.hidden > 0 || allShown) && rows.length > ROWS_SHOWN && (
            <li className="flex">
              <button
                type="button"
                data-sidebar-row=""
                tabIndex={-1}
                onClick={() => showAllRows(key, !allShown)}
                className="ui-as-side__item kettu-side-more"
              >
                <span className="ui-as-side__text">
                  {allShown ? t('list.showLess') : t('list.showMore', { count: limited.hidden })}
                </span>
              </button>
            </li>
          )}
          <GroupRenameHints scope={key} />
        </ul>
      )}
    </div>
  )
}
