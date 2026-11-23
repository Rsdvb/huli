// Huli: Settings › 回收站, the recycle bin: what deletes moved there, the latest first, with a kind
// filter and a search; restore, delete for good, several at once, and empty it. It reads the bin
// only while the page shows, and again when the host says the bin changed.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AiBrain01Icon,
  ArrowTurnBackwardIcon,
  DashboardSquare02Icon,
  Delete02Icon,
  FlowIcon,
  Folder01Icon,
  FolderOpenIcon,
  Message01Icon,
  Task01Icon,
  TimeScheduleIcon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import {
  BIN_DAY_MS,
  BIN_KEEP_DAYS,
  BIN_KINDS,
  type BinItem,
  type BinKind,
  type BinList,
  type BinProjectChoice,
  type BinRestoreResult,
} from '@shared/recycle-bin'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { toast } from '@renderer/components/ui/toast'
import { onBinChanged } from '@renderer/features/recycle-bin/events'
import { useHostHasBin } from '@renderer/features/recycle-bin/support'
import { basename, bytes, mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { onHost } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { useHostScope } from '@renderer/stores/host-scope'
import { useProjectsStore } from '@renderer/stores/projects'
import { openSettingsRow } from '@renderer/stores/view'
import {
  CONFIRM,
  ControlError,
  DangerButton,
  FindField,
  IconAction,
  SetButton,
  SettingSelect,
  Skel,
} from './controls'
import { EmptyCard, Thing } from './rows'
import { useApply } from './use-apply'

const KIND_ICON: Record<BinKind, IconSvgElement> = {
  session: Message01Icon,
  folder: Folder01Icon,
  project: FolderOpenIcon,
  task: Task01Icon,
  routine: TimeScheduleIcon,
  workflow: FlowIcon,
  memory: AiBrain01Icon,
  artifact: DashboardSquare02Icon,
}

/** Rows drawn at first, and added each time the list is asked for more, so a long bin opens fast. */
const PAGE_ROWS = 100

type Filter = BinKind | 'all'

/** Settings › General's choice of how long the bin keeps what it holds. */
export function BinKeepDays({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const keepDays =
    useSettingsStore((s) => s.settings.recycleBin?.keepDays) ?? DEFAULT_SETTINGS.recycleBin.keepDays
  const [apply, error] = useApply()
  const never = 'never'
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={label}
        value={keepDays === null ? never : String(keepDays)}
        options={[
          ...BIN_KEEP_DAYS.map((days) => ({
            value: String(days),
            label: t('general.binKeepDays.days', { count: days }),
          })),
          { value: never, label: t('general.binKeepDays.never') },
        ]}
        onChange={(next) => {
          const days = BIN_KEEP_DAYS.find((value) => String(value) === next)
          apply({ recycleBin: { keepDays: next === never ? null : (days ?? 30) } })
        }}
      />
    </>
  )
}

/** The bin's list as the host read it last; null while it reads the first time. */
function useBinList(): {
  list: BinList | null
  error: string | null
  reload: () => Promise<void>
} {
  const { hostId, request } = useHostScope()
  const [list, setList] = useState<BinList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(
    () =>
      request('bin.list', undefined).then(
        (next) => {
          setList(next)
          setError(null)
        },
        (e: unknown) => setError(errorMessage(e)),
      ),
    [request],
  )
  useEffect(() => {
    void reload()
    return onBinChanged(hostId, () => void reload())
  }, [hostId, reload])
  return { list, error, reload }
}

export function RecycleBinPage() {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  if (!useHostHasBin(hostId)) {
    return (
      <EmptyCard title={t('recycleBin.unsupportedTitle')} hint={t('recycleBin.unsupportedHint')} />
    )
  }
  return <BinList />
}

function BinList() {
  const { t } = useTranslation(['settings', 'sidebar', 'common'])
  const { request } = useHostScope()
  const { list, error, reload } = useBinList()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [shown, setShown] = useState(PAGE_ROWS)
  const [busy, setBusy] = useState(false)
  const [purging, setPurging] = useState<BinItem[] | null>(null)
  const [emptying, setEmptying] = useState(false)
  const [asking, setAsking] = useState<{ held: BinRestoreResult['held']; items: BinItem[] } | null>(
    null,
  )
  const [actionError, setActionError] = useState<string | null>(null)
  const where = useWhere()

  const items = useMemo(() => list?.items ?? [], [list])
  const counts = useMemo(() => {
    const out = new Map<Filter, number>([['all', items.length]])
    for (const item of items) out.set(item.kind, (out.get(item.kind) ?? 0) + 1)
    return out
  }, [items])
  const needle = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          (filter === 'all' || item.kind === filter) &&
          (needle === '' ||
            `${item.title ?? ''} ${where(item) ?? ''}`.toLowerCase().includes(needle)),
      ),
    [items, filter, needle, where],
  )
  // What is picked stays only while it is still there to act on.
  const picked = visible.filter((item) => selected.has(item.key))
  const allPicked = visible.length > 0 && picked.length === visible.length

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setActionError(null)
    try {
      await work()
    } catch (e) {
      setActionError(errorMessage(e))
    } finally {
      setBusy(false)
      await reload()
    }
  }

  const restore = (targets: BinItem[], project?: BinProjectChoice) =>
    run(async () => {
      const result = await request('bin.restore', {
        keys: targets.map((item) => item.key),
        ...(project ? { project } : {}),
      })
      const held = new Set(result.held.map((h) => h.key))
      setSelected((current) => new Set([...current].filter((key) => held.has(key))))
      if (result.restored.length > 0) {
        toast(t('recycleBin.restored', { count: targets.length - held.size }))
      }
      if (result.held.length > 0) {
        setAsking({ held: result.held, items: targets.filter((item) => held.has(item.key)) })
      }
    })

  const purge = (targets: BinItem[]) =>
    run(async () => {
      await request('bin.purge', { keys: targets.map((item) => item.key) })
      setSelected(new Set())
      toast(t('recycleBin.purged', { count: targets.length }))
    })

  const empty = () =>
    run(async () => {
      await request('bin.empty', undefined)
      setSelected(new Set())
      toast(t('recycleBin.emptied'))
    })

  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  const keepDays = list?.keepDays ?? DEFAULT_SETTINGS.recycleBin.keepDays
  const filters: Filter[] = ['all', ...BIN_KINDS.filter((kind) => (counts.get(kind) ?? 0) > 0)]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <FindField
          value={query}
          onChange={setQuery}
          label={t('recycleBin.search')}
          clearLabel={t('recycleBin.clearSearch')}
          className="min-w-48 flex-1"
        />
        <SettingSelect
          label={t('recycleBin.kind')}
          value={filter}
          className="w-40"
          options={filters.map((kind) => ({
            value: kind,
            label: `${kind === 'all' ? t('recycleBin.kindAll') : t(`recycleBin.kinds.${kind}`)} · ${counts.get(kind) ?? 0}`,
          }))}
          onChange={(next) => {
            setFilter(next)
            setShown(PAGE_ROWS)
          }}
        />
        <DangerButton
          busy={busy && emptying}
          disabled={items.length === 0 || busy}
          onClick={() => setEmptying(true)}
        >
          {t('recycleBin.empty')}
        </DangerButton>
      </div>
      <ControlError error={actionError ?? (list ? error : null)} />
      {visible.length > 0 && (
        <div className="flex min-h-8 items-center gap-2.5 px-1 text-control text-secondary">
          <Checkbox
            checked={allPicked}
            indeterminate={picked.length > 0 && !allPicked}
            aria-label={t('recycleBin.selectAll')}
            onCheckedChange={(on) =>
              setSelected(on ? new Set(visible.map((item) => item.key)) : new Set())
            }
          />
          <span className="flex-1">
            {picked.length > 0
              ? t('recycleBin.selected', { count: picked.length })
              : t('recycleBin.selectAll')}
          </span>
          {picked.length > 0 && (
            <>
              <SetButton disabled={busy} onClick={() => void restore(picked)}>
                {t('recycleBin.restore')}
              </SetButton>
              <SetButton variant="ghost" disabled={busy} onClick={() => setPurging(picked)}>
                <span className="text-danger">{t('recycleBin.purge')}</span>
              </SetButton>
            </>
          )}
        </div>
      )}
      {list === null && error === null && <BinSkeleton />}
      {list === null && error !== null && (
        <EmptyCard
          title={t('recycleBin.loadError')}
          hint={error}
          action={<SetButton onClick={() => void reload()}>{t('recycleBin.retry')}</SetButton>}
        />
      )}
      {list !== null && items.length === 0 && (
        <EmptyCard
          title={t('recycleBin.nothingTitle')}
          hint={
            keepDays === null
              ? t('recycleBin.nothingHintKept')
              : t('recycleBin.nothingHint', { count: keepDays })
          }
        />
      )}
      {list !== null && items.length > 0 && visible.length === 0 && (
        <EmptyCard title={t('recycleBin.noMatch')} />
      )}
      {visible.length > 0 && (
        <div className="ui-sg-card">
          {visible.slice(0, shown).map((item) => (
            <BinRow
              key={item.key}
              item={item}
              where={where(item)}
              checked={selected.has(item.key)}
              disabled={busy}
              onCheck={(on) => toggle(item.key, on)}
              onRestore={() => void restore([item])}
              onPurge={() => setPurging([item])}
            />
          ))}
        </div>
      )}
      {visible.length > shown && (
        <SetButton variant="ghost" onClick={() => setShown((n) => n + PAGE_ROWS)}>
          {t('recycleBin.more', { count: Math.min(PAGE_ROWS, visible.length - shown) })}
        </SetButton>
      )}
      {list !== null && (
        <p className="px-1 text-small text-tertiary">
          {keepDays === null
            ? t('recycleBin.keepNoteKept')
            : t('recycleBin.keepNote', { count: keepDays })}{' '}
          <button
            type="button"
            className="k-link"
            onClick={() => openSettingsRow('general', null, 'bin-keep-days')}
          >
            {t('recycleBin.keepChange')}
          </button>
        </p>
      )}
      <PurgeDialog
        items={purging}
        onCancel={() => setPurging(null)}
        onConfirm={(targets) => {
          setPurging(null)
          void purge(targets)
        }}
      />
      <AlertDialog open={emptying} onOpenChange={setEmptying}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('recycleBin.emptyTitle', { count: items.length })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('recycleBin.emptyBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setEmptying(false)
                void empty()
              }}
            >
              {t('recycleBin.emptyConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ProjectDialog
        asking={asking}
        onCancel={() => setAsking(null)}
        onChoose={(choice) => {
          const targets = asking?.items ?? []
          setAsking(null)
          void restore(targets, choice)
        }}
      />
    </div>
  )
}

