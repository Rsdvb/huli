import { useState, type ReactNode } from 'react'
import { ComputerTerminal01Icon, Folder01Icon, Search01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BackgroundWork, BusySession, BusyTerminal } from '@shared/host-control'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { runningFor } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { cn } from '@renderer/lib/utils'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { Glyph } from '@renderer/features/shell/glyph'

/** Above this many rows the list takes a filter. */
const FILTER_FROM = 8

/** What a session runs beside a turn, which the quit stops too: its names, then its jobs. */
function backgroundText(work: BackgroundWork): string {
  const parts = [...work.commands, ...work.tasks, ...work.subagents]
  if (work.scheduled > 0) parts.push(i18n.t('updates:quit.scheduled', { count: work.scheduled }))
  if (work.unnamed) parts.push(i18n.t('updates:quit.backgroundWork'))
  return parts.join(i18n.t('updates:quit.workSeparator'))
}

/** The last folder of a path, either separator. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

/** Where a terminal's shell started, relative to its project; empty at the project's top. */
function folderOf(terminal: BusyTerminal): string {
  const folder = terminal.folder
  if (!folder) return ''
  const project = terminal.projectPath.replace(/[\\/]+$/, '')
  if (folder.replace(/[\\/]+$/, '') === project) return ''
  return folder.startsWith(project) ? folder.slice(project.length).replace(/^[\\/]+/, '') : folder
}

/** A session and what it runs, or a project's terminals that belong to no session. */
interface WorkGroup {
  key: string
  title: string
  agentId: AgentId | null
  session: BusySession | null
  terminals: BusyTerminal[]
}

function useGroups(sessions: BusySession[], terminals: BusyTerminal[]): WorkGroup[] {
  const known = useSessionsStore((s) => s.byId)
  const groups = new Map<string, WorkGroup>()
  for (const session of sessions) {
    groups.set(session.sessionId, {
      key: session.sessionId,
      title: sessionTitle(session),
      agentId: session.agentId,
      session,
      terminals: [],
    })
  }
  for (const terminal of terminals) {
    const sessionId = terminal.sessionId ?? null
    const key = sessionId ?? `project:${terminal.projectPath}`
    let group = groups.get(key)
    if (!group) {
      const summary = sessionId ? known[sessionId] : undefined
      group = {
        key,
        title: summary ? sessionTitle(summary) : baseName(terminal.projectPath),
        agentId: summary?.agentId ?? null,
        session: null,
        terminals: [],
      }
      groups.set(key, group)
    }
    group.terminals.push(terminal)
  }
  return [...groups.values()]
}

function matches(query: string, ...texts: (string | null | undefined)[]): boolean {
  return texts.some((text) => !!text && text.toLowerCase().includes(query))
}

/**
 * The working sessions and running terminal commands a quit or restart would stop, each terminal
 * under its session: what it runs, the folder it runs in and for how long. A long list scrolls
 * inside its own box, which a filter heads.
 */
export function RunningWorkList({
  sessions,
  terminals,
  now,
  className,
}: {
  sessions: BusySession[]
  terminals: BusyTerminal[]
  now: number
  className?: string
}) {
  const { t } = useTranslation('updates')
  const [typed, setTyped] = useState('')
  const groups = useGroups(sessions, terminals)
  const rows = groups.length + terminals.length
  const query = rows > FILTER_FROM ? typed.trim().toLowerCase() : ''
  const shown = query
    ? groups
        .map((group) =>
          matches(query, group.title)
            ? group
            : {
                ...group,
                terminals: group.terminals.filter((terminal) =>
                  matches(query, terminal.name, terminal.title, terminal.folder),
                ),
              },
        )
        .filter((group) => matches(query, group.title) || group.terminals.length > 0)
    : groups
  return (
    <div className={cn('mt-3.5 flex min-h-0 min-w-0 flex-col', className)}>
      {rows > FILTER_FROM && (
        <label className="mb-1.5 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-subtle px-2.5 text-tertiary">
          <Glyph icon={Search01Icon} size={14} />
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={t('quit.filter', { count: rows })}
            aria-label={t('quit.filter', { count: rows })}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-placeholder"
          />
        </label>
      )}
      <ul className="flex max-h-[min(22rem,38dvh)] min-w-0 flex-col overflow-y-auto overscroll-contain text-ui">
        {shown.map((group) => (
          <li key={group.key} className="flex min-w-0 flex-col">
            <GroupRow group={group} now={now} />
            {group.terminals.length > 0 && (
              <ul className="flex min-w-0 flex-col">
                {group.terminals.map((terminal) => (
                  <TerminalRow key={terminal.id} terminal={terminal} now={now} />
                ))}
              </ul>
            )}
          </li>
        ))}
        {shown.length === 0 && (
          <li className="flex h-8.5 items-center text-small text-tertiary">{t('quit.noMatch')}</li>
        )}
      </ul>
    </div>
  )
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex h-8.5 min-w-0 shrink-0 items-center gap-2.5 border-b border-border-soft',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** A session's own line: its turn and what runs beside it, or how many of its terminals run. */
function GroupRow({ group, now }: { group: WorkGroup; now: number }) {
  const { t } = useTranslation('updates')
  const { session } = group
  return (
    <Row>
      {group.agentId ? (
        <AgentMark agent={group.agentId} size={16} />
      ) : (
        <Glyph icon={Folder01Icon} className="text-icon" />
      )}
      <span className="min-w-0 flex-1 truncate" title={group.title}>
        {group.title}
      </span>
      {session?.turnStartedAt != null ? (
        <span className="flex shrink-0 items-center gap-2 text-small text-tertiary tabular">
          <RingSpinner aria-hidden />
          {runningFor(now - session.turnStartedAt)}
        </span>
      ) : session?.background ? (
        <span className="max-w-1/2 min-w-0 truncate text-small text-tertiary">
          {t('quit.background', { work: backgroundText(session.background) })}
        </span>
      ) : (
        group.terminals.length > 0 && (
          <span className="shrink-0 text-small text-tertiary">
            {t('quit.terminals', { count: group.terminals.length })}
          </span>
        )
      )}
    </Row>
  )
}

/** A terminal under its session: its name or command, its folder, and for how long it runs. */
function TerminalRow({ terminal, now }: { terminal: BusyTerminal; now: number }) {
  const { t } = useTranslation('updates')
  const folder = folderOf(terminal)
  const label = terminal.name ?? terminal.title
  const since = terminal.since ?? null
  return (
    <li>
      <Row className="pl-6.5">
        <Glyph icon={ComputerTerminal01Icon} size={14} className="text-icon" />
        <span
          className={cn('min-w-0 flex-1 truncate', !terminal.name && 'font-mono text-xs')}
          title={terminal.name ? `${terminal.name} · ${terminal.title}` : terminal.title}
        >
          {label}
        </span>
        {folder && (
          <span
            className="max-w-1/3 min-w-0 truncate font-mono text-xs text-tertiary"
            title={terminal.folder}
          >
            {folder}
          </span>
        )}
        <span className="shrink-0 text-small text-tertiary tabular">
          {since !== null
            ? t('quit.runningFor', { time: runningFor(now - since) })
            : t('quit.running')}
        </span>
      </Row>
    </li>
  )
}
