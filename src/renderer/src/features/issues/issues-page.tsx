import { useEffect, useMemo, useState } from 'react'
import {
  Comment01Icon,
  RadioButtonIcon,
  RefreshIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { InboxFilter, InboxIssue, IssueInbox } from '@shared/github-flow'
import type { GitStatus } from '@shared/git'
import type { AgentId } from '@shared/thread'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Input } from '@renderer/components/ui/input'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { toast } from '@renderer/components/ui/toast'
import { AgentMenu } from '@renderer/features/session/new-session/agent-menu'
import { canStart, startValues } from '@renderer/features/session/new-session/start-options'
import { currentBase } from '@renderer/features/session/new-session/worktree-base'
import { Glyph } from '@renderer/features/shell/glyph'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { basename, shortAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import {
  optionsOn,
  picksOf,
  useAgentOptionsStore,
  type OptionValues,
} from '@renderer/stores/agent-options'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { receiveGitStatus, useGitStore } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { openSession } from '@renderer/stores/view'

type Read =
  { kind: 'loading' } | { kind: 'ready'; inbox: IssueInbox } | { kind: 'failed'; message: string }

/**
 * Huli: a project's issue inbox: the open issues of its GitHub repository, assigned to the user or
 * all of them, searched as typed, each with a button that starts a session for it. Read when the
 * page opens and on Refresh; nothing here polls.
 */
export default function IssuesPage({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation('git')
  const name = useProjectsStore(
    (s) => s.projects.find((project) => project.path === projectPath)?.name,
  )
  const status = useGitStore((s) => s.status[projectPath])
  const [filter, setFilter] = useState<InboxFilter>('mine')
  const [query, setQuery] = useState('')
  const [asked, setAsked] = useState(0)
  // Which read the list shows: a new filter or Refresh reads again, the last list showing meanwhile.
  const asking = `${filter}:${asked}`
  const [read, setRead] = useState<Read & { key: string }>({ kind: 'loading', key: '' })
  const [starting, setStarting] = useState<InboxIssue | null>(null)
  const github = status === undefined ? undefined : (status.remote?.github ?? null)
  const repoKey = github === undefined ? undefined : github && `${github.owner}/${github.repo}`
  const refreshing = repoKey !== null && read.key !== asking

  useEffect(() => {
    void host('git.status', { projectPath })
      .then(receiveGitStatus)
      .catch(() => {})
  }, [projectPath])

  useEffect(() => {
    if (repoKey === null) return
    let current = true
    host('github.issues', { projectPath, filter }).then(
      (inbox) => current && setRead({ kind: 'ready', inbox, key: asking }),
      (error: unknown) =>
        current && setRead({ kind: 'failed', message: errorMessage(error), key: asking }),
    )
    return () => {
      current = false
    }
  }, [projectPath, filter, asking, repoKey])

  const inbox = read.kind === 'ready' ? read.inbox : null
  const shown = useMemo(() => (inbox ? searched(inbox.issues, query) : []), [inbox, query])
  const repo = github ? `${github.owner}/${github.repo}` : (name ?? basename(projectPath))

  return (
    <div className="ks-session flex h-full min-h-0 flex-col">
      <TopBar>
        <NoDrag className="min-w-0 gap-2">
          <Glyph icon={RadioButtonIcon} size={15} className="shrink-0 text-icon" />
          <span className="truncate text-label font-medium">{t('issues.title')}</span>
          <span className="truncate text-label text-tertiary">{repo}</span>
        </NoDrag>
        <span className="flex-1" />
      </TopBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 pt-5 pb-10 phone:px-4">
          {github === null ? (
            <NotOnGithub />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                  aria-label={t('issues.filter')}
                  value={filter}
                  onChange={setFilter}
                  segments={[
                    { value: 'mine', label: t('issues.filterMine') },
                    { value: 'all', label: t('issues.filterAll') },
                  ]}
                />
                <label className="relative min-w-40 flex-1">
                  <Glyph
                    icon={Search01Icon}
                    size={14}
                    className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-icon"
                  />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('issues.search')}
                    aria-label={t('issues.search')}
                    className="pl-8"
                    spellCheck={false}
                  />
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={refreshing}
                  onClick={() => setAsked((n) => n + 1)}
                >
                  {refreshing ? (
                    <Spinner className="size-3.5" data-icon="inline-start" />
                  ) : (
                    <Glyph icon={RefreshIcon} size={14} data-icon="inline-start" />
                  )}
                  {t('issues.refresh')}
                </Button>
              </div>
              {filter === 'mine' && inbox && inbox.viewer === null && (
                <p className="text-xs text-secondary">{t('issues.noViewer')}</p>
              )}
              {read.kind === 'loading' || (github === undefined && !inbox) ? (
                <ListSkeleton />
              ) : read.kind === 'failed' ? (
                <Failed message={read.message} onRetry={() => setAsked((n) => n + 1)} />
              ) : shown.length === 0 ? (
                <NoIssues filter={filter} query={query.trim()} />
              ) : (
                <ul className="flex flex-col" aria-busy={refreshing}>
                  {shown.map((issue) => (
                    <IssueRow key={issue.url} issue={issue} onStart={() => setStarting(issue)} />
                  ))}
                </ul>
              )}
              {inbox?.truncated && (
                <p className="text-xs text-tertiary">
                  {t('issues.truncated', { count: inbox.issues.length })}
                </p>
              )}
            </>
          )}
        </div>
      </div>
      {starting && status && (
        <StartDialog
          issue={starting}
          projectPath={projectPath}
          status={status}
          onClose={() => setStarting(null)}
        />
      )}
    </div>
  )
}

/** The issues whose number, title, labels or people hold every word of the query. */
function searched(issues: InboxIssue[], query: string): InboxIssue[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return issues
  return issues.filter((issue) => {
    const text = [
      `#${issue.number}`,
      issue.title,
      ...issue.labels.map((label) => label.name),
      issue.author ?? '',
      ...issue.assignees,
    ]
      .join(' ')
      .toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

function IssueRow({ issue, onStart }: { issue: InboxIssue; onStart: () => void }) {
  const { t } = useTranslation('git')
  const now = useNow()
  return (
    <li className="group flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-hover">
      <Glyph icon={RadioButtonIcon} size={16} className="mt-0.5 shrink-0 text-success" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            title={t('issues.openIssue', { number: issue.number })}
            className="min-w-0 truncate text-label font-medium text-primary no-underline outline-none hover:underline focus-ring"
          >
            {issue.title}
          </a>
          {issue.labels.map((label) => (
            <span
              key={label.name}
              className="inline-flex h-5 max-w-40 items-center gap-1.25 rounded-full px-1.75 text-xs text-secondary shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]"
            >
              {label.color && (
                <span
                  aria-hidden
                  className="size-1.75 shrink-0 rounded-full"
                  style={{ backgroundColor: `#${label.color}` }}
                />
              )}
              <span className="truncate">{label.name}</span>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-tertiary">
          <span className="tabular">#{issue.number}</span>
          {issue.author && <span>· {issue.author}</span>}
          <span>· {t('issues.updated', { time: shortAgo(issue.updatedAt, now) })}</span>
          {issue.assignees.length > 0 && (
            <span>· {t('issues.assignees', { names: issue.assignees.join(', ') })}</span>
          )}
          {issue.comments > 0 && (
            <span
              className="inline-flex items-center gap-0.5"
              aria-label={t('issues.comments', { count: issue.comments })}
            >
              · <Glyph icon={Comment01Icon} size={12} />
              <span className="tabular">{issue.comments}</span>
            </span>
          )}
        </div>
      </div>
      <Button size="sm" variant="secondary" className="shrink-0" onClick={onStart}>
        {t('issues.start')}
      </Button>
    </li>
  )
}

/**
 * Starts a session for the issue: the agent and its options as New session would offer them, and
 * by default a worktree of its own cut from the branch the project has checked out.
 */
function StartDialog({
  issue,
  projectPath,
  status,
  onClose,
}: {
  issue: InboxIssue
  projectPath: string
  status: GitStatus
  onClose: () => void
}) {
  const { t } = useTranslation('git')
  const hostId = hostOfPath(projectPath)
  const defaultAgent = useSettingsStore((s) => s.settings.general.defaultAgent)
  const [agentId, setAgentId] = useState<AgentId | null>(() => {
    const known = defaultAgent
      ? agentsOn(useAgentsStore.getState(), hostId).byId[defaultAgent]
      : undefined
    return defaultAgent && known && canStart(known) ? defaultAgent : null
  })
  const [values, setValues] = useState<OptionValues>(() => initialValues(agentId, hostId))
  const base = status.repo ? currentBase(status) : null
  const [worktree, setWorktree] = useState(base !== null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (): Promise<void> => {
    if (!agentId || busy) return
    setBusy(true)
    setError(null)
    try {
      const summary = await host('github.startIssue', {
        projectPath,
        url: issue.url,
        agentId,
        ...(Object.keys(values).length > 0 ? { options: values } : {}),
        ...(worktree && base ? { worktree: { base } } : {}),
      })
      useSessionsStore.getState().upsert(summary)
      openSession(summary.id, summary.projectPath)
      toast(t('issues.started', { number: issue.number }))
      onClose()
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('issues.startTitle', { number: issue.number })}</DialogTitle>
          <DialogDescription>
            <span className="block truncate text-secondary">{issue.title}</span>
            <span className="mt-1 block">{t('issues.startHint')}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-ui text-secondary">{t('issues.agent')}</span>
            <AgentMenu
              agentId={agentId}
              hostId={hostId}
              values={values}
              onChoose={(next, model) => {
                const entry = optionsOn(useAgentOptionsStore.getState(), hostId)[next]
                const seed = next === agentId ? values : initialValues(next, hostId)
                const modelOption = entry?.config.find((option) => option.category === 'model')
                const chosen = { ...seed }
                if (modelOption) {
                  if (model === null) delete chosen[modelOption.id]
                  else chosen[modelOption.id] = model
                }
                setAgentId(next)
                setValues(chosen)
              }}
              onValues={(optionId, value) =>
                setValues((current) => ({ ...current, [optionId]: value }))
              }
            />
          </div>
          {base !== null && (
            <label className="flex items-start justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <span className="text-ui">{t('issues.worktree')}</span>
                <span className="text-hint text-tertiary">
                  {t('issues.worktreeHint', { base })}
                </span>
              </span>
              <Switch checked={worktree} onCheckedChange={setWorktree} />
            </label>
          )}
          {error && <p className="text-hint text-danger">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('issues.cancel')}
          </Button>
          <Button disabled={!agentId || busy} onClick={() => void start()}>
            {busy && <Spinner className="size-3.5" data-icon="inline-start" />}
            {t('issues.go')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function initialValues(agentId: AgentId | null, hostId: string | null): OptionValues {
  if (!agentId) return {}
  const store = useAgentOptionsStore.getState()
  const entry = optionsOn(store, hostId)[agentId]
  return entry ? startValues(entry, picksOf(store, hostId, agentId)) : {}
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-start gap-3 px-3 py-2.5">
          <Skeleton className="size-4 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className={cn('h-4', i % 2 ? 'w-2/3' : 'w-1/2')} />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-7 w-24 rounded-lg" />
        </div>
      ))}
    </div>
  )
}

function NoIssues({ filter, query }: { filter: InboxFilter; query: string }) {
  const { t } = useTranslation('git')
  return (
    <Empty className="py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Glyph icon={RadioButtonIcon} size={18} />
        </EmptyMedia>
        <EmptyTitle>
          {query
            ? t('issues.emptySearch', { query })
            : filter === 'mine'
              ? t('issues.emptyMine')
              : t('issues.emptyAll')}
        </EmptyTitle>
        {!query && <EmptyDescription>{t('issues.emptyHint')}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  )
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation('git')
  return (
    <Empty className="py-12">
      <EmptyHeader>
        <EmptyTitle>{t('issues.failed')}</EmptyTitle>
        <EmptyDescription className="break-words">{message}</EmptyDescription>
      </EmptyHeader>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t('issues.retry')}
      </Button>
    </Empty>
  )
}

function NotOnGithub() {
  const { t } = useTranslation('git')
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Glyph icon={RadioButtonIcon} size={18} />
        </EmptyMedia>
        <EmptyTitle>{t('issues.notGithub')}</EmptyTitle>
        <EmptyDescription>{t('issues.notGithubHint')}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
