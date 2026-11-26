// Settings > Harnesses: the programs agents run on, how each is installed and updated, the program
// that runs and the agents that use it. Accounts and sign-in are Settings > Agents'.

import { useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  Cancel01Icon,
  Download04Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type {
  AgentStatus,
  AgentTask,
  EnvironmentInfo,
  NodeRuntimeInfo,
  ProgramMethod,
  VersionMoveReason,
} from '@shared/agent-host'
import { OWN_INTERFACE_HARNESSES } from '@shared/agents'
import { harnessOf, type HarnessId } from '@shared/thread'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
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
import { Checkbox } from '@renderer/components/ui/checkbox'
import { NodeInstallAction } from '@renderer/features/agents/node-install'
import { needsNode } from '@renderer/features/agents/node-runtime'
import {
  cliOutdated,
  listedInstalled,
  programUnchecked,
  readiness,
  showsCurrent,
} from '@renderer/features/agents/readiness'
import {
  harnessProblem,
  programCopy,
  programHere,
  type HarnessProblem,
} from '@renderer/features/agents/harness-problem'
import { adapterOnlyUpdate } from '@renderer/features/agents/updates'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { updateOffer } from '@renderer/features/updates/agent-updates'
import { forgetHarnessUpdate, updateHarnesses } from '@renderer/features/updates/harness-updates'
import { mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import {
  awaitsPackage,
  harnessStatuses,
  hasProgram,
  usableAgents,
  without,
  type AgentsStoreHook,
} from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useUpdatesStore } from '@renderer/stores/updates'
import { openAgentSettings, openHarnessSettings } from '@renderer/stores/view'
import {
  ConfigFrame,
  DismissButton,
  Fact,
  Log,
  LogCopyButton,
  MovedAccountsNotice,
  ProblemFixButton,
  TaskLog,
  WithCode,
} from './agent-parts'
import {
  installKind,
  installRoute,
  openInstall,
  startInstall,
  type InstallKind,
  type SettingsHook,
} from './harness-install'
import { harnessVersion, useAction, VENDORS } from './agent-helpers'
import { uninstallHarness } from './harness-uninstall'
import {
  CommandLine,
  ControlError,
  CopyAction,
  DangerButton,
  Pill,
  SetButton,
  SettingSwitch,
  Spin,
} from './controls'
import { PathActions, PathLine } from './places'
import {
  FlashMark,
  GroupLabel,
  ItemPageHeader,
  ItemLine,
  ItemRow,
  Notice,
  RowFrame,
  RowGroup,
  RowText,
} from './rows'
import { environmentText } from './environment-text'
import { entryText } from './model'
import { useApply } from './use-apply'

/** A check the user started counts as just done for this long, then it reads as "checked ago". */
const JUST_CHECKED_MS = 60_000

type SettingsT = ReturnType<typeof useTranslation<'settings'>>['t']

/**
 * Checks every harness for updates. The store records a failure as `updateCheck.error`, so reject
 * as well, which keeps a failed check from showing the icon's check.
 */
async function checkForUpdates(agents: AgentsStoreHook): Promise<void> {
  await agents.getState().checkUpdates()
  const error = agents.getState().updateCheck.error
  if (error) throw new Error(error)
}

function startUpdate(agents: AgentsStoreHook, harness: HarnessId): void {
  void agents.getState().update(harness)
}

/**
 * Updates the user's own program, which replaces what the harness's sessions run. This computer's
 * waits for its running sessions to end, as the update card's does; another host's runs at once.
 */
function startCliUpdate(agents: AgentsStoreHook, harness: HarnessId, hostId: string | null): void {
  if (hostId === null) updateHarnesses([harness])
  else void agents.getState().updateCli(harness)
}

function cancelTask(agents: AgentsStoreHook, harness: HarnessId): void {
  void agents.getState().cancelTask(harness)
}

/** Runs a failed task again, by the route it took; an update with a route is the program's own. */
function retryTask(
  agents: AgentsStoreHook,
  settings: SettingsHook,
  harness: HarnessId,
  task: AgentTask,
  hostId: string | null,
): void {
  if (task.kind === 'update') {
    if (task.method) startCliUpdate(agents, harness, hostId)
    else startUpdate(agents, harness)
  } else void startInstall(agents, settings, harness, installRoute(task))
}

/** Whether this computer's update of the harness waits for its running sessions to end. */
function useWaitingUpdate(status: AgentStatus): boolean {
  const { hostId } = useHostScope()
  return useUpdatesStore((s) => hostId === null && s.harnessWaiting.includes(status.id))
}

/** How many of this computer's sessions of the harness have a turn running now. */
function useRunningSessions(harness: HarnessId): number {
  return useSessionsStore(
    (s) =>
      Object.values(s.byId).filter(
        (session) =>
          hostOfSession(session) === null &&
          harnessOf(session.agentId) === harness &&
          (session.status === 'running' || session.status === 'awaiting_permission'),
      ).length,
  )
}

function methodName(t: SettingsT, method: ProgramMethod): string {
  return t(`harnesses.methods.${method}`)
}

/** The small x inside a pill that cancels its task or dismisses its failure. */
function PillClose({
  label,
  tone,
  onClick,
}: {
  label: string
  tone: 'info' | 'error'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="k-pill-close"
      data-tone={tone}
    >
      <Icon icon={Cancel01Icon} size={10} />
    </button>
  )
}

/**
 * The end of a harness's row: how an install or update is going, the version that is out with
 * Update, Install, or that it is up to date once a check has run.
 */
function HarnessState({ status }: { status: AgentStatus }) {
  const { hostId, useAgentsStore, useSettingsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const updated = useAgentsStore((s) => s.updated[status.id])
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  const pending = useAgentsStore((s) => s.pending[status.id])
  const uninstalling = useAgentsStore((s) => !!s.uninstalling[status.harnessId])
  const waiting = useWaitingUpdate(status)
  const task: AgentTask | null = status.task
  const harness = status.harnessId
  if (uninstalling) {
    return (
      <span className="k-end k-muted">
        <Spin />
        {t('harnesses.uninstall.working')}
      </span>
    )
  }
  if (task?.state === 'running' || status.state === 'installing' || pending) {
    return (
      <span className="k-end k-muted">
        <Spin />
        {t(
          (task?.kind ?? pending) === 'update'
            ? 'agents.update.updating'
            : 'agents.install.installing',
        )}
      </span>
    )
  }
  // A retry of a failed update waits like any other, so the failure no longer shows.
  if (waiting) {
    return <span className="k-end k-muted">{t('harnesses.cliUpdateWaiting.short')}</span>
  }
  if (task?.state === 'failed') {
    const updating = task.kind === 'update'
    return (
      <span className="ui-ss-badge k-badge-error">
        <button
          type="button"
          title={task.error ?? undefined}
          onClick={() => retryTask(useAgentsStore, useSettingsStore, harness, task, hostId)}
          className="k-badge-action"
        >
          <Icon icon={RefreshIcon} size={12} />
          {t(updating ? 'agents.update.failed' : 'agents.install.failed')}
        </button>
        <PillClose
          label={t('agents.task.dismiss')}
          tone="error"
          onClick={() => cancelTask(useAgentsStore, harness)}
        />
      </span>
    )
  }
  if (taskError) {
    return (
      <span className="ui-ss-badge k-badge-error" title={taskError.message}>
        <span className="k-badge-action">
          <Icon icon={AlertCircleIcon} size={12} />
          {t(
            taskError.kind === 'update'
              ? 'agents.update.failedTitle'
              : 'agents.install.failedTitle',
          )}
        </span>
        <PillClose
          label={t('agents.task.dismiss')}
          tone="error"
          onClick={() => cancelTask(useAgentsStore, harness)}
        />
      </span>
    )
  }
  if (status.uninstalled) {
    return (
      <SetButton onClick={() => void openInstall(harness, hostId)}>
        {t('agents.install.button')}
      </SetButton>
    )
  }
  const cliUpdate = status.cli?.update
  // The version the page names: the program's, or the package's alone when only it moves.
  const offer = updateOffer(status)
  if (cliUpdate || status.update) {
    return (
      <>
        {offer && (
          <Pill tone="attention">
            {t(
              !offer.package?.versions
                ? 'harnesses.versionOut'
                : status.package?.isSdk
                  ? 'agents.update.sdkReleased'
                  : packageIsProgram(status)
                    ? 'agents.update.released'
                    : 'agents.update.adapterReleased',
              { version: offer.to },
            )}
          </Pill>
        )}
        <SetButton
          variant="primary"
          title={cliUpdate?.command}
          // The user's own CLI changes outside Kettu, so its update runs from the page that shows
          // the command; Kettu's own package updates here.
          onClick={() =>
            cliUpdate ? openHarnessSettings(harness) : startUpdate(useAgentsStore, harness)
          }
        >
          {t('agents.update.button')}
        </SetButton>
      </>
    )
  }
  if (updated) return <StateDot label={t('agents.update.done')} />
  // A harness on the machine gets the fix for why it cannot run; one still to install keeps the
  // same Install as the rest, whose window says what it needs, unless no version fits at all.
  const problem = harnessProblem(status)
  if (problem?.reason.kind === 'no-version') return null
  if (problem && problem.fix !== 'install' && programHere(status)) {
    return problem.fix && <ProblemFixButton status={status} fix={problem.fix} />
  }
  if (status.versionWarning) {
    const { broken, supported } = status.versionWarning
    return (
      <Pill tone="attention">
        {t(
          broken || !supported
            ? 'harnesses.versionWarning.pillBroken'
            : 'harnesses.versionWarning.pillUnsupported',
        )}
      </Pill>
    )
  }
  const kind = installKind(status)
  // The SDK installs itself on first use beside the user's CLI.
  if (kind === 'package' && status.package?.isSdk) return null
  if (kind) {
    return (
      <SetButton onClick={() => void openInstall(harness, hostId)}>
        {t('agents.install.button')}
      </SetButton>
    )
  }
  // A harness that fails to start is no picture of health, whatever its version.
  return showsCurrent(status) && status.state !== 'failed' ? (
    <StateDot label={t('agents.update.upToDate')} />
  ) : null
}

/**
 * Kettu's package is the harness's program itself, as DeepSeek Harness's is, not an adapter; an
 * older host says it of no package, but DeepSeek Harness's always is.
 */
function packageIsProgram(status: AgentStatus): boolean {
  return !!status.package?.isCli || status.harnessId === 'deepseek'
}

/** A state in the success color's dot, such as Up to date. */
function StateDot({ label }: { label: string }) {
  return (
    <span className="ui-ss-badge" data-tone="ok">
      {label}
    </span>
  )
}

/** One harness in the list: its version and how many agents use it, or what it needs first. */
export function HarnessListItem({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'agents'])
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  const uninstallError = useAgentsStore((s) => s.uninstallErrors[status.harnessId])
  const agents = useAgentsStore(
    (s) => usableAgents(s.order, s.byId).filter((a) => a.harnessId === status.harnessId).length,
  )
  const r = readiness(status)
  const problem = harnessProblem(status)
  const version = harnessVersion(status)
  const kind = installKind(status)
  const summary: ReactNode =
    status.task?.state === 'running' ? (
      (status.task.progress.at(-1) ?? status.task.command)
    ) : status.state === 'installing' ? (
      (status.progress.at(-1) ?? t('agents.install.installing'))
    ) : status.task?.state === 'failed' ? (
      <span className="k-danger">{status.task.error}</span>
    ) : taskError ? (
      <span className="k-danger">{taskError.message}</span>
    ) : uninstallError ? (
      <span className="k-danger">{uninstallError}</span>
    ) : status.uninstalled ? (
      t('harnesses.removedLine')
    ) : problem?.reason.kind === 'too-old' ? (
      [version, problem.label].filter(Boolean).join(' · ')
    ) : awaitsPackage(status) && status.package?.isSdk ? (
      t('agents.installsOnFirstUse')
    ) : kind === 'package' && status.package?.isSdk ? (
      // Beside the user's own CLI the SDK installs itself on the first start.
      [version, t('harnesses.sdkOnFirstUse')].filter(Boolean).join(' · ')
    ) : problem ? (
      <WithCode text={problem.text} />
    ) : r.kind === 'failed' ? (
      <WithCode text={r.message} />
    ) : (
      [
        version,
        programCopy(status),
        agents > 0 ? t('harnesses.agentCount', { count: agents }) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    )
  return (
    <ItemRow
      item={status.harnessId}
      label={status.harnessName}
      onOpen={() => openHarnessSettings(status.harnessId)}
      tile={<AgentTile agent={status.harnessId} size={32} />}
      name={
        <span className="k-name" title={status.harnessName}>
          {status.harnessName}
        </span>
      }
      right={<HarnessState status={status} />}
    >
      {summary && <ItemLine>{summary}</ItemLine>}
    </ItemRow>
  )
}

/** The Installed group's own action: check every harness for updates, and when it last did. */
export function HarnessGroupActions() {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const check = useAgentsStore((s) => s.updateCheck)
  const harnesses = useAgentsStore(useShallow((s) => harnessStatuses(s.order, s.byId)))
  const refresh = useRefresh({ busy: check.running })
  const now = useNow()
  const checkable = harnesses.some((h) => h.package || h.updateCheckedAt !== null || h.cli)
  const lastAt = Math.max(0, ...harnesses.map((h) => h.updateCheckedAt ?? 0)) || null
  const pending = harnesses.filter((h) => h.update || h.cli?.update).length
  const meta: ReactNode =
    refresh.phase === 'turning' ? null : check.error ? (
      <span className="k-error" title={check.error}>
        {t('agents.update.checkFailed')}
      </span>
    ) : check.finishedAt && now - check.finishedAt < JUST_CHECKED_MS ? (
      pending > 0 ? (
        t('agents.update.justChecked', { count: pending })
      ) : (
        t('agents.update.allCurrent')
      )
    ) : lastAt ? (
      pending > 0 ? (
        t('agents.update.checkedAgoUpdates', { ago: mediumAgo(lastAt, now), count: pending })
      ) : (
        t('agents.update.checkedAgo', { ago: mediumAgo(lastAt, now) })
      )
    ) : null
  return (
    <>
      {meta && <span className="k-muted k-head-meta">{meta}</span>}
      {checkable && (
        <SetButton
          loading={refresh.phase === 'turning'}
          onClick={() => void refresh.run(() => checkForUpdates(useAgentsStore)).catch(() => {})}
        >
          {t('agents.update.check')}
        </SetButton>
      )}
    </>
  )
}

/** A harness's own page: its version and updates, the program that runs, and its agents. */
export function HarnessPage({ harnessId }: { harnessId: HarnessId }) {
  const { useAgentsStore } = useHostScope()
  const status = useAgentsStore((s) => s.byId[harnessId])
  if (!status) return <HarnessPageHeader status={null} />
  return <HarnessPageBody status={status} />
}

function HarnessPageHeader({ status }: { status: AgentStatus | null }) {
  const { t } = useTranslation('settings')
  return (
    <ItemPageHeader
      back={t('sections.harnesses')}
      onBack={() => openHarnessSettings(null)}
      item={status?.harnessId ?? 'harness'}
      icon={status && <AgentTile agent={status.harnessId} size={42} />}
      title={status?.harnessName ?? null}
      subtitle={status && <HarnessPageLine status={status} />}
    />
  )
}

/** The line under a harness's title: who makes it and how Kettu drives it. */
function HarnessPageLine({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const vendor = VENDORS[status.harnessId]
  const adapter = status.package?.name.split('/').at(-1)
  const connection = vendor
    ? status.package?.isSdk || OWN_INTERFACE_HARNESSES.includes(status.harnessId)
      ? t('agents.ownInterface', { vendor })
      : adapter
        ? t('agents.via', { vendor, adapter })
        : t('agents.direct', { vendor })
    : null
  return connection && <span className="k-name">{connection}</span>
}

function HarnessPageBody({ status }: { status: AgentStatus }) {
  const { request, useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const environment = useAgentsStore((s) => s.environment)
  const uninstalling = useAgentsStore((s) => !!s.uninstalling[status.harnessId])
  const [act, busy, error] = useAction()
  const r = readiness(status)
  const problem = harnessProblem(status)
  const installed = listedInstalled(status) || programHere(status)
  // A missing program has no version yet, nor has Kettu's package while it waits or installs;
  // only the SDK installs itself beside the user's program.
  const pkg = status.package
  const packageMissing = !!pkg && !pkg.installed && !pkg.isSdk
  const onMachine = hasProgram(status) && !packageMissing
  const kind = installKind(status)
  // Its first install runs from this page too, which no install kind covers while it runs, as
  // Claude Code's SDK does right after its program.
  const notice: InstallKind | null =
    kind ?? (pkg && !pkg.installed && status.state === 'installing' ? 'package' : null)
  // Installing fixes a missing harness, and the version notices a program too old.
  const ownNotice =
    problem && problem.fix !== 'install' && problem.reason.kind !== 'too-old' ? problem : null
  return (
    <div>
      <HarnessPageHeader status={status} />

      <div>
        {r.kind !== 'failed' && r.kind !== 'missing' && status.detail && (
          <p className="ui-sg-hint" data-selectable="">
            <WithCode text={status.detail} />
          </p>
        )}
        {/* Huli: Kite installs its own Node.js from its own notice. */}
        {ownNotice &&
          (ownNotice.reason.kind === 'needs-node' ? (
            <NodeNotice status={status} />
          ) : (
            <ProblemNotice status={status} problem={ownNotice} />
          ))}
        {error && (
          <p className="ui-sg-hint k-error" data-wrap="">
            {error}
          </p>
        )}

        {status.movedAccounts && <MovedAccountsNotice status={status} />}
        {status.failedVersion && <FailedVersionNotice status={status} />}
        {status.versionWarning && <VersionWarningNotice status={status} />}
        <TaskNotice status={status} installed={installed && onMachine} />
        {r.kind === 'failed' && !status.task && (
          <Notice
            variant="error"
            title={t('harnesses.startFailedTitle', { name: status.harnessName })}
            action={
              <SetButton
                variant="primary"
                loading={busy}
                onClick={() => act(() => request('agents.retry', { agentId: status.id }))}
              >
                {t('common:actions.retry')}
              </SetButton>
            }
          >
            <span data-selectable="">
              <WithCode text={r.message} />
            </span>
          </Notice>
        )}
        {status.uninstalled && <UninstalledNotice status={status} />}
        {/* Huli: an uninstalled harness's own notice installs it again. */}
        {notice && !ownNotice && !status.uninstalled && !uninstalling && (
          <InstallNotice status={status} kind={notice} />
        )}

        {onMachine && <VersionGroup status={status} />}
        <ProgramGroup status={status} />
        {status.package && <PackageGroup status={status} />}
        <AgentsGroup status={status} />

        {installed && (
          <Collapsible className="k-group">
            <CollapsibleTrigger className="ui-sg-head k-disclosure">
              <Icon icon={ArrowDown01Icon} size={14} />
              {t('agents.advanced')}
            </CollapsibleTrigger>
            <CollapsibleContent className={PANEL}>
              <div className="k-disclosure__body">
                <RowGroup>
                  <RowFrame
                    text={
                      <RowText
                        name={t('agents.launch')}
                        description={
                          <code className="k-mono k-break" data-selectable="">
                            {status.launchCommand}
                          </code>
                        }
                      />
                    }
                  >
                    <CopyAction text={status.launchCommand} label={t('agents.copyLaunch')} />
                  </RowFrame>
                  {status.package?.installed && (
                    <RowFrame
                      text={
                        <RowText
                          name={t('harnesses.reinstall', { name: status.package.name })}
                          description={t('harnesses.reinstallBody')}
                        />
                      }
                    >
                      <SetButton
                        loading={busy}
                        disabled={r.kind === 'installing' || r.kind === 'starting'}
                        onClick={() =>
                          act(() => request('agents.reinstall', { agentId: status.harnessId }))
                        }
                      >
                        {t('agents.reinstall')}
                      </SetButton>
                    </RowFrame>
                  )}
                  {status.package && !status.package.isSdk && environment?.nodeVersion && (
                    <Fact name="Node.js" mono>
                      {environment.nodeVersion}
                    </Fact>
                  )}
                </RowGroup>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
        {/* Huli: kept while it uninstalls, as what it installed is already forgotten. */}
        {(uninstalling || (installed && !status.uninstalled)) && <UninstallGroup status={status} />}
      </div>
    </div>
  )
}

/**
 * Uninstalls what Kettu installed for the harness, and its agents, while the user's own program
 * and configuration stay; offers to remove the program too when its install route can. Huli: the
 * confirmation closes at once, and the row says it is uninstalling, or why it could not.
 */
function UninstallGroup({ status }: { status: AgentStatus }) {
  const scope = useHostScope()
  const { useAgentsStore } = scope
  const { t } = useTranslation(['settings', 'common'])
  const [open, setOpen] = useState(false)
  const [removeProgram, setRemoveProgram] = useState(false)
  const busy = useAgentsStore((s) => !!s.uninstalling[status.harnessId])
  const error = useAgentsStore((s) => s.uninstallErrors[status.harnessId] ?? null)
  const uninstall = (): void => {
    setOpen(false)
    void uninstallHarness(scope, status, removeProgram)
  }
  return (
    <section className="k-group">
      <RowGroup>
        <RowFrame
          text={
            <RowText
              name={t('harnesses.uninstall.name', { name: status.harnessName })}
              description={t('harnesses.uninstall.description')}
            />
          }
        >
          <DangerButton
            busy={busy}
            onClick={() => {
              useAgentsStore.setState((s) => ({
                uninstallErrors: without(s.uninstallErrors, status.harnessId),
              }))
              setRemoveProgram(false)
              setOpen(true)
            }}
          >
            {busy ? t('harnesses.uninstall.working') : t('harnesses.uninstall.button')}
          </DangerButton>
        </RowFrame>
        {error && (
          <p className="ui-sg-hint k-error" data-wrap="" data-selectable="">
            {error}
          </p>
        )}
      </RowGroup>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="sm:max-w-120">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('harnesses.uninstall.title', { name: status.harnessName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('harnesses.uninstall.body', { name: status.harnessName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {status.uninstallCommand && (
            <label className="flex items-start gap-2.5 rounded-code bg-subtle px-3 py-2.5 text-left">
              <Checkbox
                checked={removeProgram}
                onCheckedChange={(value) => setRemoveProgram(value === true)}
                className="mt-0.5"
              />
              <span className="flex min-w-0 flex-col gap-px">
                <span className="text-ui font-medium text-primary">
                  {t('harnesses.uninstall.program')}
                </span>
                <code className="font-mono text-xs break-all text-secondary" data-selectable="">
                  {status.uninstallCommand}
                </code>
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={uninstall}>
              {t('harnesses.uninstall.button')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** The harness's version, whether a newer one exists, and the check for it. */
function VersionGroup({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const check = useAgentsStore((s) => s.updateCheck)
  const refresh = useRefresh({ busy: check.running })
  const now = useNow()
  const version = harnessVersion(status)
  const checkedAt = status.updateCheckedAt
  const checks =
    !programUnchecked(status) &&
    (!!status.package || !!status.cli || !!status.release?.registry || checkedAt !== null)
  const updating = status.task?.kind === 'update' && status.task.state === 'running'
  const next = status.cli?.update?.version ?? status.update?.cliVersion ?? null
  // A stale check does not make a missing program current, so it gets no green dot.
  const current = !next && !status.update && showsCurrent(status)
  const stated = !!next || !!status.update || current
  const line: ReactNode = !checks ? (
    t('agents.ownInstaller')
  ) : refresh.phase === 'turning' ? (
    t('agents.update.checking')
  ) : updating ? (
    t('agents.update.updating')
  ) : (
    <>
      {stated && (
        <span aria-hidden className="k-dot" data-tone={next || status.update ? 'new' : 'ok'} />
      )}
      {next
        ? t('agents.update.released', { version: next })
        : status.update && status.automatic?.back
          ? t(SWITCH_BACK_LINE[status.automatic.backReason ?? 'registry'], {
              version: status.update.adapterVersion,
            })
          : status.update
            ? t(
                status.package?.isSdk
                  ? 'agents.update.sdkReleased'
                  : status.package && !packageIsProgram(status)
                    ? 'agents.update.adapterReleased'
                    : 'agents.update.released',
                {
                  version: status.update.adapterVersion,
                },
              )
            : current
              ? t('agents.update.upToDate')
              : null}
      <span>
        {stated && ' · '}
        {checkedAt
          ? t('agents.update.checkedAgo', { ago: mediumAgo(checkedAt, now) })
          : t('agents.update.notChecked')}
      </span>
    </>
  )
  return (
    <section className="k-group" aria-label={t('agents.versionGroup')}>
      <GroupLabel group={{ id: 'version', label: t('agents.versionGroup') }} />
      <RowGroup>
        <RowFrame
          text={
            <RowText
              name={
                version ? (
                  <span className="k-mono" data-selectable="">
                    {version}
                  </span>
                ) : (
                  <span className="k-muted">{t('agents.notReported')}</span>
                )
              }
              description={line}
            />
          }
        >
          {checks && (
            <SetButton
              loading={refresh.phase === 'turning'}
              disabled={updating}
              onClick={() =>
                void refresh.run(() => checkForUpdates(useAgentsStore)).catch(() => {})
              }
            >
              {t('agents.update.check')}
            </SetButton>
          )}
        </RowFrame>
        {status.automatic && <AutomaticUpdatesRow status={status} />}
      </RowGroup>
    </section>
  )
}

/** What says why a harness went back to an older version, by what withdrew the one it had. */
const WENT_BACK = {
  registry: 'harnesses.autoUpdate.wentBack',
  broken: 'harnesses.autoUpdate.wentBackBroken',
  manifest: 'harnesses.autoUpdate.wentBackManifest',
  bundled: 'harnesses.autoUpdate.wentBackBundled',
} as const satisfies Record<VersionMoveReason, string>

const SWITCH_BACK_LINE = {
  registry: 'harnesses.switchBack.line',
  broken: 'harnesses.switchBack.lineBroken',
  manifest: 'harnesses.switchBack.lineManifest',
  bundled: 'harnesses.switchBack.lineBundled',
} as const satisfies Record<VersionMoveReason, string>

/**
 * The switch for Kettu's own install of a harness to follow its target by itself, from the ACP
 * Registry or Kettu's checks, and the last move it made: an update, or a switch back after a
 * withdrawal, and why. A version without a checksum, which it does not install, is offered here
 * by hand.
 */
function AutomaticUpdatesRow({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const now = useNow()
  const [apply, error] = useApply()
  const automatic = status.automatic
  if (!automatic) return null
  const { moved } = automatic
  const ago = moved ? mediumAgo(moved.at, now) : ''
  const kettu = automatic.follows === 'kettu'
  const unchecked =
    automatic.on && automatic.noChecksum && status.update ? status.update.adapterVersion : null
  const busy = status.task?.state === 'running'
  const line = unchecked
    ? t('harnesses.autoUpdate.noChecksum')
    : !automatic.on
      ? t(kettu ? 'harnesses.autoUpdate.offKettu' : 'harnesses.autoUpdate.off')
      : moved
        ? t(
            moved.withdrawn
              ? WENT_BACK[moved.reason ?? 'registry']
              : 'harnesses.autoUpdate.updated',
            {
              from: moved.from,
              to: moved.to,
              ago,
            },
          )
        : t(kettu ? 'harnesses.autoUpdate.onKettu' : 'harnesses.autoUpdate.on')
  return (
    <RowFrame
      id="auto-update"
      text={<RowText name={entryText('harnesses.auto-update').name} description={line} />}
    >
      <ControlError error={error} />
      {unchecked && !busy && (
        <SetButton onClick={() => startUpdate(useAgentsStore, status.harnessId)}>
          {t('harnesses.updateTo', { version: unchecked })}
        </SetButton>
      )}
      <SettingSwitch
        label={t('harnesses.autoUpdate.name')}
        checked={automatic.on}
        onChange={(on) => apply({ agents: { [status.harnessId]: { autoUpdate: on } } })}
      />
    </RowFrame>
  )
}

/** A new version that did not start, the version that runs in its place, and why. */
function FailedVersionNotice({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const failed = status.failedVersion
  if (!failed) return null
  const name = status.harnessName
  return (
    <Notice
      variant="warning"
      title={t('harnesses.failedVersion.title', { name, version: failed.version })}
      more={<span data-selectable="">{failed.reason}</span>}
    >
      {failed.runs
        ? t('harnesses.failedVersion.body', { version: failed.version, runs: failed.runs })
        : t('harnesses.failedVersion.bodyNone', { version: failed.version })}
    </Notice>
  )
}

/**
 * The user's own program is a version Kettu's checks say does not work: what to change it to, and
 * the update that does when there is one. Kettu never installs a chosen version of it.
 */
function VersionWarningNotice({ status }: { status: AgentStatus }) {
  const { hostId, useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const pending = useAgentsStore((s) => !!s.pending[status.id])
  const waiting = useWaitingUpdate(status)
  const warning = status.versionWarning
  if (!warning) return null
  const name = status.harnessName
  const update = status.cli?.update ?? null
  const busy = status.task?.state === 'running' || pending || waiting
  return (
    <Notice
      variant="warning"
      title={
        warning.broken || !warning.supported
          ? t('harnesses.versionWarning.brokenTitle', { name, version: warning.version })
          : t('harnesses.versionWarning.unsupportedTitle', {
              name,
              version: warning.version,
              supported: warning.supported,
            })
      }
      action={
        update && !busy ? (
          <SetButton
            variant="primary"
            onClick={() => startCliUpdate(useAgentsStore, status.harnessId, hostId)}
          >
            {t('harnesses.updateTo', { version: update.version })}
          </SetButton>
        ) : undefined
      }
      more={update ? <CommandLine command={update.command} /> : undefined}
    >
      {update
        ? t('harnesses.versionWarning.bodyUpdate', { update: update.version })
        : warning.recommended
          ? t('harnesses.versionWarning.bodyRecommended', {
              name,
              recommended: warning.recommended,
            })
          : t('harnesses.versionWarning.bodyOther', { name })}
    </Notice>
  )
}

/** An update on offer, under way, failed or just done, in one notice under the page's title. */
function TaskNotice({ status, installed }: { status: AgentStatus; installed: boolean }) {
  const { hostId, useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common', 'updates', 'agents'])
  const updated = useAgentsStore((s) => s.updated[status.id])
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  const pending = useAgentsStore((s) => !!s.pending[status.id])
  const waiting = useWaitingUpdate(status)
  const running = useRunningSessions(status.harnessId)
  const [doneSeen, setDoneSeen] = useState(false)
  const [act, rechecking] = useAction()
  const name = status.harnessName
  const harness = status.harnessId
  // An install of a harness that is not installed shows in its install notice instead.
  const task = status.task && (status.task.kind === 'update' || installed) ? status.task : null
  const updating = task?.kind === 'update'
  const version = harnessVersion(status)
  const cliUpdate = status.cli?.update ?? null
  const next = cliUpdate?.version ?? status.update?.cliVersion ?? status.update?.adapterVersion
  if (task?.state === 'running') {
    return (
      <Notice
        variant="info"
        icon={<Spin />}
        title={
          updating && next
            ? t('agents.update.progressTitleTo', { name, version: next })
            : t(updating ? 'agents.update.progressTitle' : 'agents.install.progressTitle', {
                name,
              })
        }
        action={
          <SetButton onClick={() => cancelTask(useAgentsStore, harness)}>
            {t(updating ? 'agents.update.cancel' : 'agents.install.cancel')}
          </SetButton>
        }
        more={<TaskLog task={task} />}
      >
        {/* Only a package installs beside what runs; the user's own program is replaced. */}
        {updating && !task.method
          ? t('agents.update.progressBody')
          : (task.progress.at(-1) ?? task.command)}
      </Notice>
    )
  }
  if (waiting) {
    return (
      <Notice
        variant="info"
        icon={<Spin />}
        title={t('harnesses.cliUpdateWaiting.title', { name, version: next ?? '' })}
        action={
          <SetButton onClick={() => forgetHarnessUpdate(status.id)}>
            {t('updates:harness.dontWait')}
          </SetButton>
        }
      >
        {t('harnesses.cliUpdateWaiting.body', { count: running, name })}
      </Notice>
    )
  }
  if (task?.state === 'failed') return <FailedTaskNotice status={status} task={task} />
  if (taskError && !status.task) {
    return (
      <Notice
        variant="error"
        title={t(
          taskError.kind === 'update' ? 'agents.update.failedTitle' : 'agents.install.failedTitle',
        )}
        action={<DismissButton onClick={() => cancelTask(useAgentsStore, harness)} />}
      >
        <span data-selectable="">{taskError.message}</span>
      </Notice>
    )
  }
  const minimum = cliOutdated(status)
  // The notice about a version that does not work offers the update itself.
  if (cliUpdate && !status.versionWarning) {
    const outdated = minimum !== null
    return (
      <Notice
        variant={outdated ? 'warning' : 'info'}
        icon={outdated ? undefined : <Icon icon={Download04Icon} size={16} />}
        title={
          outdated
            ? t('agents:problem.tooOldAt', { version: minimum ?? '' })
            : t('agents.update.noticeTitle', { name, version: cliUpdate.version })
        }
        action={
          <SetButton
            variant="primary"
            loading={pending}
            onClick={() => startCliUpdate(useAgentsStore, harness, hostId)}
          >
            {t('harnesses.updateTo', { version: cliUpdate.version })}
          </SetButton>
        }
        more={<CommandLine command={cliUpdate.command} />}
      >
        {outdated
          ? t('harnesses.cliOutdated', { name, current: version ?? '' })
          : t(status.package?.isSdk ? 'harnesses.cliUpdateBodySdk' : 'harnesses.cliUpdateBody', {
              current: version ?? '',
              name,
            })}
      </Notice>
    )
  }
  // No update command is known, such as for a program installed some other way.
  if (minimum !== null) {
    return (
      <Notice
        variant="warning"
        title={t('agents:problem.tooOldAt', { version: minimum })}
        action={
          <SetButton
            variant="primary"
            loading={rechecking}
            onClick={() => act(() => useAgentsStore.getState().reloadEnvironment())}
          >
            {t('harnesses.recheck')}
          </SetButton>
        }
      >
        {t('harnesses.cliOutdatedManual', { name, current: version ?? '', minimum })}
      </Notice>
    )
  }
  if (status.update && status.automatic?.back) {
    // Beside the user's own CLI, what moves is the SDK, so it is named, not the harness.
    const moving = adapterOnlyUpdate(status)
    const current = moving
      ? moving.version
      : (status.release?.version ?? status.package?.version ?? version ?? '')
    const to = status.update.adapterVersion
    const reason = status.automatic.backReason ?? 'registry'
    return (
      <Notice
        variant="warning"
        title={t(
          reason === 'registry'
            ? 'harnesses.switchBack.title'
            : reason === 'broken'
              ? 'harnesses.switchBack.titleBroken'
              : 'harnesses.switchBack.titleKettu',
          { name: moving?.name ?? name, current },
        )}
        action={
          <SetButton
            variant="primary"
            loading={pending}
            onClick={() => startUpdate(useAgentsStore, harness)}
          >
            {t('harnesses.switchBack.button', { version: to })}
          </SetButton>
        }
      >
        {t(reason === 'registry' ? 'harnesses.switchBack.body' : 'harnesses.switchBack.bodyKettu', {
          name,
          version: to,
        })}
      </Notice>
    )
  }
  if (status.update) {
    const adapter = adapterOnlyUpdate(status)
    // A release from the registry is the harness itself, at the version the registry lists.
    const cli = status.release ? status.update.adapterVersion : status.update.cliVersion
    return (
      <Notice
        variant="info"
        icon={<Icon icon={Download04Icon} size={16} />}
        title={
          adapter
            ? t('agents.update.noticeTitleAdapterOnly', {
                package: adapter.name,
                version: status.update.adapterVersion,
              })
            : cli && cli !== version
              ? t('agents.update.noticeTitle', { name, version: cli })
              : t('agents.update.noticeTitleAdapter', { name })
        }
        action={
          <SetButton
            variant="primary"
            loading={pending}
            onClick={() => startUpdate(useAgentsStore, harness)}
          >
            {t('agents.update.button')}
          </SetButton>
        }
      >
        {adapter
          ? t(
              status.package?.isSdk
                ? 'agents.update.noticeBodySdkOnly'
                : 'agents.update.noticeBodyAdapterOnly',
              {
                package: adapter.name,
                current: adapter.version,
                command: status.cli?.command ?? '',
                name,
              },
            )
          : t('agents.update.noticeBody', {
              current: status.release?.version ?? version ?? status.package?.version ?? '',
              name,
            })}
      </Notice>
    )
  }
  if (updated && !doneSeen) {
    return (
      <Notice
        variant="success"
        title={t('agents.update.doneTitle', { name })}
        action={<DismissButton onClick={() => setDoneSeen(true)} />}
      >
        {t('agents.update.doneBody', { name })}
      </Notice>
    )
  }
  return null
}

/** A failed install or update: why, its log, and retry, copy or dismiss. */
function FailedTaskNotice({ status, task }: { status: AgentStatus; task: AgentTask }) {
  const { hostId, useAgentsStore, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const pending = useAgentsStore((s) => !!s.pending[status.id])
  const updating = task.kind === 'update'
  return (
    <Notice
      variant="error"
      title={t(updating ? 'agents.update.failedTitle' : 'agents.install.failedTitle')}
      action={<DismissButton onClick={() => cancelTask(useAgentsStore, status.harnessId)} />}
      more={
        <>
          <TaskLog task={task} />
          <span className="k-end k-wrap">
            <SetButton
              icon={<Icon icon={RefreshIcon} size={14} />}
              loading={pending}
              onClick={() =>
                retryTask(useAgentsStore, useSettingsStore, status.harnessId, task, hostId)
              }
            >
              {t('common:actions.retry')}
            </SetButton>
            <LogCopyButton task={task} />
          </span>
        </>
      }
    >
      {task.error && <span data-selectable="">{task.error}</span>}
      {updating &&
        `${task.error && !/[。！？]$/.test(task.error) ? ' ' : ''}${t('agents.update.failedBody')}`}
    </Notice>
  )
}

/** Why the harness cannot run when installing it would not help, the host's words and the fix. */
function ProblemNotice({ status, problem }: { status: AgentStatus; problem: HarnessProblem }) {
  return (
    <Notice
      variant={problem.fix ? 'warning' : 'info'}
      title={problem.label}
      action={
        problem.fix && <ProblemFixButton status={status} fix={problem.fix} variant="primary" />
      }
    >
      <span data-selectable="">
        <WithCode text={status.detail ?? problem.text} />
      </span>
    </Notice>
  )
}

/** A harness that was uninstalled: Install brings it back with its configuration. */
function UninstalledNotice({ status }: { status: AgentStatus }) {
  const { hostId, useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const pending = useAgentsStore((s) => !!s.pending[status.id])
  return (
    <Notice
      variant="info"
      icon={<Icon icon={Download04Icon} size={16} />}
      title={t('harnesses.removedLine')}
      action={
        <SetButton
          variant="primary"
          loading={pending}
          onClick={() => void openInstall(status.harnessId, hostId)}
        >
          {t('agents.install.button')}
        </SetButton>
      }
    >
      {t('harnesses.uninstall.installAgain')}
    </Notice>
  )
}

/** Installing a harness: its program by a route in the dialog, or Kettu's package; then progress. */
function InstallNotice({ status, kind }: { status: AgentStatus; kind: InstallKind }) {
  const { api, hostId, useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [act, , error] = useAction()
  // Asked for, before the host reports the install: its settings and detection run first.
  const pending = useAgentsStore((s) => s.pending[status.id] === 'install')
  const task = status.task?.kind === 'install' ? status.task : null
  const name = status.harnessName
  if (task?.state === 'running' || status.state === 'installing' || pending) {
    const lines = task ? task.progress : status.progress
    return (
      <Notice
        variant="info"
        icon={<Spin />}
        title={t('agents.install.progressTitle', { name })}
        action={
          (task || status.package) && (
            <SetButton onClick={() => cancelTask(useAgentsStore, status.harnessId)}>
              {t('agents.install.cancel')}
            </SetButton>
          )
        }
        more={lines.length > 0 && <Log lines={lines} />}
      >
        {lines.at(-1) ?? task?.command}
      </Notice>
    )
  }
  if (task?.state === 'failed') return <FailedTaskNotice status={status} task={task} />
  if (needsNode(status)) return <NodeNotice status={status} />
  if (kind === 'package') {
    // The SDK installs itself on first use beside the user's CLI; nothing waits on the user.
    if (status.package?.isSdk) return null
    return (
      <Notice
        variant="info"
        icon={<Icon icon={Download04Icon} size={16} />}
        title={t('agents.install.title', { name })}
        action={
          <SetButton variant="primary" onClick={() => void openInstall(status.harnessId, hostId)}>
            {t('harnesses.install.open')}
          </SetButton>
        }
      >
        {t('agents.install.adapterBody', { package: status.package?.name ?? '', name })}
      </Notice>
    )
  }
  return (
    <Notice
      variant="info"
      icon={<Icon icon={Download04Icon} size={16} />}
      title={t('agents.install.title', { name })}
      action={
        <SetButton variant="primary" onClick={() => void openInstall(status.harnessId, hostId)}>
          {t('harnesses.install.open')}
        </SetButton>
      }
      more={
        (status.program ?? status.binaryCommand) && (
          <span className="k-end">
            <button
              type="button"
              className="k-link"
              onClick={() => act(() => api.dialogs.chooseAgentBinary(status.harnessId))}
            >
              {t('agents.install.elsewhere')}
            </button>
            <ControlError error={error} />
          </span>
        )
      }
    >
      {status.cli
        ? t(status.package?.isSdk ? 'harnesses.install.cliBodySdk' : 'harnesses.install.cliBody', {
            name,
            command: status.cli.command,
          })
        : t('agents.install.body')}
    </Notice>
  )
}

/** Two sentences as one line: no space after a Chinese full stop. */
function joinSentences(first: string, second: string): string {
  return /[。！？]$/.test(first) ? `${first}${second}` : `${first} ${second}`
}

/** Huli: Node.js is missing or too old: Kite installs its own, or the user installs it by hand. */
function NodeNotice({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('agents')
  return (
    <Notice
      variant="info"
      icon={<Icon icon={Download04Icon} size={16} />}
      title={t('node.title')}
      more={<NodeInstallAction />}
    >
      {joinSentences(status.detail ?? t('problem.needsNode'), t('node.hint'))}
    </Notice>
  )
}

/** The versions an npm range covers, as the page says them: `~0.2.2` is 0.2.x. */
function rangeText(t: SettingsT, range: string): string {
  const tilde = /^~(\d+)\.(\d+)\.\S+$/.exec(range)
  if (tilde) return `${tilde[1]}.${tilde[2]}.x`
  const from = /^>=\s*(\S+)$/.exec(range)
  return from ? t('harnesses.unused.from', { version: from[1] }) : range
}

/** Why the user's own program found for the harness does not run, and what runs instead. */
function unusedNote(t: SettingsT, status: AgentStatus): string | null {
  const unused = status.unusedProgram
  if (!unused) return null
  const { command, version } = unused
  const why =
    unused.why.kind === 'range'
      ? t('harnesses.unused.range', {
          command,
          version: version ?? '',
          range: rangeText(t, unused.why.range),
        })
      : unused.why.kind === 'manifest'
        ? t('harnesses.unused.manifest', { command, version: version ?? '' })
        : unused.why.detail
  const pkg = status.package
  const instead = pkg?.installed
    ? t('harnesses.unused.kettuRuns', { version: pkg.version })
    : t('harnesses.unused.install', { name: status.harnessName })
  return `${why} ${instead}`
}

/**
 * The program that runs: the user's own CLI or binary, with its version and how it was installed,
 * one picked in a dialog, or for a harness Kettu installs, its own copy and why the user's own
 * program found beside it does not run.
 */
function ProgramGroup({ status }: { status: AgentStatus }) {
  const { api, useSettingsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const override = useSettingsStore((s) => s.settings.agents[status.harnessId]?.binaryPath)
  const [act, , error] = useAction()
  // Older hosts name only a binary harness's program.
  const program =
    status.program ??
    (status.binaryCommand ? { command: status.binaryCommand, onPath: true } : null)
  const installed = status.cli?.installed ?? null
  const command = status.cli?.command ?? program?.command
  if (!command) return null
  const unused = status.unusedProgram ?? null
  // Kettu's own copy runs, since none of the user's runs in its place.
  const kettuInstalls = (!!status.package && !status.package.isSdk) || program?.onPath === false
  const kettuCopy = kettuInstalls && !status.cli && !override
  const version = unused && kettuCopy ? unused.version : harnessVersion(status)
  const method = status.cli?.method ?? null
  const path = override ?? installed?.path ?? status.binaryPath ?? unused?.path ?? null
  const problem = installed?.problem
  const note = installed?.variable
    ? t('agents.setBy', { env: installed.variable })
    : problem?.kind === 'unsupported'
      ? t('agents.cli.unsupported', { command })
      : problem?.kind === 'failed'
        ? problem.reason
        : kettuCopy && unused
          ? unusedNote(t, status)
          : !path && program?.onPath !== false
            ? t('agents.cli.notFound', { command })
            : null
  return (
    <section className="k-group" aria-label={t('agents.program')}>
      <GroupLabel group={{ id: 'program', label: t('agents.program') }} />
      <RowGroup>
        <ConfigFrame
          name={t('harnesses.programName', { command })}
          description={
            override
              ? t('harnesses.programChosen')
              : method
                ? t('harnesses.installedWith', { method: methodName(t, method) })
                : status.package?.isSdk
                  ? t('harnesses.programSdk')
                  : kettuCopy
                    ? t(unused ? 'harnesses.programUnused' : 'harnesses.programKettuCopy')
                    : status.release
                      ? t('harnesses.programKettu')
                      : t('harnesses.programOwn')
          }
          control={
            program && (
              <>
                <ControlError error={error} />
                {override && (
                  <SetButton
                    variant="ghost"
                    onClick={() =>
                      act(() =>
                        useSettingsStore
                          .getState()
                          .update({ agents: { [status.harnessId]: { binaryPath: null } } }),
                      )
                    }
                  >
                    {t('agents.reset')}
                  </SetButton>
                )}
                <SetButton
                  onClick={() => act(() => api.dialogs.chooseAgentBinary(status.harnessId))}
                >
                  {t('agents.chooseBinary')}
                </SetButton>
              </>
            )
          }
        >
          {path ? (
            <PathLine path={path} actions={<PathActions path={path} />}>
              {version && <span className="k-mono k-muted">{version}</span>}
            </PathLine>
          ) : (
            program?.onPath !== false &&
            !kettuCopy && <span className="k-muted">{t('agents.programOnPath', { command })}</span>
          )}
          {note && (
            <span className="k-muted" data-selectable="">
              {note}
            </span>
          )}
        </ConfigFrame>
      </RowGroup>
    </section>
  )
}

/** Kettu's own package for the harness: Claude Code's SDK or an ACP adapter, and its updates. */
function PackageGroup({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const pending = useAgentsStore((s) => !!s.pending[status.id])
  const pkg = status.package
  if (!pkg) return null
  const range = `${pkg.version.split('.').slice(0, 2).join('.')}.x`
  return (
    <section className="k-group" aria-label={t('harnesses.packageGroup')}>
      <GroupLabel group={{ id: 'package', label: t('harnesses.packageGroup') }} />
      <RowGroup>
        <RowFrame
          text={
            <RowText
              name={
                <span className="k-mono" data-selectable="">
                  {pkg.name}
                </span>
              }
              description={
                pkg.installed
                  ? t(pkg.isSdk ? 'harnesses.sdkLine' : 'harnesses.adapterLine', {
                      version: pkg.version,
                    })
                  : // An adapter waits for Install; only the SDK installs itself on first use.
                    t(pkg.isSdk ? 'agents.installsOnFirstUse' : 'harnesses.groups.notInstalled')
              }
            />
          }
        >
          {status.update && (
            <SetButton
              variant="primary"
              loading={pending}
              disabled={status.task?.state === 'running'}
              onClick={() => startUpdate(useAgentsStore, status.harnessId)}
            >
              {t(status.automatic?.back ? 'harnesses.switchBack.button' : 'harnesses.updateTo', {
                version: status.update.adapterVersion,
              })}
            </SetButton>
          )}
        </RowFrame>
      </RowGroup>
      <p className="ui-sg-hint">
        {pkg.isSdk
          ? t('harnesses.sdkNote', { name: status.harnessName, range })
          : packageIsProgram(status)
            ? t('harnesses.programNote', { name: status.harnessName })
            : t('harnesses.adapterNote', { name: status.harnessName })}
      </p>
    </section>
  )
}

/** The agents that use the harness; they are added and changed in Settings > Agents. */
function AgentsGroup({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const agents = useAgentsStore(
    useShallow((s) =>
      usableAgents(s.order, s.byId)
        .filter((a) => a.harnessId === status.harnessId)
        .map((a) => a.name),
    ),
  )
  return (
    <section className="k-group" aria-label={t('sections.agents')}>
      <GroupLabel group={{ id: 'agents', label: t('sections.agents') }} />
      <RowGroup>
        <RowFrame
          text={
            <RowText
              name={t('harnesses.usedBy')}
              description={
                agents.length > 0
                  ? agents.join(t('harnesses.listSeparator'))
                  : t('harnesses.usedByNone')
              }
            />
          }
        >
          <SetButton onClick={() => openAgentSettings(null)}>
            {t('harnesses.manageAgents')}
          </SetButton>
        </RowFrame>
      </RowGroup>
    </section>
  )
}

/**
 * What Reload environment is called. On Windows Kite keeps the environment it started with, PATH
 * included, as the footer's warning says, so there it only detects the harnesses again.
 */
function reloadLabel(environment: EnvironmentInfo | null) {
  return environment?.source === 'inherited'
    ? 'agents.environment.redetect'
    : 'agents.environment.reload'
}

export function EnvironmentFooter() {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const environment = useAgentsStore((s) => s.environment)
  const now = useNow()
  const refresh = useRefresh()
  const [error, setError] = useState<string | null>(null)
  const source = environment?.source
  const text = environmentText(t, environment, now)
  return (
    <div data-setting-row="environment" className="k-row k-env">
      <FlashMark id="environment" />
      <p className="ui-sg-hint k-env__line">
        {(!environment || source === 'pending') && <Spin />}
        {source === 'fallback' && (
          <span className="k-warn">
            <Icon icon={Alert02Icon} size={14} />
          </span>
        )}
        <span>
          {text}{' '}
          <button
            type="button"
            className="k-link"
            disabled={refresh.phase === 'turning'}
            onClick={() => {
              setError(null)
              void refresh
                .run(() => useAgentsStore.getState().reloadEnvironment())
                .catch((e: unknown) => setError(errorMessage(e)))
            }}
          >
            {t(reloadLabel(environment))}
          </button>
        </span>
      </p>
      {environment?.warning && <p className="ui-sg-hint">{environment.warning}</p>}
      {error && (
        <p className="ui-sg-hint k-error" data-wrap="">
          {error}
        </p>
      )}
      {environment?.node && <NodeRuntimeLines node={environment.node} />}
    </div>
  )
}

/** What the line says of the Node.js agents run on. */
function nodeLine(t: SettingsT, node: NodeRuntimeInfo): string {
  const required = node.required?.replace(/^>=\s*/, '') ?? ''
  if (node.using === 'kite' && node.kite) {
    return t('agents.environment.node.usingKite', { version: node.kite.version })
  }
  const system = node.system
  if (!system) return t('agents.environment.node.none')
  if (!system.version) return t('agents.environment.node.systemUnknown')
  if (!system.suitable) {
    return t('agents.environment.node.systemOld', { version: system.version, required })
  }
  return t('agents.environment.node.usingSystem', { version: system.version })
}

/**
 * Huli: the Node.js agents run on, the user's or Kite's own, with its version; Kite's own installed
 * where the user's is missing or too old, updated, removed, or chosen over the user's.
 */
function NodeRuntimeLines({ node }: { node: NodeRuntimeInfo }) {
  const { request, useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'agents', 'common'])
  const [act, , error] = useAction()
  const [choosing, setChoosing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const remove = () => {
    setConfirming(false)
    setRemoving(true)
    setRemoveError(null)
    request('environment.removeNode', undefined)
      .catch((e: unknown) => {
        // The host keeps a failed removal's reason as its task, which the line above shows.
        if (useAgentsStore.getState().environment?.node?.task?.state !== 'failed') {
          setRemoveError(errorMessage(e))
        }
      })
      .finally(() => setRemoving(false))
  }
  const kite = node.kite
  const lacking = node.using === null || (node.using === 'system' && !node.system?.suitable)
  const running = node.task?.state === 'running'
  return (
    <div className="mt-1.5 flex flex-col gap-2" data-setting-row="node">
      <p className="ui-sg-hint" data-selectable="">
        {nodeLine(t, node)}
        {kite &&
          node.using !== 'kite' &&
          ` ${t('agents.environment.node.kiteIdle', { version: kite.version })}`}
      </p>
      {kite ? (
        <>
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <NodeInstallAction
              label={t('agents.environment.node.update')}
              variant="secondary"
              manual={false}
            />
            {!running && (
              <SetButton variant="ghost" loading={removing} onClick={() => setConfirming(true)}>
                {t('agents.environment.node.remove')}
              </SetButton>
            )}
          </span>
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogContent className="sm:max-w-120">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('agents.environment.node.removeTitle', { version: kite.version })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('agents.environment.node.removeBody')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={remove}>
                  {t('agents.environment.node.remove')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <span className="flex min-w-0 items-center gap-2.5">
            <SettingSwitch
              label={t('agents.environment.node.preferKite')}
              checked={node.choice === 'kite'}
              disabled={choosing}
              onChange={(on) => {
                setChoosing(true)
                act(() =>
                  request('environment.setNodeChoice', { choice: on ? 'kite' : 'auto' }).finally(
                    () => setChoosing(false),
                  ),
                )
              }}
            />
            <span className="ui-sg-label">
              <b className="k-row-title">{t('agents.environment.node.preferKite')}</b>
              <small>{t('agents.environment.node.preferKiteHint')}</small>
            </span>
          </span>
        </>
      ) : (
        lacking && <NodeInstallAction />
      )}
      {lacking && !kite && node.installable && (
        <p className="ui-sg-hint">{t('agents:node.hint')}</p>
      )}
      <ControlError error={error ?? removeError} wrap />
    </div>
  )
}
