// Huli: choosing which of an agent's past sessions to import, across every folder it ran in, and
// the import's progress and outcome. Each chosen one goes through `sessions.import`, as the
// sidebar's Import sessions does it. One of another folder of the agent's kind, as a backup or a
// copy from another computer, is first copied into the agent's own folder once the user has seen
// the files that writes. Huli's own; see tools/huli/README.md.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Folder01Icon,
  Search01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import {
  CANNOT_LIST,
  type AgentHistoryPage,
  type AgentHistorySession,
  type HistoryCopyItem,
  type HistoryCopyOutcome,
  type HistoryCopyPlan,
} from '@shared/agent-history'
import { harnessOf, type AgentId } from '@shared/agents'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Input } from '@renderer/components/ui/input'
import { Progress } from '@renderer/components/ui/progress'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { readiness } from '@renderer/features/agents/readiness'
import { MemoryImportDialog } from '@renderer/features/settings/memory-rows'
import { mediumAgo } from '@renderer/lib/format'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openAgentSettings, openSession } from '@renderer/stores/view'
import {
  DESKTOP_TAB,
  desktopSourceKey,
  eachLimited,
  forgetFolder,
  groupsOf,
  matches,
  ofAgent,
  recentFolders,
  recentKeys,
  rememberFolder,
  selectable,
  sessionKey,
  sourceKey,
  withKeys,
  type HistoryGroup,
  type HistoryList,
} from './model'

/** Imports at once: each reads the transcript's tail and writes the index. */
const IMPORTS = 3
const TAB =
  'h-7 flex-none gap-1.5 rounded-xl px-3 text-control font-medium text-secondary not-data-active:hover:bg-hover data-active:bg-subtle data-active:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-none dark:text-secondary'
/** Rows a folder shows before it asks for a search. */
const SHOWN_PER_FOLDER = 200
const RECENT_DAYS = 30

interface Failure {
  key: string
  title: string
  message: string
  /** Huli: a terminal holds it, so a copy of it may be imported instead. */
  held?: Chosen
}

interface Outcome {
  imported: SessionSummary[]
  failed: Failure[]
  /** Huli: sessions of another folder that were not copied, and why. */
  skipped: Failure[]
  stopped: number
}

/** A chosen session, with the folder it is listed from; null for the agent's own. */
interface Chosen {
  agentId: AgentId
  folder: string | null
  key: string
  session: AgentHistorySession
  /** Huli: chosen in the Claude desktop app's tab, so it takes the app's title and archive. */
  desktop?: true
}

/** Huli: the Claude Code agent that imports the Claude desktop app's sessions, on this computer. */
function desktopAgentOf(agents: readonly { id: AgentId }[]): AgentId | null {
  if (isWeb) return null
  return agents.find((agent) => harnessOf(agent.id) === 'claude-code')?.id ?? null
}

