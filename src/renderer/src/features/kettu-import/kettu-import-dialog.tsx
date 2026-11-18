// Huli: choosing which of Kettu's sessions to import, project by project, and whether its memory
// and artifacts come too, and the import's progress and outcome. Huli's own; see tools/huli/README.md.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  KettuArtifactsResult,
  KettuImportScan,
  KettuMemoryResult,
  KettuSession,
} from '@shared/kettu-import'
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
import { Progress } from '@renderer/components/ui/progress'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { basename, mediumAgo } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { useFoundText } from './found-text'
import {
  clearKettuResult,
  defaultExtras,
  defaultSelection,
  importable,
  runKettuImport,
  scanKettu,
  useKettuImportStore,
  type KettuExtras,
} from './store'

interface ProjectGroup {
  path: string
  name: string
  sessions: KettuSession[]
}

/** Kettu's top-level sessions under their projects, the projects in the order Kettu lists them. */
function groupsOf(scan: KettuImportScan): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const project of scan.projects) {
    groups.set(project.path, { path: project.path, name: project.name, sessions: [] })
  }
  for (const session of scan.sessions) {
    if (session.origin === 'subagent') continue
    let group = groups.get(session.projectPath)
    if (!group) {
      group = { path: session.projectPath, name: basename(session.projectPath), sessions: [] }
      groups.set(session.projectPath, group)
    }
    group.sessions.push(session)
  }
  return [...groups.values()].filter((group) => group.sessions.length > 0)
}

function withIds(set: ReadonlySet<string>, ids: readonly string[], on: boolean): Set<string> {
  const next = new Set(set)
  for (const id of ids) {
    if (on) next.add(id)
    else next.delete(id)
  }
  return next
}

