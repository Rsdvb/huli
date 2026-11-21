// Huli: Settings > Agents > an agent > Remove: takes the agent out of Kite and, when asked, also
// uninstalls its program from its host the way it was installed and deletes its own data there.
// The host plans both when the dialog opens, so the dialog names exactly what goes, and the run
// takes only the steps shown. Kite's own sessions of the agent stay either way.

import { useEffect, useState, type ReactNode } from 'react'
import { Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentStatus } from '@shared/agent-host'
import type {
  AgentRemovalPreview,
  AgentRemovalResult,
  RemovalKept,
  RemovalStep,
} from '@shared/agent-removal'
import { Icon } from '@renderer/components/affect/app-shell'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { Spinner } from '@renderer/components/ui/spinner'
import { bytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import {
  clearRemovalProgress,
  useRemovalProgressOf,
  type StepState,
} from '@renderer/stores/agent-removal'
import { useHostScope } from '@renderer/stores/host-scope'
import { openAgentSettings } from '@renderer/stores/view'
import { shortPath, type Places } from './host-places'
import { SetButton, Skel } from './controls'
import { Notice } from './rows'
import {
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
} from './settings-dialog'

type Phase =
  | { kind: 'loading' }
  /** The plan could not be read, as from a host too old to make one; removing still works. */
  | { kind: 'unplanned'; error: string }
  | { kind: 'ready'; preview: AgentRemovalPreview }
  | { kind: 'running'; preview: AgentRemovalPreview }
  | { kind: 'done'; preview: AgentRemovalPreview | null; result: AgentRemovalResult | null }

/** The agent page's Remove dialog, read afresh each time it opens. */
export function RemoveAgentDialog({
  status,
  open,
  onOpenChange,
}: {
  status: AgentStatus
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return open ? <RemoveDialog status={status} onClose={() => onOpenChange(false)} /> : null
}

function RemoveDialog({ status, onClose }: { status: AgentStatus; onClose: () => void }) {
  const { request, api, hostId, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [program, setProgram] = useState(false)
  const [data, setData] = useState(false)
  const [trash, setTrash] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reads, setReads] = useState(0)
  /** Null until a run took something; then whether any run took the program. */
  const [took, setTook] = useState<boolean | null>(null)
  const progress = useRemovalProgressOf(hostId, status.id)

  useEffect(() => {
    let current = true
    request('agents.removalPreview', { agentId: status.id }).then(
      (preview) => current && setPhase({ kind: 'ready', preview }),
      (e: unknown) => current && setPhase({ kind: 'unplanned', error: errorMessage(e) }),
    )
    return () => {
      current = false
    }
  }, [request, status.id, reads])

  const preview =
    phase.kind === 'ready' || phase.kind === 'running' || phase.kind === 'done'
      ? phase.preview
      : null
  const programOn = program && !!preview && canUninstall(preview)
  const dataOn = data && !!preview && preview.data.steps.length > 0
  const chosen = [
    ...(programOn && preview ? preview.program.steps : []),
    ...(dataOn && preview ? preview.data.steps : []),
  ]
  const total = chosen.reduce((sum, step) => sum + (step.bytes ?? 0), 0)
  const moves = chosen.some((step) => step.kind !== 'command' && step.kind !== 'secret')
  const busy = (preview?.busy.length ?? 0) > 0 && chosen.length > 0
  const running = phase.kind === 'running'

  // The agent leaves Kite once the dialog is done, so its page stays while the result shows.
  const finish = async (uninstalled: boolean): Promise<void> => {
    try {
      await api.settings.removeAgent(status.id, false)
      if (uninstalled) {
        await useSettingsStore.getState().update({
          agents: { [status.harnessId]: { uninstalled: true, enabled: false } },
        })
      }
      onClose()
      openAgentSettings(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const run = async (): Promise<void> => {
    setError(null)
    if (chosen.length === 0 || !preview) {
      setPhase({ kind: 'done', preview, result: null })
      await finish(took === true)
      return
    }
    clearRemovalProgress(hostId, status.id)
    setPhase({ kind: 'running', preview })
    try {
      const result = await request('agents.removeFromComputer', {
        agentId: status.id,
        steps: chosen.map((step) => step.id),
        trash: trash && moves,
      })
      const program = result.done.some((step) => step.part === 'program')
      if (result.done.length > 0) setTook((before) => before === true || program)
      setPhase({ kind: 'done', preview, result })
    } catch (e) {
      setError(errorMessage(e))
      setPhase({ kind: 'ready', preview })
    }
  }

  // Once a run took something, closing the dialog removes the agent, as Done does.
  const close = (): void => {
    if (running) return
    const program = phase.kind === 'done' && !!phase.result?.done.some((s) => s.part === 'program')
    if (took !== null || program) {
      void finish(took === true || program)
      return
    }
    onClose()
  }

  const places: Places = { folder: null, home: preview?.home ?? null }
  const confirmKey =
    programOn && dataOn
      ? 'agents.remove.confirmBoth'
      : programOn
        ? 'agents.remove.confirmProgram'
        : dataOn
          ? 'agents.remove.confirmData'
          : 'agents.remove.button'

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <SettingsDialogContent className="sm:max-w-150">
        <SettingsDialogHeader title={t('agents.remove.title', { name: status.name })}>
          {t('agents.remove.body')}
        </SettingsDialogHeader>
        <SettingsDialogBody>
          {phase.kind === 'loading' && (
            <div className="flex flex-col gap-3" aria-busy>
              <Skel width="60%" />
              <Skel width="90%" />
              <Skel width="75%" />
            </div>
          )}
          {phase.kind === 'unplanned' && (
            <Notice
              variant="warning"
              title={t('agents.remove.loadFailed')}
              action={
                <SetButton
                  variant="secondary"
                  onClick={() => {
                    setPhase({ kind: 'loading' })
                    setReads((count) => count + 1)
                  }}
                >
                  {t('common:actions.retry')}
                </SetButton>
              }
            >
              {phase.error}
            </Notice>
          )}
          {preview && phase.kind !== 'done' && (
            <PlanBody
              status={status}
              preview={preview}
              places={places}
              program={programOn}
              data={dataOn}
              trash={trash}
              moves={moves}
              disabled={running}
              progress={running ? progress : null}
              onProgram={setProgram}
              onData={setData}
              onTrash={setTrash}
              onCheckAgain={() => {
                setPhase({ kind: 'loading' })
                setReads((count) => count + 1)
              }}
            />
          )}
          {phase.kind === 'done' && phase.result && (
            <ResultBody
              status={status}
              preview={phase.preview}
              result={phase.result}
              places={places}
            />
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </SettingsDialogBody>
        <SettingsDialogFooter
          start={
            phase.kind !== 'done' && total > 0
              ? t('agents.remove.total', { size: bytes(total) })
              : null
          }
        >
          {phase.kind === 'done' ? (
            <>
              {(phase.result?.failed.length ?? 0) > 0 && (
                // The agent is still there, so what did not go can be tried again, as without
                // the trash on a host that has none.
                <SetButton
                  size="md"
                  variant="ghost"
                  onClick={() => {
                    setPhase({ kind: 'loading' })
                    setReads((count) => count + 1)
                  }}
                >
                  {t('common:actions.retry')}
                </SetButton>
              )}
              <SetButton size="md" variant="primary" onClick={close}>
                {t('agents.remove.done')}
              </SetButton>
            </>
          ) : (
            <>
              <DialogClose render={<SetButton size="md" variant="ghost" />} disabled={running}>
                {t('common:actions.cancel')}
              </DialogClose>
              <SetButton
                size="md"
                variant="destructive"
                loading={running}
                disabled={phase.kind === 'loading' || running || busy}
                onClick={() => void run()}
              >
                {t(confirmKey)}
              </SetButton>
            </>
          )}
        </SettingsDialogFooter>
      </SettingsDialogContent>
    </Dialog>
  )
}

function canUninstall(preview: AgentRemovalPreview): boolean {
  return !preview.program.blocked && preview.program.steps.length > 0
}

function PlanBody({
  status,
  preview,
  places,
  program,
  data,
  trash,
  moves,
  disabled,
  progress,
  onProgram,
  onData,
  onTrash,
  onCheckAgain,
}: {
  status: AgentStatus
  preview: AgentRemovalPreview
  places: Places
  program: boolean
  data: boolean
  trash: boolean
  moves: boolean
  disabled: boolean
  progress: Record<string, StepState> | null
  onProgram: (on: boolean) => void
  onData: (on: boolean) => void
  onTrash: (on: boolean) => void
  onCheckAgain: () => void
}) {
  const { t } = useTranslation('settings')
  const again = (
    <SetButton variant="secondary" onClick={onCheckAgain} disabled={disabled}>
      {t('agents.remove.checkAgain')}
    </SetButton>
  )
  const { program: plan } = preview
  const manual = plan.manual
  const kite = plan.steps.some((step) => step.kite)
  const method = plan.method ? t(`agents.remove.program.methods.${plan.method}`) : null
  const programHint = method
    ? t(kite ? 'agents.remove.program.viaKite' : 'agents.remove.program.via', { method })
    : t(kite ? 'agents.remove.program.kiteOnly' : 'agents.remove.program.hint')
  const programLine = plan.blocked
    ? t('agents.remove.program.blocked', {
        agents: plan.blocked.join(t('agents.resetEnv.separator')),
        harness: status.harnessName,
      })
    : plan.steps.length === 0 && !manual
      ? t('agents.remove.program.nothing')
      : null
  return (
    <>
      {preview.busy.length > 0 && (program || data) && (
        <Notice
          variant="warning"
          title={t('agents.remove.busy', { count: preview.busy.length })}
          action={again}
        >
          {preview.busy
            .map((session) => session.title ?? t('agents.resetEnv.untitled'))
            .join(' · ')}
        </Notice>
      )}
      {preview.outside > 0 && data && (
        <Notice
          variant="warning"
          title={t('agents.resetEnv.outside', { count: preview.outside })}
          action={again}
        >
          {t('agents.resetEnv.outsideHint')}
        </Notice>
      )}
      <Option
        name={t('agents.remove.program.name')}
        hint={programHint}
        checked={program}
        disabled={disabled || !canUninstall(preview)}
        onChange={onProgram}
      >
        {plan.steps.length > 0 && !plan.blocked && (
          <StepList steps={plan.steps} places={places} progress={progress} />
        )}
        {programLine && <p className="k-reset-none">{programLine}</p>}
        {manual && !plan.blocked && (
          <div className="k-reset-none flex flex-col gap-1" data-wrap="">
            <span>
              {t(`agents.remove.program.manual.${manual.reason}`, {
                path: shortPath(manual.path, places),
                method: plan.method ? t(`agents.remove.program.methods.${plan.method}`) : '',
              })}
            </span>
            {manual.command && (
              <code className="font-mono break-all text-secondary" data-selectable="">
                {manual.command}
              </code>
            )}
          </div>
        )}
        {!plan.blocked &&
          plan.notes.map((note) => (
            <p key={note} className="k-reset-none" data-wrap="">
              {t(`agents.remove.program.notes.${note}`)}
            </p>
          ))}
      </Option>
      <Option
        name={t('agents.remove.data.name')}
        hint={t('agents.remove.data.hint')}
        checked={data}
        disabled={disabled || preview.data.steps.length === 0}
        onChange={onData}
        danger
      >
        {preview.data.steps.length > 0 && (
          <StepList steps={preview.data.steps} places={places} progress={progress} />
        )}
        {preview.data.steps.length === 0 && (
          <p className="k-reset-none">
            {preview.data.known
              ? t('agents.remove.data.nothing')
              : t('agents.remove.data.unknown', { name: status.harnessName })}
          </p>
        )}
        {preview.data.kept.length > 0 && (
          <KeptList kept={preview.data.kept} places={places} harness={status.harnessName} />
        )}
        {preview.data.notes.map((note) => (
          <p key={note} className="k-reset-none" data-wrap="">
            {t(`agents.remove.data.notes.${note}`)}
          </p>
        ))}
      </Option>
      {moves && (
        <label className="flex items-start gap-2.5 text-left">
          <Checkbox
            checked={trash}
            disabled={disabled}
            onCheckedChange={(value) => onTrash(value === true)}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-px">
            <span className="text-ui font-medium text-primary">
              {t(
                preview.platform === 'darwin'
                  ? 'agents.remove.trashMac'
                  : preview.platform === 'win32'
                    ? 'agents.remove.trashWindows'
                    : 'agents.remove.trashLinux',
              )}
            </span>
            <span className="text-xs text-secondary">{t('agents.remove.trashHint')}</span>
          </span>
        </label>
      )}
      <p className="text-xs text-secondary" data-wrap="">
        {t('agents.remove.sessionsStay')}
      </p>
    </>
  )
}

function Option({
  name,
  hint,
  checked,
  disabled,
  danger,
  onChange,
  children,
}: {
  name: string
  hint: string
  checked: boolean
  disabled: boolean
  danger?: boolean
  onChange: (on: boolean) => void
  children: ReactNode
}) {
  return (
    <div className="k-reset-group">
      <label className="flex items-start gap-2.5 text-left">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onChange(value === true)}
          className="mt-0.5"
        />
        <span className="flex flex-col gap-px">
          <span
            className={
              danger ? 'text-ui font-medium text-danger' : 'text-ui font-medium text-primary'
            }
          >
            {name}
          </span>
          <span className="text-xs text-secondary">{hint}</span>
        </span>
      </label>
      {children}
    </div>
  )
}

function StepList({
  steps,
  places,
  progress,
}: {
  steps: RemovalStep[]
  places: Places
  progress: Record<string, StepState> | null
}) {
  return (
    <ul className="k-reset-items">
      {steps.map((step) => {
        const state = progress?.[step.id]
        return (
          <li
            key={step.id}
            className="k-reset-item"
            data-problem={state?.state === 'failed' ? '' : undefined}
          >
            <StepText step={step} places={places} />
            {step.bytes !== null && <span>{bytes(step.bytes)}</span>}
            {progress && <StepMark state={state} />}
          </li>
        )
      })}
    </ul>
  )
}

function StepMark({ state }: { state: StepState | undefined }) {
  if (!state) return <span className="inline-flex size-3.5" aria-hidden />
  if (state.state === 'running') return <Spinner className="size-3.5 text-secondary" />
  return (
    <span
      className={state.state === 'done' ? 'inline-flex text-success' : 'inline-flex text-danger'}
      title={state.error}
    >
      <Icon icon={state.state === 'done' ? Tick02Icon : Cancel01Icon} size={14} />
    </span>
  )
}

function StepText({ step, places }: { step: RemovalStep; places: Places }) {
  const { t } = useTranslation('settings')
  const sep = step.path.includes('\\') ? '\\' : '/'
  const where = shortPath(step.path, places)
  switch (step.kind) {
    case 'command':
      return (
        <code title={step.path} data-selectable="">
          {step.path}
        </code>
      )
    case 'file':
      return <code title={step.path}>{where}</code>
    case 'folder':
      return (
        <code title={step.path}>
          {step.kite ? t('agents.remove.kite', { path: `${where}${sep}` }) : `${where}${sep}`}
        </code>
      )
    case 'contents':
      return (
        <code title={step.path}>
          {t('agents.remove.contents', {
            path: `${where}${sep}`,
            names: (step.except ?? []).join(t('agents.resetEnv.separator')),
          })}
        </code>
      )
    case 'secret':
      return (
        <code data-plain="">
          {t(`agents.resetEnv.store.${step.store ?? 'keychain'}`, { name: step.path })}
        </code>
      )
  }
}

function KeptList({
  kept,
  places,
  harness,
}: {
  kept: RemovalKept[]
  places: Places
  harness: string
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="k-reset-none flex flex-col gap-0.5" data-wrap="">
      <span>{t('agents.remove.data.kept')}</span>
      {kept.map((item) => (
        <span key={`${item.store ?? 'path'}:${item.path}`}>
          {item.store
            ? t(`agents.resetEnv.store.${item.store}`, { name: item.path })
            : shortPath(item.path, places)}
          {' · '}
          {t(`agents.remove.data.keptReason.${item.reason}`, { harness })}
        </span>
      ))}
    </div>
  )
}

const DONE: StepState = { state: 'done' }

function ResultBody({
  status,
  preview,
  result,
  places,
}: {
  status: AgentStatus
  preview: AgentRemovalPreview | null
  result: AgentRemovalResult
  places: Places
}) {
  const { t } = useTranslation('settings')
  const failed = result.failed.length
  const manual = preview?.program.manual
  return (
    <>
      <Notice
        variant={failed > 0 ? 'warning' : 'success'}
        title={
          failed > 0
            ? t('agents.remove.partly', { count: result.done.length, failed })
            : t('agents.remove.finished', { count: result.done.length })
        }
      >
        {failed > 0 ? t('agents.remove.partlyHint') : t('agents.remove.finishedHint')}
      </Notice>
      {result.done.length > 0 && (
        <StepList
          steps={result.done}
          places={places}
          progress={Object.fromEntries(result.done.map((step) => [step.id, DONE]))}
        />
      )}
      {failed > 0 && (
        <ul className="k-reset-items">
          {result.failed.map(({ step, error }) => (
            <li key={step.id} className="k-reset-item" data-problem="">
              <StepText step={step} places={places} />
              <span title={error}>{error}</span>
            </li>
          ))}
        </ul>
      )}
      {manual && result.done.some((step) => step.part === 'program') && (
        <p className="text-xs text-secondary" data-wrap="">
          {t(`agents.remove.program.manual.${manual.reason}`, {
            path: shortPath(manual.path, places),
            method: preview?.program.method
              ? t(`agents.remove.program.methods.${preview.program.method}`)
              : '',
          })}
        </p>
      )}
      <p className="text-xs text-secondary" data-wrap="">
        {t('agents.remove.afterHint', { name: status.name })}
      </p>
    </>
  )
}