/** Huli: the plans of the copies from other folders, which the user confirms. */
interface Confirming {
  plans: { agentId: AgentId; folder: string; plan: HistoryCopyPlan }[]
  chosen: Chosen[]
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

/**
 * Claude Code is read from its files and Codex lists every folder; another agent must say it can.
 * Huli: one not started at its version yet is asked, and left out once it says it cannot.
 */
function listsEverywhere(agent: AgentStatus): boolean {
  const harness = harnessOf(agent.id)
  return (
    harness === 'claude-code' ||
    harness === 'codex' ||
    agent.capabilities.listSessions ||
    agent.capabilitiesUnknown === true
  )
}

/** Huli: the agents whose sessions another folder of theirs can be read for. */
function readsFolders(agentId: AgentId): boolean {
  const harness = harnessOf(agentId)
  return !isWeb && (harness === 'claude-code' || harness === 'codex')
}

function AgentHistoryBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['agentHistory', 'common'])
  const agents = useAgentsStore(
    useShallow((s) =>
      usableAgents(s.order, s.byId).filter(
        (a) => !a.disabled && readiness(a).kind !== 'missing' && listsEverywhere(a),
      ),
    ),
  )
  const [lists, setLists] = useState<Record<string, HistoryList>>({})
  // An agent's id, or Huli: `DESKTOP_TAB`.
  const [chosenTab, setChosenTab] = useState<string | null>(null)
  // Huli: the other folder each agent's tab lists, when one is chosen.
  const [folders, setFolders] = useState<Partial<Record<AgentId, string>>>({})
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [running, setRunning] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [progress, setProgress] = useState<{
    done: number
    total: number
    title: string | null
    copying?: boolean
  }>({
    done: 0,
    total: 0,
    title: null,
  })
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  // Huli: Stop was pressed, and the imports under way are finishing.
  const [stopRequested, setStopRequested] = useState(false)
  // Huli: the failed import whose copy is being made.
  const [forking, setForking] = useState<string | null>(null)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const alive = useRef(true)
  const stopping = useRef(false)
  // The latest listing of each source; an earlier one drops its pages.
  const runs = useRef(new Map<string, number>())

  /**
   * Lists a source page after page. Huli: `from`, the page a listing failed at, goes on from it
   * with what was listed kept; without it the listing starts over.
   */
  const load = (
    agentId: AgentId,
    folder: string | null,
    desktop = false,
    from: string | null = null,
  ): void => {
    const key = desktop ? desktopSourceKey(agentId) : sourceKey(agentId, folder)
    const run = (runs.current.get(key) ?? 0) + 1
    runs.current.set(key, run)
    const live = () => alive.current && runs.current.get(key) === run
    setLists((l) => {
      const next = { ...l }
      const before = l[key]
      if (from === null) delete next[key]
      else if (before) next[key] = { ...before, loading: true, error: null, failedCursor: null }
      return next
    })
    void (async () => {
      let cursor: string | null = from
      let first = from === null
      do {
        try {
          const page: AgentHistoryPage = await host('agentHistory.list', {
            agentId,
            ...(cursor ? { cursor } : {}),
            ...(folder !== null ? { folder } : {}),
            ...(desktop ? { source: 'claude-desktop' as const } : {}),
          })
          if (!live()) return
          if (first && folder !== null) rememberFolder(harnessOf(agentId), folder)
          first = false
          cursor = page.nextCursor
          const more = cursor !== null
          setLists((l) => {
            const before = l[key]
            return {
              ...l,
              [key]: {
                sessions: [...(before?.sessions ?? []), ...page.sessions],
                hidden: {
                  subagents: (before?.hidden.subagents ?? 0) + page.hidden.subagents,
                  empty: (before?.hidden.empty ?? 0) + page.hidden.empty,
                },
                loading: more,
                error: null,
                ...(page.source !== undefined ? { source: page.source } : {}),
                ...(page.agentId !== undefined ? { agentId: page.agentId } : {}),
              },
            }
          })
        } catch (error) {
          if (!live()) return
          const failedAt = cursor
          const reason = (error as { data?: { reason?: unknown } } | null)?.data?.reason
          setLists((l) => ({
            ...l,
            [key]: {
              ...l[key],
              sessions: l[key]?.sessions ?? [],
              hidden: l[key]?.hidden ?? { subagents: 0, empty: 0 },
              loading: false,
              error: errorMessage(error),
              signIn: errorCode(error) === 'auth_required',
              failedCursor: failedAt,
              cannotList: reason === CANNOT_LIST,
            },
          }))
          return
        }
      } while (cursor !== null)
    })()
  }

  // Every agent's pages load one after another as the dialog opens, for the counts on its tab.
  useEffect(() => {
    alive.current = true
    for (const agent of agents) load(agent.id, null)
    // Huli: the Claude desktop app's sessions, whose tab shows once some are found.
    const desktopAgent = desktopAgentOf(agents)
    if (desktopAgent) load(desktopAgent, null, true)
    return () => {
      alive.current = false
    }
    // The agents are read as the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // An agent that cannot list its sessions everywhere is left out once it says so, as one not
  // started at its version yet may; Huli: one whose listing failed otherwise keeps its tab, with
  // the error, a retry and its sign-in.
  const shownAgents = agents.filter((a) => !lists[a.id]?.cannotList)
  // Huli: the Claude desktop app's tab, while its listing holds a session. It is asked of the
  // first Claude Code agent and imported by the one whose folder holds its transcripts.
  const desktopAsked = desktopAgentOf(agents)
  const desktopList = desktopAsked ? lists[desktopSourceKey(desktopAsked)] : undefined
  const desktopAgent = desktopList?.agentId ?? desktopAsked
  const desktopShown = !!desktopList && !desktopList.error && desktopList.sessions.length > 0
  const onDesktop = desktopShown && chosenTab === DESKTOP_TAB
  const shown = onDesktop
    ? desktopAgent
    : (shownAgents.find((a) => a.id === chosenTab)?.id ?? shownAgents[0]?.id ?? null)
  const shownName = onDesktop
    ? t('desktop.tab')
    : (shownAgents.find((a) => a.id === shown)?.name ?? shown ?? '')
  const folder = shown && !onDesktop ? (folders[shown] ?? null) : null
  const source = shown
    ? onDesktop && desktopAsked
      ? desktopSourceKey(desktopAsked)
      : sourceKey(shown, folder)
    : null
  const list = source ? lists[source] : undefined
  const filtered = useMemo(
    () => (list ? list.sessions.filter((s) => matches(s, query.trim())) : []),
    [list, query],
  )
  const scratchName = t('desktop.scratch')
  const scratchPath = t('desktop.scratchPath')
  const groups = useMemo(
    () =>
      onDesktop ? groupsOf(filtered, { name: scratchName, path: scratchPath }) : groupsOf(filtered),
    [filtered, onDesktop, scratchName, scratchPath],
  )
  const visibleKeys = source
    ? filtered.filter(selectable).map((s) => sessionKey(source, s.acpSessionId))
    : []
  const fromAgents: Chosen[] = shownAgents.flatMap((agent) =>
    [null, folders[agent.id] ?? null]
      .filter((from, index) => index === 0 || from !== null)
      .flatMap((from) => {
        const key = sourceKey(agent.id, from)
        return (lists[key]?.sessions ?? [])
          .filter((s) => selectable(s) && selected.has(sessionKey(key, s.acpSessionId)))
          .map((s) => ({
            agentId: agent.id,
            folder: from,
            key: sessionKey(key, s.acpSessionId),
            session: s,
          }))
      }),
  )
  // Huli: the desktop app's chosen ones first, so one chosen in both tabs comes in with its title.
  const fromDesktop: Chosen[] =
    desktopAsked && desktopAgent && desktopShown
      ? desktopList.sessions
          .filter(
            (s) =>
              selectable(s) &&
              selected.has(sessionKey(desktopSourceKey(desktopAsked), s.acpSessionId)),
          )
          .map((s) => ({
            agentId: desktopAgent,
            folder: null,
            key: sessionKey(desktopSourceKey(desktopAsked), s.acpSessionId),
            session: s,
            desktop: true as const,
          }))
      : []
  const toImport: Chosen[] = [...fromDesktop, ...fromAgents].filter(
    (item, index, all) =>
      all.findIndex(
        (other) =>
          other.agentId === item.agentId &&
          other.session.acpSessionId === item.session.acpSessionId,
      ) === index,
  )

  // Huli: the shown tab's listing again, from the start or from the page that failed.
  const reload = (from: string | null): void => {
    if (!shown) return
    if (onDesktop && desktopAsked) load(desktopAsked, null, true, from)
    else load(shown, folder, false, from)
  }

  const chooseFolder = async (agentId: AgentId, picked?: string): Promise<void> => {
    const chosen = picked ?? (await window.kettu.dialogs.chooseHistoryFolder())
    if (!chosen || !alive.current) return
    setFolders((f) => ({ ...f, [agentId]: chosen }))
    setExpanded(new Set())
    load(agentId, chosen)
  }

  // In every listing of the agent: its own, another folder's and Huli: the desktop app's.
  const markImported = (agentId: AgentId, acpSessionId: string): void =>
    setLists((l) => {
      const next = { ...l }
      for (const [key, current] of Object.entries(l)) {
        if (!ofAgent(key, agentId) && current.agentId !== agentId) continue
        next[key] = {
          ...current,
          sessions: current.sessions.map((s) =>
            s.acpSessionId === acpSessionId ? { ...s, imported: true, outside: undefined } : s,
          ),
        }
      }
      return next
    })

  const runImports = async (items: Chosen[], before: Pick<Outcome, 'failed' | 'skipped'>) => {
    let done = 0
    setProgress({ done, total: items.length, title: null })
    const result: Outcome = {
      imported: [],
      failed: [...before.failed],
      skipped: before.skipped,
      stopped: 0,
    }
    await eachLimited(
      items,
      IMPORTS,
      () => alive.current && !stopping.current,
      async (item) => {
        const { agentId, key, session } = item
        setProgress((p) => ({ ...p, title: session.title }))
        try {
          const summary = await host('sessions.import', {
            agentId,
            projectPath: session.cwd,
            acpSessionId: session.acpSessionId,
            // Huli: a fork another folder carried on comes in as a copy of its own.
            ...(session.imported && session.outside === 'fork' ? { fork: true } : {}),
            ...(item.desktop ? { source: 'claude-desktop' as const } : {}),
          })
          useSessionsStore.getState().upsert(summary)
          result.imported.push(summary)
          if (!alive.current) return
          markImported(agentId, session.acpSessionId)
          setSelected((s) => withKeys(s, [key], false))
        } catch (error) {
          const reason = (error as { data?: { reason?: unknown } } | null)?.data?.reason
          result.failed.push({
            key,
            title: session.title ?? t('common:untitledSession'),
            message: errorMessage(error),
            ...(reason === 'held' ? { held: item } : {}),
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

  // Huli: one a terminal holds comes in as a copy of its own, as the sidebar's import offers.
  const forkHeld = async (failure: Failure): Promise<void> => {
    const item = failure.held
    if (!item || forking) return
    setForking(failure.key)
    try {
      const summary = await host('sessions.import', {
        agentId: item.agentId,
        projectPath: item.session.cwd,
        acpSessionId: item.session.acpSessionId,
        fork: true,
        ...(item.desktop ? { source: 'claude-desktop' as const } : {}),
      })
      useSessionsStore.getState().upsert(summary)
      if (!alive.current) return
      setSelected((s) => withKeys(s, [item.key], false))
      setOutcome(
        (o) =>
          o && {
            ...o,
            imported: [...o.imported, summary],
            failed: o.failed.filter((f) => f.key !== failure.key),
          },
      )
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      if (alive.current) setForking(null)
    }
  }

  const start = async (): Promise<void> => {
    const items = toImport
    if (items.length === 0 || running || planning) return
    stopping.current = false
    setStopRequested(false)
    setOutcome(null)
    const fromFolders = items.filter((item) => item.folder !== null)
    if (fromFolders.length === 0) {
      setRunning(true)
      await runImports(items, { failed: [], skipped: [] })
      return
    }
    // Huli: what the copies from other folders write is shown before any of it is.
    setPlanning(true)
    try {
      const bySource = new Map<string, Chosen[]>()
      for (const item of fromFolders) {
        const key = sourceKey(item.agentId, item.folder)
        bySource.set(key, [...(bySource.get(key) ?? []), item])
      }
      const plans: Confirming['plans'] = []
      for (const group of bySource.values()) {
        const { agentId, folder: from } = group[0]!
        const plan = await host('agentHistory.planCopy', {
          agentId,
          folder: from!,
          sessionIds: group.map((item) => item.session.acpSessionId),
        })
        plans.push({ agentId, folder: from!, plan })
      }
      if (alive.current) setConfirming({ plans, chosen: items })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      if (alive.current) setPlanning(false)
    }
  }

  const agentName = (agentId: AgentId): string =>
    agents.find((a) => a.id === agentId)?.name ?? agentId

  const confirmCopy = async (): Promise<void> => {
    const current = confirming
    if (!current || running) return
    setConfirming(null)
    setRunning(true)
    setProgress({ done: 0, total: 0, title: null, copying: true })
    const failed: Failure[] = []
    const skipped: Failure[] = []
    const ready = new Set<string>()
    const titleOf = (key: string): string =>
      current.chosen.find((item) => item.key === key)?.session.title ?? t('common:untitledSession')
    for (const { agentId, folder: from, plan } of current.plans) {
      const source = sourceKey(agentId, from)
      const action = new Map(plan.items.map((item) => [item.acpSessionId, item.action]))
      let outcomes: HistoryCopyOutcome[]
      try {
        outcomes = (await host('agentHistory.copy', { token: plan.token })).items
      } catch (error) {
        for (const item of plan.items) {
          const key = sessionKey(source, item.acpSessionId)
          failed.push({ key, title: titleOf(key), message: errorMessage(error) })
        }
        continue
      }
      for (const item of outcomes) {
        const key = sessionKey(source, item.acpSessionId)
        if (item.status === 'copied' || item.status === 'present') ready.add(key)
        else if (item.status === 'failed') {
          failed.push({ key, title: titleOf(key), message: item.message ?? '' })
        } else {
          const why = action.get(item.acpSessionId)
          const agent = agentName(agentId)
          skipped.push({
            key,
            title: titleOf(key),
            message:
              why === 'missing'
                ? t('result.missingFolder')
                : item.message === 'changed'
                  ? t('result.changed', { agent })
                  : t('result.conflict', { agent }),
          })
        }
      }
    }
    if (!alive.current) return
    await runImports(
      current.chosen.filter((item) => item.folder === null || ready.has(item.key)),
      { failed, skipped },
    )
  }

  const latest = outcome?.imported.reduce<SessionSummary | null>(
    (best, s) => (!best || s.updatedAt > best.updatedAt ? s : best),
    null,
  )
  const alreadyHere = list?.sessions.filter((s) => s.imported).length ?? 0
  const archived = list?.sessions.filter((s) => s.archived).length ?? 0
  const unavailable = list?.sessions.filter((s) => s.unavailable).length ?? 0
  const statusParts = list
    ? [
        t('dialog.listed', { count: list.sessions.length }),
        t('dialog.projects', {
          count: (onDesktop
            ? groupsOf(list.sessions, { name: scratchName, path: scratchPath })
            : groupsOf(list.sessions)
          ).length,
        }),
        alreadyHere > 0 ? t('dialog.alreadyHere', { count: alreadyHere }) : null,
        archived > 0 ? t('desktop.archivedCount', { count: archived }) : null,
        unavailable > 0 ? t('desktop.unavailableCount', { count: unavailable }) : null,
        list.hidden.subagents > 0
          ? t('dialog.hiddenSubagents', { count: list.hidden.subagents })
          : null,
        list.hidden.empty > 0 ? t('dialog.hiddenEmpty', { count: list.hidden.empty }) : null,
      ].filter(Boolean)
    : []
  const statusTip = [
    ...statusParts,
    ...(onDesktop && list?.source ? [t('dialog.readFrom', { folder: list.source })] : []),
  ].join('\n')
  const busy = running || planning
  const copyCount = confirming
    ? confirming.chosen.filter(
        (item) =>
          item.folder === null ||
          confirming.plans.some(
            (p) =>
              p.agentId === item.agentId &&
              p.folder === item.folder &&
              p.plan.items.some(
                (i) =>
                  i.acpSessionId === item.session.acpSessionId &&
                  i.action !== 'conflict' &&
                  i.action !== 'missing',
              ),
          ),
      ).length
    : 0

  return (
    <>
      <DialogHeader className="gap-1.5 px-5.5 pt-5">
        <DialogTitle>
          {confirming
            ? new Set(confirming.plans.map((p) => p.agentId)).size === 1
              ? t('confirm.title', { agent: agentName(confirming.plans[0]!.agentId) })
              : t('confirm.titleMany')
            : t('dialog.title')}
        </DialogTitle>
        <DialogDescription>
          {confirming
            ? t('confirm.description', {
                target: [...new Set(confirming.plans.map((p) => p.plan.target))].join(', '),
              })
            : t('dialog.description')}
        </DialogDescription>
      </DialogHeader>
      {confirming ? (
        <CopyPlanView confirming={confirming} agentName={agentName} />
      ) : shownAgents.length === 0 || !shown || !source ? (
        <p className="flex-1 px-5.5 pt-3.5 text-ui text-secondary">{t('dialog.noAgents')}</p>
      ) : (
        <>
          <div className="flex flex-col gap-2.5 px-5.5 pt-3.5">
            <Tabs
              value={onDesktop ? DESKTOP_TAB : shown}
              onValueChange={(value: string) => setChosenTab(value)}
            >
              <TabsList
                aria-label={t('dialog.agents')}
                className="justify-start gap-1.5 rounded-none bg-transparent p-0 shadow-none group-data-horizontal/tabs:h-auto"
              >
                {shownAgents.map((agent) => {
                  const agentList = lists[sourceKey(agent.id, folders[agent.id] ?? null)]
                  return (
                    <TabsTrigger key={agent.id} value={agent.id} className={TAB}>
                      <AgentMark agent={agent.id} size={14} />
                      {agent.name}
                      {agentList && !agentList.error && (
                        <span className="text-meta text-tertiary tabular">
                          {agentList.sessions.length}
                          {agentList.loading ? '…' : ''}
                        </span>
                      )}
                      {agentList?.error && (
                        <HugeiconsIcon
                          icon={Alert02Icon}
                          strokeWidth={1.9}
                          aria-label={t('dialog.listFailedShort')}
                          className="size-3.5 text-danger"
                        />
                      )}
                    </TabsTrigger>
                  )
                })}
                {desktopAgent && desktopShown && (
                  <TabsTrigger value={DESKTOP_TAB} className={TAB} title={t('desktop.tabTip')}>
                    <AgentMark agent={desktopAgent} size={14} />
                    {t('desktop.tab')}
                    <span className="text-meta text-tertiary tabular">
                      {desktopList.sessions.length}
                    </span>
                  </TabsTrigger>
                )}
              </TabsList>
            </Tabs>
            {!onDesktop && readsFolders(shown) && (
              <SourceRow
                agentId={shown}
                agentName={shownName}
                folder={folder}
                readFrom={list?.source ?? null}
                locked={busy}
                onChoose={(picked) => void chooseFolder(shown, picked)}
                onOwn={() => {
                  setFolders((f) => {
                    const next = { ...f }
                    delete next[shown]
                    return next
                  })
                  setExpanded(new Set())
                }}
              />
            )}
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
                disabled={busy || !list}
                onClick={() =>
                  setSelected((s) =>
                    withKeys(
                      withKeys(s, visibleKeys, false),
                      recentKeys(source, filtered, RECENT_DAYS, Date.now()),
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
                disabled={busy || !list}
                onClick={() => setSelected((s) => withKeys(s, visibleKeys, true))}
              >
                {t('dialog.all')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !list}
                onClick={() => setSelected((s) => withKeys(s, visibleKeys, false))}
              >
                {t('dialog.none')}
              </Button>
            </div>
            {list && (!list.error || list.sessions.length > 0) && (
              <p className="truncate text-hint text-tertiary" title={statusTip}>
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
            ) : list.error && list.sessions.length === 0 ? (
              <ListError
                agentName={shownName}
                list={list}
                onRetry={() => reload(null)}
                onSignIn={
                  list.signIn && !onDesktop
                    ? () => {
                        onClose()
                        openAgentSettings(shown)
                      }
                    : null
                }
              />
            ) : list.sessions.length === 0 && !list.loading ? (
              <p className="py-2 text-ui text-secondary">
                {folder !== null
                  ? t('dialog.noFolderSessions')
                  : t('dialog.noSessions', { agent: shownName })}
              </p>
            ) : groups.length === 0 && !list.loading ? (
              <p className="py-2 text-ui text-secondary">{t('dialog.noMatch')}</p>
            ) : (
              <>
                {groups.map((group) => (
                  <FolderList
                    key={group.key}
                    agentId={shown}
                    source={source}
                    group={group}
                    open={query.trim() !== '' || expanded.has(group.key)}
                    selected={selected}
                    locked={busy}
                    onToggle={() => setExpanded((e) => withKeys(e, [group.key], !e.has(group.key)))}
                    onSelect={(keys, on) => setSelected((s) => withKeys(s, keys, on))}
                  />
                ))}
                {list.error && (
                  // Huli: a later page that failed keeps the ones listed, and goes on from it.
                  <div className="flex items-center gap-2 py-2.5" role="alert">
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      strokeWidth={1.9}
                      aria-hidden
                      className="size-3.5 flex-none text-danger"
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-hint text-danger"
                      title={list.error}
                    >
                      {t('dialog.moreFailed', { message: list.error })}
                    </span>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => reload(list.failedCursor ?? null)}
                    >
                      {t('common:actions.retry')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
      <div className="flex flex-col gap-2 px-5.5 pt-3">
        {running && (
          <div className="flex flex-col gap-1.5" aria-live="polite">
            <span className="truncate text-hint text-secondary">
              {progress.copying
                ? t('dialog.copying')
                : progress.title
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
        {!running && outcome && !confirming && (
          <OutcomeView
            outcome={outcome}
            forking={forking}
            onFork={(failure) => void forkHeld(failure)}
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
        {!confirming && (
          <p className="text-hint text-tertiary">
            {onDesktop
              ? t('desktop.note')
              : folder !== null
                ? t('dialog.folderNote', { agent: shownName })
                : shown && harnessOf(shown) === 'claude-code'
                  ? `${t('dialog.readOnly')}${t('dialog.readOnlyHeld')}`
                  : t('dialog.readOnly')}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 px-5.5 py-4.5">
        <span className="flex-1" />
        {confirming ? (
          <>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              {t('confirm.back')}
            </Button>
            <Button disabled={copyCount === 0} onClick={() => void confirmCopy()}>
              {t('confirm.run', { count: copyCount })}
            </Button>
          </>
        ) : (
          <>
            {running ? (
              <Button
                variant="outline"
                disabled={stopRequested}
                onClick={() => {
                  stopping.current = true
                  setStopRequested(true)
                }}
              >
                {stopRequested ? (
                  <>
                    <Spinner className="size-3.5" />
                    {t('dialog.stopping')}
                  </>
                ) : (
                  t('dialog.stop')
                )}
              </Button>
            ) : (
              <Button variant="outline" onClick={onClose}>
                {outcome ? t('dialog.close') : t('common:actions.cancel')}
              </Button>
            )}
            <Button disabled={busy || toImport.length === 0} onClick={() => void start()}>
              {busy ? (
                <>
                  <Spinner className="size-3.5" />
                  {planning ? t('dialog.planning') : t('dialog.importNone')}
                </>
              ) : toImport.length > 0 ? (
                t('dialog.import', { count: toImport.length })
              ) : (
                t('dialog.importNone')
              )}
            </Button>
          </>
        )}
      </div>
      <MemoryImportDialog open={memoryOpen} onOpenChange={setMemoryOpen} />
    </>
  )
}

/**
 * Huli: where the tab's sessions come from, the agent's own folder or another one, with the
 * folders chosen last to go back to.
 */
function SourceRow({
  agentId,
  agentName,
  folder,
  readFrom,
  locked,
  onChoose,
  onOwn,
}: {
  agentId: AgentId
  agentName: string
  folder: string | null
  readFrom: string | null
  locked: boolean
  onChoose: (folder?: string) => void
  onOwn: () => void
}) {
  const { t } = useTranslation('agentHistory')
  const harness = harnessOf(agentId)
  // Read on each render: a folder listed for the first time joins them.
  const [, forgotten] = useState(0)
  const recent = recentFolders(harness)
  const others = recent.filter((item) => item !== folder)
  const label = folder === null ? t('dialog.ownFolder', { agent: agentName }) : shortFolder(folder)
  return (
    <div className="flex h-8 min-w-0 items-center gap-2 rounded-lg bg-subtle px-2.5">
      <span className="flex-none text-hint text-tertiary">{t('dialog.source')}</span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-hint',
          folder !== null ? 'text-foreground' : 'text-secondary',
        )}
        title={readFrom ? t('dialog.readFrom', { folder: readFrom }) : (folder ?? label)}
      >
        {label}
      </span>
      {folder !== null && (
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={locked}
          aria-label={t('dialog.backToOwn', { agent: agentName })}
          title={t('dialog.backToOwn', { agent: agentName })}
          onClick={onOwn}
        >
          <Icon icon={Cancel01Icon} size={12} />
        </Button>
      )}
      {others.length === 0 && folder === null ? (
        <Button variant="ghost" size="xs" disabled={locked} onClick={() => onChoose()}>
          <Icon icon={Folder01Icon} size={13} />
          {t('dialog.chooseFolder')}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={locked}
            render={
              <Button variant="ghost" size="xs">
                <Icon icon={Folder01Icon} size={13} />
                {t('dialog.chooseFolder')}
                <Icon icon={ArrowDown01Icon} size={11} />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-80 max-w-(--available-width)">
            {others.length > 0 && (
              <>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('dialog.recentFolders')}</DropdownMenuLabel>
                  {others.map((item) => (
                    <DropdownMenuItem key={item} title={item} onClick={() => onChoose(item)}>
                      <Icon icon={Folder01Icon} size={14} />
                      <span className="min-w-0 flex-1 truncate text-hint">{shortFolder(item)}</span>
                      <button
                        type="button"
                        className="flex-none rounded-sm text-tertiary hover:text-foreground"
                        aria-label={t('dialog.forgetFolder')}
                        title={t('dialog.forgetFolder')}
                        onClick={(event) => {
                          event.stopPropagation()
                          forgetFolder(harness, item)
                          forgotten((n) => n + 1)
                        }}
                      >
                        <Icon icon={Cancel01Icon} size={11} />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={() => onChoose()}>
              <Icon icon={Folder01Icon} size={14} />
              {t('dialog.chooseFolder')}
            </DropdownMenuItem>
            {folder !== null && (
              <DropdownMenuItem onClick={onOwn}>
                {t('dialog.backToOwn', { agent: agentName })}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

/** A folder by its last steps, which tell one from another, the rest elided. */
function shortFolder(folder: string): string {
  const parts = folder.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 3) return folder
  const separator = folder.includes('\\') ? '\\' : '/'
  return `…${separator}${parts.slice(-3).join(separator)}`
}

/** Huli: the files the copies from other folders write, each session's under its title. */
function CopyPlanView({
  confirming,
  agentName,
}: {
  confirming: Confirming
  agentName: (agentId: AgentId) => string
}) {
  const { t } = useTranslation(['agentHistory', 'common'])
  const total = confirming.plans.reduce(
    (sum, { plan }) =>
      sum + plan.items.reduce((n, item) => n + item.files.length + item.moreFiles, 0),
    0,
  )
  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2 px-5.5">
      <p className="text-hint text-secondary">{t('confirm.total', { count: total })}</p>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-subtle">
        {confirming.plans.map(({ agentId, folder, plan }) => (
          <section key={`${agentId}\n${folder}`} aria-label={folder}>
            {plan.items.map((item) => (
              <PlanItem
                key={item.acpSessionId}
                agentId={agentId}
                agent={agentName(agentId)}
                target={plan.target}
                item={item}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

function relativeTo(target: string, file: string): string {
  return file.startsWith(target) ? file.slice(target.length).replace(/^[\\/]/, '') : file
}

/**
 * The folder a session's files go in, the one holding its transcript or rollout, so the list
 * names each file by what tells it apart rather than by the long project folder they share.
 */
function planFolder(item: HistoryCopyItem): string | null {
  const first = item.files[0] ?? item.backup
  if (!first) return null
  const parts = first.split(/[\\/]/)
  const at = parts.findIndex(
    (part) => part.startsWith(item.acpSessionId) || part.startsWith('rollout-'),
  )
  if (at <= 0) return null
  return first.slice(0, parts.slice(0, at).join('/').length)
}

function PlanItem({
  agentId,
  agent,
  target,
  item,
}: {
  agentId: AgentId
  agent: string
  target: string
  item: HistoryCopyItem
}) {
  const { t } = useTranslation(['agentHistory', 'common'])
  const left = item.action === 'conflict' || item.action === 'missing'
  const folder = planFolder(item)
  const name = (file: string) => (folder ? relativeTo(folder, file) : relativeTo(target, file))
  return (
    <div className="flex flex-col gap-1 border-b border-subtle px-3 py-2.5 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <AgentMark agent={agentId} size={14} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-control font-medium',
            left ? 'text-tertiary' : 'text-foreground',
          )}
          title={item.cwd}
        >
          {item.title ?? t('common:untitledSession')}
        </span>
        <span
          className={cn(
            'flex-none text-meta',
            item.action === 'newer' ? 'text-warning' : left ? 'text-tertiary' : 'text-secondary',
          )}
        >
          {t(`confirm.action.${item.action}`, { agent })}
        </span>
      </div>
      {folder && (item.files.length > 0 || item.backup) && (
        <p className="truncate pl-5.5 text-meta text-tertiary" title={folder}>
          {relativeTo(target, folder)}
        </p>
      )}
      {item.files.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pl-8 font-mono text-meta text-secondary">
          {item.files.map((file) => (
            <li key={file} className="truncate" title={file}>
              {name(file)}
            </li>
          ))}
          {item.moreFiles > 0 && (
            <li className="text-tertiary">{t('confirm.more', { count: item.moreFiles })}</li>
          )}
        </ul>
      ) : (
        !left && <p className="pl-5.5 text-meta text-tertiary">{t('confirm.nothing', { agent })}</p>
      )}
      {item.backup && (
        <p className="truncate pl-8 text-meta text-tertiary" title={item.backup}>
          {t('confirm.backup', { file: name(item.backup) })}
        </p>
      )}
    </div>
  )
}

/** A folder's heading, which selects its sessions and shows or hides them, and its sessions. */
function FolderList({
  agentId,
  source,
  group,
  open,
  selected,
  locked,
  onToggle,
  onSelect,
}: {
  agentId: AgentId
  /** The listing's `sourceKey`, which the selection's keys start with. */
  source: string
  group: HistoryGroup
  open: boolean
  selected: ReadonlySet<string>
  locked: boolean
  onToggle: () => void
  onSelect: (keys: string[], on: boolean) => void
}) {
  const { t } = useTranslation('agentHistory')
  const keys = group.sessions.filter(selectable).map((s) => sessionKey(source, s.acpSessionId))
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
              checked={selected.has(sessionKey(source, session.acpSessionId))}
              locked={locked}
              onSelect={(next) => onSelect([sessionKey(source, session.acpSessionId)], next)}
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
  // Huli: an imported session another folder carried on is brought in again by its import.
  const [sync, setSync] = useState<'idle' | 'running' | 'done'>('idle')
  const newer = session.imported && session.outside === 'newer' && sync !== 'done'
  const runSync = async (): Promise<void> => {
    setSync('running')
    try {
      const summary = await host('sessions.import', {
        agentId,
        projectPath: session.cwd,
        acpSessionId: session.acpSessionId,
      })
      useSessionsStore.getState().upsert(summary)
      setSync('done')
    } catch (error) {
      setSync('idle')
      toast(errorMessage(error), undefined, { tone: 'warning' })
    }
  }
  const meta = [
    session.imported
      ? t('dialog.imported')
      : session.unavailable
        ? t('desktop.unavailable')
        : session.missing
          ? t('dialog.missing')
          : null,
    session.archived ? t('desktop.archived') : null,
    newer ? t('dialog.newer') : session.outside === 'fork' ? t('dialog.fork') : null,
    session.updatedAt ? mediumAgo(session.updatedAt) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const tip = session.imported
    ? undefined
    : session.unavailable
      ? t('desktop.unavailableTip')
      : session.missing
        ? t('dialog.missingTip')
        : session.archived
          ? t('desktop.archivedTip')
          : undefined
  return (
    <li>
      <label
        className="flex h-10 items-center gap-2.5 border-b border-subtle pr-1 pl-7"
        title={tip}
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
        {newer && (
          <Button
            variant="outline"
            size="xs"
            disabled={locked || sync === 'running'}
            onClick={(event) => {
              event.preventDefault()
              void runSync()
            }}
          >
            {t('dialog.sync')}
          </Button>
        )}
      </label>
    </li>
  )
}

/**
 * Huli: an agent's listing that failed: its tab stays, with the agent's own words, a retry and,
 * for one that asks for it, its sign-in.
 */
function ListError({
  agentName,
  list,
  onRetry,
  onSignIn,
}: {
  agentName: string
  list: HistoryList
  onRetry: () => void
  onSignIn: (() => void) | null
}) {
  const { t } = useTranslation(['agentHistory', 'common'])
  return (
    <div className="flex flex-col items-start gap-2 py-3" role="alert">
      <p className="flex items-center gap-1.5 text-ui font-medium text-foreground">
        <HugeiconsIcon
          icon={Alert02Icon}
          strokeWidth={1.9}
          aria-hidden
          className="size-4 text-danger"
        />
        {t(list.signIn ? 'dialog.listSignIn' : 'dialog.listFailed', { agent: agentName })}
      </p>
      <p className="max-w-full text-hint break-words text-secondary">{list.error}</p>
      <div className="flex items-center gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('common:actions.retry')}
        </Button>
        {onSignIn && (
          <Button size="sm" onClick={onSignIn}>
            {t('dialog.signIn')}
          </Button>
        )}
      </div>
    </div>
  )
}

/** What the import did: how many came over, how many a stop left, and which failed why. */
function OutcomeView({
  outcome,
  forking,
  onFork,
  onMemory,
  onOpenLatest,
}: {
  outcome: Outcome
  /** Huli: the failure whose copy is being made. */
  forking: string | null
  onFork: (failure: Failure) => void
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
      {outcome.skipped.length > 0 && (
        <>
          <p className="text-secondary">{t('result.skipped', { count: outcome.skipped.length })}</p>
          <ul className="flex max-h-24 flex-col gap-0.5 overflow-y-auto text-secondary">
            {outcome.skipped.map((skip) => (
              <li key={skip.key} className="truncate" title={skip.message}>
                {t('result.failure', { title: skip.title, message: skip.message })}
              </li>
            ))}
          </ul>
        </>
      )}
      {outcome.failed.length > 0 && (
        <>
          <p className="text-danger">{t('result.failed', { count: outcome.failed.length })}</p>
          <ul className="flex max-h-24 flex-col gap-0.5 overflow-y-auto text-danger">
            {outcome.failed.map((failure) => (
              <li key={failure.key} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate" title={failure.message}>
                  {t('result.failure', { title: failure.title, message: failure.message })}
                </span>
                {failure.held && (
                  <Button
                    variant="outline"
                    size="xs"
                    className="flex-none"
                    disabled={forking !== null}
                    title={t('result.forkTip')}
                    onClick={() => onFork(failure)}
                  >
                    {forking === failure.key && <Spinner className="size-3" />}
                    {t('result.fork')}
                  </Button>
                )}
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