/** Kettu's sessions to pick, project by project; mounted with each opening, so it starts afresh. */
export function KettuImportDialog({
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
        className="flex max-h-[min(640px,85svh)] flex-col gap-0 p-0 sm:max-w-[520px]"
      >
        {open && <KettuImportBody onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function KettuImportBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['kettuImport', 'common'])
  const scan = useKettuImportStore((s) => s.scan)
  const scanError = useKettuImportStore((s) => s.scanError)
  const running = useKettuImportStore((s) => s.running)
  const progress = useKettuImportStore((s) => s.progress)
  const result = useKettuImportStore((s) => s.result)
  const runError = useKettuImportStore((s) => s.runError)
  const found = useFoundText(scan)
  // Each opening looks again, as sessions may have been made in Kettu or imported meanwhile.
  useEffect(() => {
    clearKettuResult()
    void scanKettu()
  }, [])
  // The first selection follows the first scan this opening sees.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null)
  const [extras, setExtras] = useState<KettuExtras | null>(null)
  const [seen, setSeen] = useState<KettuImportScan | null>(null)
  if (scan && scan !== seen) {
    setSeen(scan)
    // Memory and artifacts start chosen while some are new, and stay as the user set them.
    setExtras((current) => {
      const fresh = defaultExtras(scan)
      return current === null
        ? fresh
        : {
            memory: current.memory && fresh.memory,
            artifacts: current.artifacts && fresh.artifacts,
          }
    })
    setSelected((current) =>
      current === null
        ? defaultSelection(scan)
        : // Those imported since drop out of the selection.
          new Set(
            [...current].filter((id) => scan.sessions.some((s) => s.id === id && importable(s))),
          ),
    )
  }
  const groups = useMemo(() => (scan ? groupsOf(scan) : []), [scan])
  const chosen = selected ?? new Set<string>()
  const allIds = groups.flatMap((g) => g.sessions.filter(importable).map((s) => s.id))
  const allOn = allIds.length > 0 && allIds.every((id) => chosen.has(id))
  const someOn = allIds.some((id) => chosen.has(id))
  const count = allIds.filter((id) => chosen.has(id)).length
  const usable =
    scan?.found && !scan.error ? defaultExtras(scan) : { memory: false, artifacts: false }
  const wanted: KettuExtras = {
    memory: usable.memory && (extras?.memory ?? false),
    artifacts: usable.artifacts && (extras?.artifacts ?? false),
  }
  const anything = count > 0 || wanted.memory || wanted.artifacts

  return (
    <>
      <DialogHeader className="gap-1.5 px-5.5 pt-5">
        <DialogTitle>{t('dialog.title')}</DialogTitle>
        <DialogDescription>
          {scan?.found && !scan.error ? t('dialog.description', found) : t('row.description')}
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5.5 pt-3.5">
        {!scan ? (
          scanError ? (
            <p className="py-2 text-ui text-danger">{t('error.scan', { error: scanError })}</p>
          ) : (
            <div className="flex flex-col">
              {[0.62, 0.48, 0.55].map((width) => (
                <div key={width} className="flex h-10 items-center gap-2.5 px-1">
                  <Skeleton className="size-4 rounded-sm" />
                  <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
                </div>
              ))}
            </div>
          )
        ) : !scan.found ? (
          <p className="py-2 text-ui text-secondary">{t('row.notFound')}</p>
        ) : scan.error ? (
          <p className="py-2 text-ui text-danger">{t(`error.${scan.error}`)}</p>
        ) : (
          <>
            {groups.length === 0 ? (
              <p className="py-2 text-ui text-secondary">{t('dialog.noSessions')}</p>
            ) : (
              groups.map((group) => (
                <ProjectList
                  key={group.path}
                  group={group}
                  selected={chosen}
                  locked={running}
                  onSelect={(ids, on) => setSelected(withIds(chosen, ids, on))}
                />
              ))
            )}
            <Extras
              scan={scan}
              chosen={wanted}
              locked={running}
              onChange={(next) => setExtras({ ...wanted, ...next })}
            />
          </>
        )}
      </div>
      <div className="flex flex-col gap-2 px-5.5 pt-3">
        {running && progress && (
          <div className="flex flex-col gap-1.5" aria-live="polite">
            <span className="truncate text-hint text-secondary">
              {progress.title
                ? t('dialog.importingTitle', {
                    done: progress.done + 1,
                    total: progress.total,
                    title: progress.title,
                  })
                : t('dialog.importing', { done: progress.done, total: progress.total })}
            </span>
            <Progress value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0} />
          </div>
        )}
        {!running && (result || runError) && <Outcome />}
        <p className="text-hint text-tertiary">{t('dialog.readOnly')}</p>
      </div>
      <div className="flex items-center gap-2 px-5.5 py-4.5">
        {allIds.length > 0 && (
          <label className="flex items-center gap-2 text-control text-secondary">
            <Checkbox
              checked={allOn}
              indeterminate={someOn && !allOn}
              disabled={running}
              className="data-disabled:opacity-40"
              onCheckedChange={(on) => setSelected(withIds(chosen, allIds, on))}
            />
            {t('dialog.selectAll')}
          </label>
        )}
        <span className="flex-1" />
        <Button variant="outline" onClick={onClose}>
          {result ? t('dialog.close') : t('common:actions.cancel')}
        </Button>
        <Button
          disabled={running || !anything}
          onClick={() =>
            void runKettuImport(
              allIds.filter((id) => chosen.has(id)),
              wanted,
            )
          }
        >
          {running ? (
            <>
              <Spinner className="size-3.5" />
              {t('dialog.importNone')}
            </>
          ) : count > 0 ? (
            t('dialog.import', { count })
          ) : (
            t('dialog.importNone')
          )}
        </Button>
      </div>
    </>
  )
}