/** Where an item was: its project's name, No project, global memory; null for none. */
function useWhere(): (item: BinItem) => string | null {
  const { t } = useTranslation(['settings', 'sidebar'])
  const { hostId } = useHostScope()
  const projects = useProjectsStore((s) => s.projects)
  return useCallback(
    (item: BinItem) => {
      if (item.kind === 'memory' && item.scope === 'global') return t('recycleBin.globalMemory')
      if (item.kind === 'project' || item.kind === 'folder' || item.kind === 'workflow') return null
      const path = item.projectPath
      if (!path) return item.kind === 'session' ? t('sidebar:project.noProject') : null
      const listed = projects.find((p) => p.path === onHost(hostId, path))
      return listed?.name ?? basename(path)
    },
    [hostId, projects, t],
  )
}

function BinRow({
  item,
  where,
  checked,
  disabled,
  onCheck,
  onRestore,
  onPurge,
}: {
  item: BinItem
  where: string | null
  checked: boolean
  disabled: boolean
  onCheck: (on: boolean) => void
  onRestore: () => void
  onPurge: () => void
}) {
  const { t } = useTranslation('settings')
  const now = useNow()
  const title = item.title || t('recycleBin.untitled')
  const facts = [
    t(`recycleBin.kinds.${item.kind}`),
    where,
    item.count
      ? t(item.kind === 'session' ? 'recycleBin.subSessions' : 'recycleBin.sessions', {
          count: item.count,
        })
      : null,
    item.size !== null ? bytes(item.size) : null,
  ].filter((part): part is string => !!part)
  const left =
    item.purgeAt === null ? null : Math.max(1, Math.ceil((item.purgeAt - now) / BIN_DAY_MS))
  const projectNote =
    item.kind === 'session' && (item.project === 'binned' || item.project === 'gone')
      ? t(item.project === 'binned' ? 'recycleBin.projectBinned' : 'recycleBin.projectGone')
      : null
  return (
    <div className="ui-sg-row">
      <span className="flex items-center pr-2.5">
        <Checkbox
          checked={checked}
          disabled={disabled}
          aria-label={t('recycleBin.select', { title })}
          onCheckedChange={(on) => onCheck(on)}
        />
      </span>
      <Thing
        mark={
          item.kind === 'session' && item.agentId ? (
            <AgentTile agent={item.agentId} size={32} />
          ) : (
            <span className="flex size-8 items-center justify-center rounded-lg bg-(--shell-chip) text-secondary">
              <Icon icon={KIND_ICON[item.kind]} size={16} />
            </span>
          )
        }
        name={<span className="k-name">{title}</span>}
      >
        <small>{facts.join(' · ')}</small>
        <small>
          {t('recycleBin.deletedAgo', { when: mediumAgo(item.deletedAt, now) })}
          {' · '}
          {left === null ? t('recycleBin.kept') : t('recycleBin.purgeIn', { count: left })}
          {projectNote && ` · ${projectNote}`}
        </small>
      </Thing>
      <span className="ui-sg-control">
        <SetButton disabled={disabled} onClick={onRestore}>
          <span className="inline-flex items-center gap-1.5">
            <Icon icon={ArrowTurnBackwardIcon} size={14} />
            {t('recycleBin.restore')}
          </span>
        </SetButton>
        <IconAction
          label={t('recycleBin.purge')}
          icon={Delete02Icon}
          danger
          disabled={disabled}
          onClick={onPurge}
        />
      </span>
    </div>
  )
}

