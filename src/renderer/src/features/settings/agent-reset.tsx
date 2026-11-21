// Huli: Settings > Agents > an agent > Reset environment: signs the agent out and removes the
// ids and caches it made on its host, its history and settings kept. The list is read from the
// host when the dialog opens, so it names exactly what goes there.

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentStatus } from '@shared/agent-host'
import {
  AGENT_RESET_CATEGORIES,
  type AgentResetCategory,
  type AgentResetItem,
  type AgentResetPreview,
  type AgentResetResult,
} from '@shared/agent-reset'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { bytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { DangerButton, SetButton, Skel } from './controls'
import { shortPath, type Places } from './host-places'
import { entryText } from './model'
import { Notice, RowFrame, RowText } from './rows'
import {
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
} from './settings-dialog'

/** The row on the agent's page that opens the dialog. */
export function ResetRow({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const { name, description } = entryText('agents.reset-environment')
  return (
    <RowFrame id="reset-environment" text={<RowText name={name} description={description} />}>
      <DangerButton onClick={() => setOpen(true)}>{t('agents.resetEnv.button')}</DangerButton>
      {open && <ResetDialog status={status} onClose={() => setOpen(false)} />}
    </RowFrame>
  )
}

type Phase =
  | { kind: 'loading' }
  // Huli: `run`, the reset itself failed, not the read of what it would remove.
  | { kind: 'failed'; error: string; run?: true }
  | { kind: 'ready'; preview: AgentResetPreview }
  | { kind: 'running'; preview: AgentResetPreview }
  | { kind: 'done'; result: AgentResetResult; places: Places }

/** The folder a path is in, for keys taken out of several files there, such as backups. */
function parentOf(target: string): string {
  const cut = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return cut > 0 ? target.slice(0, cut) : target
}

/** One line of a list: an item, or keys taken out of several files of one folder. */
interface Line {
  item: AgentResetItem
  files: number
}

function linesOf(items: AgentResetItem[]): Line[] {
  const lines: Line[] = []
  const groups = new Map<string, Line>()
  for (const item of items) {
    if (item.kind !== 'keys' || item.problem) {
      lines.push({ item, files: 1 })
      continue
    }
    const key = `${parentOf(item.path)}\0${(item.keys ?? []).join(',')}`
    const group = groups.get(key)
    if (group) group.files++
    else {
      const line = { item, files: 1 }
      groups.set(key, line)
      lines.push(line)
    }
  }
  return lines
}

function ResetDialog({ status, onClose }: { status: AgentStatus; onClose: () => void }) {
  const { request, api } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [picked, setPicked] = useState<Record<AgentResetCategory, boolean>>({
    credentials: true,
    identifiers: true,
    caches: true,
  })
  const [reads, setReads] = useState(0)
  useEffect(() => {
    let current = true
    request('agents.resetPreview', { agentId: status.id }).then(
      (preview) => current && setPhase({ kind: 'ready', preview }),
      (error: unknown) => current && setPhase({ kind: 'failed', error: errorMessage(error) }),
    )
    return () => {
      current = false
    }
  }, [request, status.id, reads])
  const load = (): void => {
    setPhase({ kind: 'loading' })
    setReads((count) => count + 1)
  }

  const preview = phase.kind === 'ready' || phase.kind === 'running' ? phase.preview : null
  const categories = AGENT_RESET_CATEGORIES.filter(
    (category) => picked[category] && preview?.items.some((item) => item.category === category),
  )
  const chosen = preview?.items.filter((item) => categories.includes(item.category)) ?? []
  const total = chosen.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
  const blocked = !preview || preview.busy.length > 0 || categories.length === 0

  const run = async (current: AgentResetPreview): Promise<void> => {
    setPhase({ kind: 'running', preview: current })
    try {
      const result = await request('agents.reset', { agentId: status.id, categories })
      // The keys Kite keeps for the agent are the app's, not the host's files.
      if (categories.includes('credentials')) {
        for (const item of current.items.filter((each) => each.kind === 'kite-key')) {
          try {
            await api.setAgentEnv(status.id, item.path, null)
            result.removed.push(item)
          } catch (error) {
            result.failed.push({ item, error: errorMessage(error) })
          }
        }
      }
      setPhase({ kind: 'done', result, places: { folder: current.folder, home: current.home } })
    } catch (error) {
      setPhase({ kind: 'failed', error: errorMessage(error), run: true })
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && phase.kind !== 'running' && onClose()}>
      <SettingsDialogContent className="sm:max-w-150">
        <SettingsDialogHeader title={t('agents.resetEnv.title', { name: status.name })}>
          {t('agents.resetEnv.lead')}
        </SettingsDialogHeader>
        <SettingsDialogBody>
          {phase.kind === 'loading' && (
            <div className="flex flex-col gap-3" aria-busy>
              <Skel width="60%" />
              <Skel width="90%" />
              <Skel width="75%" />
            </div>
          )}
          {phase.kind === 'failed' && (
            <Notice
              variant="error"
              title={t(phase.run ? 'agents.resetEnv.runFailed' : 'agents.resetEnv.failed')}
              action={
                <SetButton variant="secondary" onClick={load}>
                  {t('common:actions.retry')}
                </SetButton>
              }
            >
              {phase.error}
            </Notice>
          )}
          {preview && (
            <PreviewBody
              status={status}
              preview={preview}
              picked={picked}
              disabled={phase.kind === 'running'}
              onPick={(category, on) => setPicked((now) => ({ ...now, [category]: on }))}
              onCheckAgain={load}
            />
          )}
          {phase.kind === 'done' && <ResultBody result={phase.result} places={phase.places} />}
        </SettingsDialogBody>
        <SettingsDialogFooter
          start={preview && total > 0 ? t('agents.resetEnv.total', { size: bytes(total) }) : null}
        >
          {phase.kind === 'done' ? (
            <SetButton size="md" variant="primary" onClick={onClose}>
              {t('agents.resetEnv.done')}
            </SetButton>
          ) : (
            <>
              <DialogClose
                render={<SetButton size="md" variant="ghost" />}
                disabled={phase.kind === 'running'}
              >
                {t('common:actions.cancel')}
              </DialogClose>
              <SetButton
                size="md"
                variant="destructive"
                loading={phase.kind === 'running'}
                disabled={blocked || phase.kind === 'running'}
                onClick={() => preview && void run(preview)}
              >
                {t('agents.resetEnv.confirm')}
              </SetButton>
            </>
          )}
        </SettingsDialogFooter>
      </SettingsDialogContent>
    </Dialog>
  )
}

function PreviewBody({
  status,
  preview,
  picked,
  disabled,
  onPick,
  onCheckAgain,
}: {
  status: AgentStatus
  preview: AgentResetPreview
  picked: Record<AgentResetCategory, boolean>
  disabled: boolean
  onPick: (category: AgentResetCategory, on: boolean) => void
  onCheckAgain: () => void
}) {
  const { t } = useTranslation('settings')
  const again = (
    <SetButton variant="secondary" onClick={onCheckAgain} disabled={disabled}>
      {t('agents.resetEnv.checkAgain')}
    </SetButton>
  )
  return (
    <>
      {preview.busy.length > 0 && (
        <Notice
          variant="warning"
          title={t('agents.resetEnv.busy', { count: preview.busy.length })}
          action={again}
        >
          {preview.busy
            .map((session) => session.title ?? t('agents.resetEnv.untitled'))
            .join(' · ')}
        </Notice>
      )}
      {preview.outside > 0 && (
        <Notice
          variant="warning"
          title={t('agents.resetEnv.outside', { count: preview.outside })}
          action={again}
        >
          {t('agents.resetEnv.outsideHint')}
        </Notice>
      )}
      {preview.shared && (
        <p className="text-xs text-secondary" data-wrap="">
          {preview.shared === 'app'
            ? t('agents.resetEnv.sharedApp', { harness: status.harnessName })
            : t('agents.resetEnv.sharedProgram', { harness: status.harnessName })}
        </p>
      )}
      {AGENT_RESET_CATEGORIES.map((category) => (
        <CategoryBlock
          key={category}
          category={category}
          agent={status.name}
          known={preview.known.includes(category)}
          items={preview.items.filter((item) => item.category === category)}
          places={{ folder: preview.folder, home: preview.home }}
          checked={picked[category]}
          disabled={disabled}
          onChange={(on) => onPick(category, on)}
        />
      ))}
      <p className="text-xs text-secondary" data-wrap="">
        {preview.kept.length > 0
          ? t('agents.resetEnv.keptNamed', {
              names: preview.kept.join(t('agents.resetEnv.separator')),
            })
          : t('agents.resetEnv.kept')}
      </p>
    </>
  )
}

function CategoryBlock({
  category,
  agent,
  known,
  items,
  places,
  checked,
  disabled,
  onChange,
}: {
  category: AgentResetCategory
  agent: string
  known: boolean
  items: AgentResetItem[]
  places: Places
  checked: boolean
  disabled: boolean
  onChange: (on: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const empty = items.length === 0
  return (
    <div className="k-reset-group">
      <label className="flex items-start gap-2.5 text-left">
        {/* Huli: nothing to tick where nothing would be removed. */}
        {empty ? (
          <span aria-hidden className="mt-0.5 size-4 shrink-0" />
        ) : (
          <Checkbox
            checked={checked}
            disabled={disabled}
            onCheckedChange={(value) => onChange(value === true)}
            className="mt-0.5"
          />
        )}
        <span className="flex flex-col gap-px">
          <span className="text-ui font-medium text-primary">
            {t(`agents.resetEnv.${category}.name`)}
          </span>
          <span className="text-xs text-secondary">{t(`agents.resetEnv.${category}.hint`)}</span>
        </span>
      </label>
      {!empty && <ItemList items={items} places={places} />}
      {(!known || empty) && (
        <p className="k-reset-none">
          {!known
            ? t(
                category === 'credentials'
                  ? 'agents.resetEnv.unknownCredentials'
                  : 'agents.resetEnv.unknown',
                { name: agent },
              )
            : t('agents.resetEnv.nothing')}
        </p>
      )}
    </div>
  )
}

function ItemList({ items, places }: { items: AgentResetItem[]; places: Places }) {
  return (
    <ul className="k-reset-items">
      {linesOf(items).map(({ item, files }) => (
        <li
          key={`${item.kind}:${item.path}`}
          className="k-reset-item"
          data-problem={item.problem ? '' : undefined}
        >
          <ItemText item={item} files={files} places={places} />
        </li>
      ))}
    </ul>
  )
}

function ItemText({
  item,
  files = 1,
  places,
}: {
  item: AgentResetItem
  files?: number
  places: Places
}) {
  const { t } = useTranslation('settings')
  const separator = t('agents.resetEnv.separator')
  const where = shortPath(item.path, places)
  const sep = item.path.includes('\\') ? '\\' : '/'
  let text: ReactNode
  switch (item.kind) {
    case 'file':
      text = <code title={item.path}>{where}</code>
      break
    case 'folder':
      text = <code title={item.path}>{`${where}${sep}`}</code>
      break
    case 'keys': {
      const keys = (item.keys ?? []).join(separator)
      const file =
        files > 1
          ? t('agents.resetEnv.files', {
              folder: `${shortPath(parentOf(item.path), places)}${sep}`,
              count: files,
            })
          : where
      text = (
        <code title={`${item.path}\n${keys}`}>
          {item.problem
            ? t('agents.resetEnv.unreadable', { file })
            : t('agents.resetEnv.keys', { file, keys })}
        </code>
      )
      break
    }
    case 'secret':
      text = (
        <code data-plain="">
          {t(`agents.resetEnv.store.${item.store ?? 'keychain'}`, { name: item.path })}
        </code>
      )
      break
    case 'logout':
      text = (
        <code data-plain="">
          {item.path === 'logout'
            ? t('agents.resetEnv.logoutAgent')
            : t('agents.resetEnv.logout', { command: item.path })}
        </code>
      )
      break
    case 'api-key':
      text = (
        <code data-plain="" title={item.path}>
          {t('agents.resetEnv.apiKey', { file: where })}
        </code>
      )
      break
    case 'kite-key':
      text = <code data-plain="">{t('agents.resetEnv.kiteKey', { name: item.path })}</code>
      break
  }
  return (
    <>
      {text}
      {item.bytes !== null && <span>{bytes(item.bytes)}</span>}
    </>
  )
}

function ResultBody({ result, places }: { result: AgentResetResult; places: Places }) {
  const { t } = useTranslation('settings')
  return (
    <>
      <Notice
        variant={result.failed.length > 0 ? 'warning' : 'success'}
        title={
          result.failed.length > 0
            ? t('agents.resetEnv.partly', {
                count: result.removed.length,
                failed: result.failed.length,
              })
            : t('agents.resetEnv.finished', { count: result.removed.length })
        }
      >
        {t('agents.resetEnv.afterHint')}
      </Notice>
      {result.failed.length > 0 && (
        <ul className="k-reset-items">
          {result.failed.map(({ item, error }) => (
            <li
              key={`${item.category}:${item.kind}:${item.path}`}
              className="k-reset-item"
              data-problem=""
            >
              <ItemText item={item} places={places} />
              <span title={error}>{error}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