/** A project's heading, which selects all its sessions, and its sessions under it. */
function ProjectList({
  group,
  selected,
  locked,
  onSelect,
}: {
  group: ProjectGroup
  selected: ReadonlySet<string>
  locked: boolean
  onSelect: (ids: string[], on: boolean) => void
}) {
  const { t } = useTranslation('kettuImport')
  const ids = group.sessions.filter(importable).map((s) => s.id)
  const on = ids.length > 0 && ids.every((id) => selected.has(id))
  const some = ids.some((id) => selected.has(id))
  return (
    <section aria-label={group.name} className="pb-2">
      <label
        className="flex h-9 items-center gap-2.5 px-1"
        title={group.path}
        aria-label={t('dialog.toggleProject', { project: group.name })}
      >
        <Checkbox
          checked={on}
          indeterminate={some && !on}
          disabled={locked || ids.length === 0}
          className="data-disabled:opacity-40"
          onCheckedChange={(next) => onSelect(ids, next)}
        />
        <span className="min-w-0 flex-1 truncate text-control font-medium text-foreground">
          {group.name}
          <span className="ml-1.5 font-normal text-tertiary">{group.path}</span>
        </span>
        <span className="text-meta text-tertiary tabular">
          {t('dialog.projectCount', { count: group.sessions.length })}
        </span>
      </label>
      <ul className="flex flex-col">
        {group.sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            checked={selected.has(session.id)}
            locked={locked}
            onSelect={(next) => onSelect([session.id], next)}
          />
        ))}
      </ul>
    </section>
  )
}

function SessionRow({
  session,
  checked,
  locked,
  onSelect,
}: {
  session: KettuSession
  checked: boolean
  locked: boolean
  onSelect: (on: boolean) => void
}) {
  const { t } = useTranslation(['kettuImport', 'common'])
  const can = importable(session)
  const meta = [
    session.imported
      ? t('badge.imported')
      : session.skip
        ? t(`badge.${session.skip}`)
        : session.archived
          ? t('badge.archived')
          : session.pinned
            ? t('badge.pinned')
            : null,
    session.subagents > 0 ? t('subagents', { count: session.subagents }) : null,
    mediumAgo(session.updatedAt),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <li>
      <label className="flex h-10 items-center gap-2.5 border-b border-subtle pr-1 pl-7">
        <Checkbox
          checked={session.imported || (can && checked)}
          disabled={!can || locked}
          className="data-disabled:opacity-40"
          onCheckedChange={onSelect}
        />
        <AgentMark agent={session.agentId} size={16} />
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

/** Memory and artifacts, each with what Kettu has, what is new, and what an import of it does. */
function Extras({
  scan,
  chosen,
  locked,
  onChange,
}: {
  scan: KettuImportScan
  chosen: KettuExtras
  locked: boolean
  onChange: (next: Partial<KettuExtras>) => void
}) {
  const { t } = useTranslation('kettuImport')
  const { memory, artifacts } = scan
  if (memory.found === 0 && artifacts.found === 0 && artifacts.error === null) return null
  return (
    <section aria-label={t('extras.title')} className="flex flex-col pb-2">
      <h3 className="flex h-9 items-center px-1 text-control font-medium text-foreground">
        {t('extras.title')}
      </h3>
      {memory.found > 0 && (
        <ExtraRow
          label={
            memory.importable > 0
              ? t('extras.memory', { found: memory.found, count: memory.importable })
              : t('extras.memoryDone', { found: memory.found })
          }
          hint={t('extras.memoryHint')}
          checked={chosen.memory}
          disabled={locked || memory.importable === 0}
          onChange={(on) => onChange({ memory: on })}
        />
      )}
      {artifacts.error !== null ? (
        <p className="px-1 py-1.5 text-hint text-danger">
          {t(`extras.artifactsError.${artifacts.error}`)}
        </p>
      ) : (
        artifacts.found > 0 && (
          <ExtraRow
            label={
              artifacts.importable > 0
                ? t('extras.artifacts', { found: artifacts.found, count: artifacts.importable })
                : t('extras.artifactsDone', { found: artifacts.found })
            }
            hint={t('extras.artifactsHint')}
            checked={chosen.artifacts}
            disabled={locked || artifacts.importable === 0}
            onChange={(on) => onChange({ artifacts: on })}
          />
        )
      )}
    </section>
  )
}

function ExtraRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex items-start gap-2.5 border-b border-subtle px-1 py-2">
      <Checkbox
        checked={checked}
        disabled={disabled}
        className="mt-0.5 data-disabled:opacity-40"
        onCheckedChange={onChange}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('text-[13.5px]', disabled ? 'text-secondary' : 'text-foreground')}>
          {label}
        </span>
        <span className="text-hint text-tertiary">{hint}</span>
      </span>
    </label>
  )
}