function BinSkeleton() {
  return (
    <div className="ui-sg-card" aria-busy="true">
      {[0, 1, 2].map((n) => (
        <div key={n} className="ui-sg-row">
          <span className="flex flex-1 flex-col gap-1.5 py-1">
            <Skel width={220} />
            <Skel width="45%" />
          </span>
        </div>
      ))}
    </div>
  )
}

function PurgeDialog({
  items,
  onCancel,
  onConfirm,
}: {
  items: BinItem[] | null
  onCancel: () => void
  onConfirm: (items: BinItem[]) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const one = items?.length === 1 ? items[0] : undefined
  const sessions = items?.some((item) => item.kind === 'session' || item.count) ?? false
  return (
    <AlertDialog open={items !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className={CONFIRM}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {one
              ? t('recycleBin.purgeOneTitle', { title: one.title || t('recycleBin.untitled') })
              : t('recycleBin.purgeTitle', { count: items?.length ?? 0 })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('recycleBin.purgeBody')}
            {sessions && ` ${t('recycleBin.purgeSessions')}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => items && onConfirm(items)}>
            {t('recycleBin.purge')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** A restore that met sessions whose project is in the bin or gone asks what to do with them. */
function ProjectDialog({
  asking,
  onCancel,
  onChoose,
}: {
  asking: { held: BinRestoreResult['held']; items: BinItem[] } | null
  onCancel: () => void
  onChoose: (choice: BinProjectChoice) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const first = asking?.held[0]
  const several = (asking?.held.length ?? 0) > 1
  const name = first ? basename(first.projectPath) : ''
  const binned = asking?.held.some((held) => held.project === 'binned') ?? false
  return (
    <AlertDialog open={asking !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className={CONFIRM}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {several
              ? t('recycleBin.projectAskTitleCount', { count: asking?.held.length ?? 0 })
              : t('recycleBin.projectAskTitle', {
                  title: asking?.items[0]?.title || t('recycleBin.untitled'),
                })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {binned
              ? t('recycleBin.projectAskBinned', { name })
              : t('recycleBin.projectAskGone', { name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <Button variant="outline" size="dialog" onClick={() => onChoose('noProject')}>
            {t('recycleBin.toNoProject')}
          </Button>
          <AlertDialogAction onClick={() => onChoose('restore')}>
            {binned ? t('recycleBin.restoreProject') : t('recycleBin.addProject')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
