// Huli: Settings › Agents › Sandbox. One row picks the default tier, its network under it, with
// what each tier protects and costs folded away; one switch lets a sandboxed session's project
// edits through. The container image is looked for only when asked, downloaded only after the
// user saw its size, and removable here.

import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { HostMethod } from '@shared/agent-host'
import {
  DEFAULT_SANDBOX_SETTINGS,
  SANDBOX_IMAGE_MB,
  SANDBOX_MEASURED,
  networkFor,
  TIER_NETWORKS,
  SANDBOX_TIERS,
  type ContainerEngineKind,
  type ContainerStatus,
  type SandboxSettings,
} from '@shared/sandbox'
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
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import {
  CONFIRM,
  ControlError,
  DangerButton,
  SetButton,
  SettingSelect,
  SettingSwitch,
  Spin,
} from './controls'
import { BlockLine } from './rows'
import { useApply } from './use-apply'

function useSandbox(): SandboxSettings {
  return useHostScope().useSettingsStore((s) => s.settings.sandbox ?? DEFAULT_SANDBOX_SETTINGS)
}

/** The engines by their product names, which stay as they are in every language. */
const ENGINE_NAMES: Record<ContainerEngineKind, string> = {
  docker: 'Docker',
  podman: 'Podman',
  'wsl-docker': 'Docker · WSL',
}

const ratio = (a: number, b: number): string => (a / b).toFixed(1).replace(/\.0$/, '')

export function SandboxDefault({ text }: { text: ReactNode }) {
  const { t } = useTranslation('settings')
  const sandbox = useSandbox()
  const [apply, error] = useApply()
  const [open, setOpen] = useState(false)
  const m = SANDBOX_MEASURED
  return (
    <>
      <BlockLine text={text}>
        <ControlError error={error} />
        <SettingSelect
          label={t('agents.sandbox.name')}
          value={sandbox.tier}
          options={SANDBOX_TIERS.map((tier) => ({
            value: tier,
            label: t(`agents.sandbox.tier.${tier}.name`),
          }))}
          onChange={(tier) =>
            apply({
              // A tier's network is one it has: each tier's strictest stands for the other's.
              sandbox:
                tier === 'off' ? { tier } : { tier, network: networkFor(tier, sandbox.network) },
            })
          }
        />
      </BlockLine>
      {sandbox.tier !== 'off' && (
        <BlockLine
          text={
            <span className="ui-sg-label">
              <small>{t('agents.sandbox.network.description')}</small>
            </span>
          }
        >
          <SettingSelect
            label={t('agents.sandbox.network.name')}
            value={networkFor(sandbox.tier, sandbox.network)}
            options={TIER_NETWORKS[sandbox.tier].map((network) => ({
              value: network,
              label: t(`agents.sandbox.network.${network}`),
            }))}
            onChange={(network) => apply({ sandbox: { network } })}
          />
        </BlockLine>
      )}
      <div className="k-block-foot">
        <button
          type="button"
          className="k-sandbox-more"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          {open ? t('agents.sandbox.hide') : t('agents.sandbox.details')}
        </button>
      </div>
      {open && (
        <div className="k-inset k-sandbox-details">
          <p>{t('agents.sandbox.off')}</p>
          <p>{t('agents.sandbox.native')}</p>
          <p>
            {t('agents.sandbox.container', {
              start: m.containerStart.toFixed(1),
              memory: m.engineMemoryMb,
              build: ratio(m.containerWindowsDrive, m.windowsNative),
              native: m.windowsNative,
              container: m.containerWindowsDrive,
              search: Math.round(m.searchShare / m.searchWindows),
              wsl: m.containerWslDisk,
            })}
          </p>
          <p className="k-block-note">{t('agents.sandbox.notProtected')}</p>
          <p className="k-block-note">{t('agents.sandbox.measured')}</p>
          <ContainerImage />
        </div>
      )}
    </>
  )
}

/** The engine and Kite's image, read only when asked. */
function ContainerImage() {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const scope = useHostScope()
  const [status, setStatus] = useState<ContainerStatus | null>(null)
  const [busy, setBusy] = useState<'check' | 'pull' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const run = (
    what: 'check' | 'pull' | 'remove',
    method: Extract<HostMethod, `sandbox.${string}`>,
  ): void => {
    setBusy(what)
    setError(null)
    scope
      .request(method, undefined)
      .then(setStatus, (e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(null))
  }
  const line = !status
    ? null
    : !status.engine
      ? t(
          status.engineProblem === 'notRunning'
            ? 'agents.sandbox.image.notRunning'
            : 'agents.sandbox.image.noEngine',
        )
      : status.image.present
        ? t('agents.sandbox.image.present', {
            engine: `${ENGINE_NAMES[status.engine.kind]} ${status.engine.version ?? ''}`.trim(),
            mb: status.image.diskMb,
          })
        : t('agents.sandbox.image.missing', { mb: status.image.downloadMb })
  return (
    <div className="k-block-foot">
      <span>
        <b>{t('agents.sandbox.image.name')}</b>{' '}
        {busy === 'check' ? t('agents.sandbox.image.checking') : line}
        {error && <span className="k-error"> {error}</span>}
      </span>
      <span className="k-end">
        {busy !== null && busy !== 'check' && <Spin />}
        {(!status || !status.engine) && (
          <SetButton
            disabled={busy !== null}
            onClick={() => run('check', 'sandbox.containerStatus')}
          >
            {t('agents.sandbox.image.check')}
          </SetButton>
        )}
        {status?.engine && !status.image.present && (
          <SetButton disabled={busy !== null} onClick={() => setConfirming(true)}>
            {busy === 'pull'
              ? t('agents.sandbox.image.downloading')
              : t('agents.sandbox.image.download')}
          </SetButton>
        )}
        {status?.engine && status.image.present && (
          <DangerButton
            busy={busy === 'remove'}
            onClick={() => run('remove', 'sandbox.removeImage')}
          >
            {t('agents.sandbox.image.remove', { mb: status.image.diskMb })}
          </DangerButton>
        )}
      </span>
      <AlertDialog open={confirming} onOpenChange={(next) => !next && setConfirming(false)}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('agents.sandbox.image.confirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('agents.sandbox.image.confirm.body', {
                mb: SANDBOX_IMAGE_MB.download,
                disk: SANDBOX_IMAGE_MB.disk,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false)
                run('pull', 'sandbox.pullImage')
              }}
            >
              {t('agents.sandbox.image.confirm.action', { mb: SANDBOX_IMAGE_MB.download })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function SandboxGitWritable() {
  const { t } = useTranslation('settings')
  const sandbox = useSandbox()
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={t('agents.sandbox.git.name')}
        checked={sandbox.gitWritable === true}
        onChange={(gitWritable) => apply({ sandbox: { gitWritable } })}
      />
    </>
  )
}

export function SandboxAutoApprove() {
  const { t } = useTranslation('settings')
  const sandbox = useSandbox()
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={t('agents.sandbox.autoApprove.name')}
        checked={sandbox.autoApproveEdits}
        onChange={(autoApproveEdits) => apply({ sandbox: { autoApproveEdits } })}
      />
    </>
  )
}
