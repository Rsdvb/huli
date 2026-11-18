// Huli: choosing which of an agent's past sessions to import, across every folder it ran in, and
// the import's progress and outcome. Each chosen one goes through `sessions.import`, as the
// sidebar's Import sessions does it. Huli's own; see tools/huli/README.md.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight01Icon, Search01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import type { AgentHistoryPage, AgentHistorySession } from '@shared/agent-history'
import { harnessOf, type AgentId } from '@shared/agents'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Progress } from '@renderer/components/ui/progress'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { readiness } from '@renderer/features/agents/readiness'
import { MemoryImportDialog } from '@renderer/features/settings/memory-rows'
import { mediumAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import {
  eachLimited,
  groupsOf,
  matches,
  recentKeys,
  selectable,
  sessionKey,
  withKeys,
  type HistoryGroup,
  type HistoryList,
} from './model'

/** Imports at once: each reads the transcript's tail and writes the index. */
const IMPORTS = 3
/** Rows a folder shows before it asks for a search. */
const SHOWN_PER_FOLDER = 200
const RECENT_DAYS = 30

interface Outcome {
  imported: SessionSummary[]
  failed: { key: string; title: string; message: string }[]
  stopped: number
}

/** An agent's whole history to pick from; mounted with each opening, so it starts afresh. */
export function AgentHistoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(720px,88svh)] flex-col gap-0 p-0 sm:max-w-[640px]"
      >
        {open && <AgentHistoryBody onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

/** Claude Code is read from its files and Codex lists every folder; another agent must say it can. */
function listsEverywhere(agentId: AgentId, listSessions: boolean): boolean {
  const harness = harnessOf(agentId)
  return harness === 'claude-code' || harness === 'codex' || listSessions
}

function AgentHistoryBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['agentHistory', 'common'])
  const agents = useAgentsStore(
    useShallow((s) =>
      usableAgents(s.order, s.byId).filter(
        (a) =>
          !a.disabled &&
          readiness(a).kind !== 'missing' &&
          listsEverywhere(a.id, a.capabilities.listSessions),
      ),
    ),
  )
  const [lists, setLists] = useState<Record<string, HistoryList>>({})
  const [chosenAgent, setChosenAgent] = useState<AgentId | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; title: string | null }>({
    done: 0,
    total: 0,
    title: null,
  })
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const alive = useRef(true)
  const stopping = useRef(false)

  // Every agent's pages load one after another as the dialog opens, for the counts on its tab.
  useEffect(() => {
    alive.current = true
    // A listing of an earlier mount of this effect drops its pages.
    let live = true
    for (const agent of agents) {
      void (async () => {
        let cursor: string | null = null
        do {
          try {
            const page: AgentHistoryPage = await host('agentHistory.list', {
              agentId: agent.id,
              ...(cursor ? { cursor } : {}),
            })
            if (!live) return
            cursor = page.nextCursor
            const more = cursor !== null
            setLists((l) => {
              const before = l[agent.id]
              return {
                ...l,
                [agent.id]: {
                  sessions: [...(before?.sessions ?? []), ...page.sessions],
                  hidden: {
                    subagents: (before?.hidden.subagents ?? 0) + page.hidden.subagents,
                    empty: (before?.hidden.empty ?? 0) + page.hidden.empty,
                  },
                  loading: more,
                  error: null,
                },
              }
            })
          } catch (error) {
            if (!live) return
            setLists((l) => ({
              ...l,
              [agent.id]: {
                sessions: l[agent.id]?.sessions ?? [],
                hidden: l[agent.id]?.hidden ?? { subagents: 0, empty: 0 },
                loading: false,
                error: errorMessage(error),
              },
            }))
            return
          }
        } while (cursor !== null)
      })()
    }
    return () => {
      live = false
      alive.current = false
    }
    // The agents are read as the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // An ACP agent that cannot list without a folder is left out once it says so.
  const shownAgents = agents.filter((a) => {
    const harness = harnessOf(a.id)
    return harness === 'claude-code' || harness === 'codex' || !lists[a.id]?.error
  })
  const shown = shownAgents.find((a) => a.id === chosenAgent)?.id ?? shownAgents[0]?.id ?? null
  const list = shown ? lists[shown] : undefined
  const filtered = useMemo(
    () => (list ? list.sessions.filter((s) => matches(s, query.trim())) : []),
    [list, query],
  )
  const groups = useMemo(() => groupsOf(filtered), [filtered])
  const visibleKeys = shown
    ? filtered.filter(selectable).map((s) => sessionKey(shown, s.acpSessionId))
    : []
  const toImport = shownAgents.flatMap((agent) =>
    (lists[agent.id]?.sessions ?? [])
      .filter((s) => selectable(s) && selected.has(sessionKey(agent.id, s.acpSessionId)))
      .map((s) => ({ agentId: agent.id, session: s })),
  )

  const markImported = (agentId: AgentId, acpSessionId: string): void =>
    setLists((l) => {
      const current = l[agentId]
      if (!current) return l
      return {
        ...l,
        [agentId]: {
          ...current,
          sessions: current.sessions.map((s) =>
            s.acpSessionId === acpSessionId ? { ...s, imported: true } : s,
          ),
        },
      }
    })

  const run = async (): Promise<void> => {
    const items = toImport
    if (items.length === 0 || running) return
    stopping.current = false
    setRunning(true)
    setOutcome(null)
    let done = 0
    setProgress({ done, total: items.length, title: null })
    const result: Outcome = { imported: [], failed: [], stopped: 0 }
    await eachLimited(
      items,
      IMPORTS,
      () => alive.current && !stopping.current,
      async ({ agentId, session }) => {
        const key = sessionKey(agentId, session.acpSessionId)
        setProgress((p) => ({ ...p, title: session.title }))
        try {
          const summary = await host('sessions.import', {
            agentId,
            projectPath: session.cwd,
            acpSessionId: session.acpSessionId,
          })
          useSessionsStore.getState().upsert(summary)
          result.imported.push(summary)
          if (!alive.current) return
          markImported(agentId, session.acpSessionId)
          setSelected((s) => withKeys(s, [key], false))
        } catch (error) {
          result.failed.push({
            key,
            title: session.title ?? t('common:untitledSession'),
            message: errorMessage(error),
          })
        }
        done++
        if (alive.current) setProgress((p) => ({ ...p, done }))
      },
    )
    if (!alive.current) return
    result.stopped = items.length - done
    setOutcome(result)
    setRunning(false)
  }

  const latest = outcome?.imported.reduce<SessionSummary | null>(
    (best, s) => (!best || s.updatedAt > best.updatedAt ? s : best),
    null,
  )
  const alreadyHere = list?.sessions.filter((s) => s.imported).length ?? 0
  const statusParts = list
    ? [
        t('dialog.listed', { count: list.sessions.length }),
        t('dialog.projects', { count: groupsOf(list.sessions).length }),
        alreadyHere > 0 ? t('dialog.alreadyHere', { count: alreadyHere }) : null,
        list.hidden.subagents > 0
          ? t('dialog.hiddenSubagents', { count: list.hidden.subagents })
          : null,
        list.hidden.empty > 0 ? t('dialog.hiddenEmpty', { count: list.hidden.empty }) : null,
      ].filter(Boolean)
    : []

  return (
    <>
      <DialogHeader className="gap-1.5 px-5.5 pt-5">
        <DialogTitle>{t('dialog.title')}</DialogTitle>
        <DialogDescription>{t('dialog.description')}</DialogDescription>
      </DialogHeader>
      {shownAgents.length === 0 || !shown ? (
        <p className="flex-1 px-5.5 pt-3.5 text-ui text-secondary">{t('dialog.noAgents')}</p>
      ) : (
        <>
          <div className="flex flex-col gap-2.5 px-5.5 pt-3.5">
            <Tabs value={shown} onValueChange={(value: AgentId) => setChosenAgent(value)}>
              <TabsList
                aria-label={t('dialog.agents')}
                className="justify-start gap-1.5 rounded-none bg-transparent p-0 shadow-none group-data-horizontal/tabs:h-auto"
              >
                {shownAgents.map((agent) => {
                  const agentList = lists[agent.id]
                  return (
                    <TabsTrigger
                      key={agent.id}
                      value={agent.id}
                      className="h-7 flex-none gap-1.5 rounded-xl px-3 text-control font-medium text-secondary not-data-active:hover:bg-hover data-active:bg-subtle data-active:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-none dark:text-secondary"
                    >
                      <AgentMark agent={agent.id} size={14} />
                      {agent.name}
                      {agentList && !agentList.error && (
                        <span className="text-meta text-tertiary tabular">
                          {agentList.sessions.length}
                          {agentList.loading ? '…' : ''}
                        </span>
                      )}
                    </TabsTrigger>
                  )
                })}
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-tertiary">
                  <Icon icon={Search01Icon} size={14} />
                </span>
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('dialog.search')}
                  aria-label={t('dialog.search')}
                  className="pl-8"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={running || !list}
                onClick={() =>
                  setSelected((s) =>
                    withKeys(
                      withKeys(s, visibleKeys, false),
                      recentKeys(shown, filtered, RECENT_DAYS, Date.now()),
                      true,
                    ),
                  )
                }
              >
                {t('dialog.last30')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={running || !list}
                onClick={() => setSelected((s) => withKeys(s, visibleKeys, true))}
              >
                {t('dialog.all')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={running || !list}
                onClick={() => setSelected((s) => withKeys(s, visibleKeys, false))}
              >
                {t('dialog.none')}
              </Button>
            </div>
            {list && (
              <p className="truncate text-hint text-tertiary" title={statusParts.join('\n')}>
                {list.loading
                  ? t('dialog.listing', { count: list.sessions.length })
                  : statusParts.join(t('dialog.separator'))}
              </p>
            )}
          </div>
          <div className="mt-1.5 min-h-0 flex-1 overflow-y-auto px-5.5">
            {!list ? (
              <div className="flex flex-col">
                {[0.62, 0.48, 0.55, 0.4].map((width) => (
                  <div key={width} className="flex h-10 items-center gap-2.5 px-1">
                    <Skeleton className="size-4 rounded-sm" />
                    <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
                  </div>
                ))}
              </div>
            ) : list.error ? (
              <p className="py-2 text-ui text-danger">{list.error}</p>
            ) : list.sessions.length === 0 && !list.loading ? (
              <p className="py-2 text-ui text-secondary">
                {t('dialog.noSessions', {
                  agent: shownAgents.find((a) => a.id === shown)?.name ?? shown,
                })}
              </p>
            ) : groups.length === 0 && !list.loading ? (
              <p className="py-2 text-ui text-secondary">{t('dialog.noMatch')}</p>
            ) : (
              groups.map((group) => (
                <FolderList
                  key={group.key}
                  agentId={shown}
                  group={group}
                  open={query.trim() !== '' || expanded.has(group.key)}
                  selected={selected}
                  locked={running}
                  onToggle={() => setExpanded((e) => withKeys(e, [group.key], !e.has(group.key)))}
                  onSelect={(keys, on) => setSelected((s) => withKeys(s, keys, on))}
                />
              ))
            )}
          </div>
        </>
      )}
      <div className="flex flex-col gap-2 px-5.5 pt-3">
        {running && (
          <div className="flex flex-col gap-1.5" aria-live="polite">
            <span className="truncate text-hint text-secondary">
              {progress.title
                ? t('dialog.importingTitle', {
                    done: Math.min(progress.done + 1, progress.total),
                    total: progress.total,
                    title: progress.title,
                  })
                : t('dialog.importing', { done: progress.done, total: progress.total })}
            </span>
            <Progress value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0} />
          </div>
        )}
        {!running && outcome && (
          <OutcomeView
            outcome={outcome}
            onMemory={() => setMemoryOpen(true)}
            onOpenLatest={
              latest
                ? () => {
                    onClose()
                    openSession(latest.id, latest.projectPath)
                  }
                : null
            }
          />
        )}
        <p className="text-hint text-tertiary">{t('dialog.readOnly')}</p>
      </div>
      <div className="flex items-center gap-2 px-5.5 py-4.5">
        <span className="flex-1" />
        {running ? (
          <Button
            variant="outline"
            onClick={() => {
              stopping.current = true
            }}
          >
            {t('dialog.stop')}
          </Button>
        ) : (
          <Button variant="outline" onClick={onClose}>
            {outcome ? t('dialog.close') : t('common:actions.cancel')}
          </Button>
        )}
        <Button disabled={running || toImport.length === 0} onClick={() => void run()}>
          {running ? (
            <>
              <Spinner className="size-3.5" />
              {t('dialog.importNone')}
            </>
          ) : toImport.length > 0 ? (
            t('dialog.import', { count: toImport.length })
          ) : (
            t('dialog.importNone')
          )}
        </Button>
      </div>
      <MemoryImportDialog open={memoryOpen} onOpenChange={setMemoryOpen} />
    </>
  )
}

/** A folder's heading, which selects its sessions and shows or hides them, and its sessions. */
function FolderList({
  agentId,
  group,
  open,
  selected,
  locked,
  onToggle,
  onSelect,
}: {
  agentId: AgentId
  group: HistoryGroup
  open: boolean
  selected: ReadonlySet<string>
  locked: boolean
  onToggle: () => void
  onSelect: (keys: string[], on: boolean) => void
}) {
  const { t } = useTranslation('agentHistory')
  const keys = group.sessions.filter(selectable).map((s) => sessionKey(agentId, s.acpSessionId))
  const chosen = keys.filter((key) => selected.has(key)).length
  const on = keys.length > 0 && chosen === keys.length
  const missing = group.sessions.every((s) => s.missing)
  const rows = open ? group.sessions.slice(0, SHOWN_PER_FOLDER) : []
  return (
    <section aria-label={group.name} className="[content-visibility:auto]">
      <div className="flex h-9 items-center gap-2 border-b border-subtle px-1">
        <Checkbox
          checked={on}
          indeterminate={chosen > 0 && !on}
          disabled={locked || keys.length === 0}
          aria-label={t('dialog.toggleProject', { project: group.name })}
          className="data-disabled:opacity-40"
          onCheckedChange={(next) => onSelect(keys, next)}
        />
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
          aria-expanded={open}
          aria-label={open ? t('dialog.collapse') : t('dialog.expand')}
          title={group.path}
          onClick={onToggle}
        >
          <span
            className={cn(
              'flex-none text-tertiary transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
            aria-hidden
          >
            <Icon icon={ArrowRight01Icon} size={12} />
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-control font-medium',
              missing ? 'text-tertiary' : 'text-foreground',
            )}
          >
            {group.name}
            <span className="ml-1.5 font-normal text-tertiary">{group.path}</span>
          </span>
          {missing && <span className="text-meta text-tertiary">{t('dialog.missing')}</span>}
          <span className="text-meta text-tertiary tabular">
            {chosen > 0
              ? `${chosen}/${group.sessions.length}`
              : t('dialog.projectCount', { count: group.sessions.length })}
          </span>
        </button>
      </div>
      {rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((session) => (
            <SessionRow
              key={session.acpSessionId}
              agentId={agentId}
              session={session}
              checked={selected.has(sessionKey(agentId, session.acpSessionId))}
              locked={locked}
              onSelect={(next) => onSelect([sessionKey(agentId, session.acpSessionId)], next)}
            />
          ))}
          {group.sessions.length > rows.length && (
            <li className="py-2 pl-12 text-hint text-tertiary">
              {t('dialog.more', { count: group.sessions.length - rows.length })}
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

function SessionRow({
  agentId,
  session,
  checked,
  locked,
  onSelect,
}: {
  agentId: AgentId
  session: AgentHistorySession
  checked: boolean
  locked: boolean
  onSelect: (on: boolean) => void
}) {
  const { t } = useTranslation(['agentHistory', 'common'])
  const can = selectable(session)
  const meta = [
    session.imported ? t('dialog.imported') : session.missing ? t('dialog.missing') : null,
    session.updatedAt ? mediumAgo(session.updatedAt) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <li>
      <label
        className="flex h-10 items-center gap-2.5 border-b border-subtle pr-1 pl-7"
        title={session.missing && !session.imported ? t('dialog.missingTip') : undefined}
      >
        <Checkbox
          checked={session.imported || (can && checked)}
          disabled={!can || locked}
          className="data-disabled:opacity-40"
          onCheckedChange={onSelect}
        />
        <AgentMark agent={agentId} size={16} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13.5px]',
            can ? 'text-foreground' : 'text-secondary',
          )}
        >
          {session.title ?? t('common:untitledSession')}
        </span>
        <span className="text-meta whitespace-nowrap text-tertiary tabular">{meta}</span>
      </label>
    </li>
  )
}

/** What the import did: how many came over, how many a stop left, and which failed why. */
function OutcomeView({
  outcome,
  onMemory,
  onOpenLatest,
}: {
  outcome: Outcome
  onMemory: () => void
  onOpenLatest: (() => void) | null
}) {
  const { t } = useTranslation('agentHistory')
  const lines = [
    t('result.imported', { count: outcome.imported.length }),
    outcome.stopped > 0 ? t('result.stopped', { count: outcome.stopped }) : null,
  ].filter(Boolean)
  return (
    <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto text-hint" role="status">
      <p className="text-foreground">{lines.join(' ')}</p>
      {outcome.failed.length > 0 && (
        <>
          <p className="text-danger">{t('result.failed', { count: outcome.failed.length })}</p>
          <ul className="flex max-h-24 flex-col gap-0.5 overflow-y-auto text-danger">
            {outcome.failed.map((failure) => (
              <li key={failure.key} className="truncate" title={failure.message}>
                {t('result.failure', { title: failure.title, message: failure.message })}
              </li>
            ))}
          </ul>
        </>
      )}
      {outcome.imported.length > 0 && (
        <>
          <p className="text-tertiary">{t('result.memoryHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onMemory}>
              {t('result.memory')}
            </Button>
            {onOpenLatest && (
              <Button variant="ghost" size="sm" onClick={onOpenLatest}>
                {t('result.open')}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