type Translate = ReturnType<typeof useTranslation<'kettuImport'>>['t']

/** The reasons counted, as "3 imported before, 2 already here"; empty when none. */
function reasonsText(
  t: Translate,
  prefix: 'result.memory.reason' | 'result.artifacts.reason',
  counts: Record<string, number>,
): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => t(`${prefix}.${reason}` as 'result.memory.reason.same', { count }))
    .join(t('separator'))
}

function memoryLines(t: Translate, memory: KettuMemoryResult): string[] {
  const skipped = reasonsText(t, 'result.memory.reason', memory.skipped)
  return [
    t('result.memory.imported', { count: memory.imported }),
    memory.renamed.length > 0 ? t('result.memory.renamed', { count: memory.renamed.length }) : '',
    skipped ? t('result.memory.skipped', { reasons: skipped }) : '',
  ].filter(Boolean)
}

function artifactLines(t: Translate, artifacts: KettuArtifactsResult): string[] {
  const skipped = reasonsText(t, 'result.artifacts.reason', artifacts.skipped)
  return [
    t('result.artifacts.imported', { count: artifacts.imported }),
    artifacts.renamed.length > 0
      ? t('result.artifacts.renamed', { count: artifacts.renamed.length })
      : '',
    skipped ? t('result.artifacts.skipped', { reasons: skipped }) : '',
    t('result.artifacts.notShared'),
  ].filter(Boolean)
}

/**
 * What the last import did: how many sessions came over, as copies, were skipped, and which failed
 * why; then the same of memory and artifacts.
 */
function Outcome() {
  const { t } = useTranslation('kettuImport')
  const result = useKettuImportStore((s) => s.result)
  const runError = useKettuImportStore((s) => s.runError)
  if (runError) return <p className="text-hint text-danger">{runError}</p>
  if (!result) return null
  const sessions = result.imported + result.skipped + result.failed.length > 0
  const extras = result.memory || result.memoryError || result.artifacts || result.artifactsError
  const lines = [
    sessions || !extras ? t('result.imported', { count: result.imported }) : null,
    result.forked > 0 ? t('result.forked', { count: result.forked }) : null,
    result.skipped > 0 ? t('result.skipped', { count: result.skipped }) : null,
  ].filter(Boolean)
  const artifactFailures = result.artifacts?.failed ?? []
  return (
    <div className="flex max-h-40 flex-col gap-1 overflow-y-auto text-hint" role="status">
      {lines.length > 0 && <p className="text-foreground">{lines.join(' ')}</p>}
      {result.memory && (
        <p className="text-foreground">{memoryLines(t, result.memory).join(' ')}</p>
      )}
      {result.memoryError && <p className="text-danger">{result.memoryError}</p>}
      {result.artifacts && (
        <p className="text-foreground">{artifactLines(t, result.artifacts).join(' ')}</p>
      )}
      {result.artifactsError && (
        <p className="text-danger">{t(`extras.artifactsError.${result.artifactsError}`)}</p>
      )}
      {artifactFailures.length > 0 && (
        <>
          <p className="text-danger">
            {t('result.artifacts.failed', { count: artifactFailures.length })}
          </p>
          <ul className="flex flex-col gap-0.5 text-danger">
            {artifactFailures.map((failure, index) => (
              <li key={index} className="truncate" title={failure.message}>
                {t('result.failure', { title: failure.title, message: failure.message })}
              </li>
            ))}
          </ul>
        </>
      )}
      {result.failed.length > 0 && (
        <>
          <p className="text-danger">{t('result.failed', { count: result.failed.length })}</p>
          <ul className="flex max-h-24 flex-col gap-0.5 overflow-y-auto text-danger">
            {result.failed.map((failure) => (
              <li key={failure.sessionId} className="truncate" title={failure.message}>
                {t('result.failure', {
                  title: failure.title ?? t('result.untitled'),
                  message: failure.message,
                })}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
