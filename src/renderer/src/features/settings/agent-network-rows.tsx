// Huli: the rows of Settings › Agent network, and the Network exit row of an agent's page. They
// show and change this computer's agent network only. Huli's own; see tools/huli/README.md.

import { useState, type FormEvent } from 'react'
import { Delete02Icon, Edit02Icon, RefreshIcon } from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
  formatBytes,
  isInterfaceName,
  isSubscriptionName,
  cleanSubscriptionName,
  type AgentNetworkStatus,
  type NodeView,
  type SubscriptionView,
} from '@shared/agent-network'
import type { AgentId } from '@shared/thread'
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
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { mediumAgo } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import {
  nodeKey,
  nodeOfKey,
  testLatency,
  useAgentNetwork,
  useAgentNetworkStore,
} from '@renderer/stores/agent-network'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  CONFIRM,
  ControlError,
  IconAction,
  Pill,
  SetButton,
  SetInput,
  SettingSelect,
  SettingSwitch,
} from './controls'
import { RowLine, RowShell, RowText } from './rows'
import {
  DIALOG_FIELD,
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

function update(patch: Parameters<ReturnType<typeof useSettingsStore.getState>['update']>[0]) {
  return useSettingsStore.getState().update(patch)
}

export function NetworkSwitch({ label }: { label: string }) {
  const checked = useSettingsStore((s) => s.settings.agentNetwork.enabled)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(on) => {
          setError(null)
          update({ agentNetwork: { enabled: on } }).catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
    </>
  )
}

export function NetworkState({ status }: { status: AgentNetworkStatus | null }) {
  const { t } = useTranslation('settings')
  if (!status) return null
  const tone =
    status.state === 'running' ? 'success' : status.state === 'error' ? 'warning' : 'neutral'
  return (
    <>
      {status.version && status.state === 'running' && (
        <span className="k-fact">{t('network.status.version', { version: status.version })}</span>
      )}
      <Pill tone={tone}>{t(`network.status.${status.state}`)}</Pill>
    </>
  )
}

/** The interface override: empty uses the one found. Saved when the field is left. */
export function InterfaceField({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const stored = useSettingsStore((s) => s.settings.agentNetwork.interface)
  const detected = useAgentNetworkStore((s) => s.status?.interface.detected ?? null)
  // What is typed until the field is left; the stored name shows otherwise.
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const value = draft ?? stored ?? ''
  const save = () => {
    const trimmed = value.trim()
    const next = trimmed === '' ? null : trimmed
    setDraft(null)
    if (next === stored) return
    if (next !== null && !isInterfaceName(next)) {
      setError(t('network.interface.invalid'))
      return
    }
    setError(null)
    update({ agentNetwork: { interface: next } }).catch((e: unknown) => setError(errorMessage(e)))
  }
  return (
    <>
      <ControlError error={error} />
      <SetInput
        aria-label={label}
        value={value}
        placeholder={detected ?? t('network.interface.placeholder')}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) save()
        }}
      />
    </>
  )
}

/** A date with its year, as an expiry far ahead needs. */
function longDate(at: number): string {
  return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(at)
}

function usageLine(sub: SubscriptionView, t: TFunction<'settings'>): string | null {
  const parts: string[] = []
  if (sub.usage) {
    const used = sub.usage.upload + sub.usage.download
    if (sub.usage.total > 0) {
      parts.push(
        t('network.subscriptions.usage', {
          used: formatBytes(used),
          total: formatBytes(sub.usage.total),
        }),
      )
    }
    if (sub.usage.expire) {
      parts.push(t('network.subscriptions.expires', { date: longDate(sub.usage.expire) }))
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

export function SubscriptionRow({
  sub,
  running,
  onRename,
  onRemove,
}: {
  sub: SubscriptionView
  running: boolean
  onRename: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const first = [
    sub.host,
    sub.nodes === null
      ? t('network.subscriptions.notRead')
      : t('network.subscriptions.nodes', { count: sub.nodes }),
    sub.updatedAt ? t('network.subscriptions.updated', { time: mediumAgo(sub.updatedAt) }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const usage = usageLine(sub, t)
  return (
    <RowShell>
      <RowLine
        text={
          <RowText
            name={sub.name}
            description={
              <>
                {first}
                {usage && (
                  <>
                    <br />
                    {usage}
                  </>
                )}
              </>
            }
          />
        }
      >
        <ControlError error={error} />
        <IconAction
          label={t('network.subscriptions.refresh')}
          icon={RefreshIcon}
          busy={busy}
          disabled={!running}
          onClick={() => {
            setBusy(true)
            setError(null)
            hostAt(null, 'agentNetwork.refresh', { id: sub.id })
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false))
          }}
        />
        <IconAction
          label={t('network.subscriptions.rename')}
          icon={Edit02Icon}
          onClick={onRename}
        />
        <IconAction
          label={t('network.subscriptions.remove')}
          icon={Delete02Icon}
          danger
          onClick={onRemove}
        />
      </RowLine>
    </RowShell>
  )
}

export function RefreshAllAction({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  return (
    <IconAction
      label={t('network.subscriptions.refreshAll')}
      icon={RefreshIcon}
      busy={busy}
      disabled={disabled}
      onClick={() => {
        setBusy(true)
        hostAt(null, 'agentNetwork.refresh', { id: null })
          .catch(() => {})
          .finally(() => setBusy(false))
      }}
    />
  )
}

/** Add, or rename with `sub`: a name, and for a new one its link, which never comes back. */
export function SubscriptionDialog({
  sub,
  open,
  onOpenChange,
}: {
  sub: SubscriptionView | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  // The parent keys the dialog by what it edits, so each opening starts afresh.
  const [name, setName] = useState(sub?.name ?? '')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clean = cleanSubscriptionName(name)
  const nameOk = isSubscriptionName(clean)
  const urlOk = sub !== null || /^https?:\/\/[^\s/]+\S*$/i.test(url.trim())
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!nameOk || !urlOk || busy) return
    setBusy(true)
    setError(null)
    try {
      if (sub) await hostAt(null, 'agentNetwork.renameSubscription', { id: sub.id, name: clean })
      else await hostAt(null, 'agentNetwork.addSubscription', { name: clean, url: url.trim() })
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const nameHint = name.trim() !== '' && !nameOk ? t('network.add.invalidName') : sub ? error : null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent className="sm:max-w-120">
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <SettingsDialogHeader title={t(sub ? 'network.rename.title' : 'network.add.title')} />
          <SettingsDialogBody>
            <SettingsField
              label={t('network.add.name')}
              htmlFor="network-sub-name"
              hint={nameHint && <span className="kettu-sd__error">{nameHint}</span>}
            >
              <input
                id="network-sub-name"
                value={name}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                className={DIALOG_FIELD}
                aria-invalid={(name.trim() !== '' && !nameOk) || undefined}
                onChange={(event) => setName(event.target.value)}
              />
            </SettingsField>
            {!sub && (
              <SettingsField
                label={t('network.add.url')}
                htmlFor="network-sub-url"
                hint={
                  error ? (
                    <span className="kettu-sd__error">{error}</span>
                  ) : url.trim() !== '' && !urlOk ? (
                    <span className="kettu-sd__error">{t('network.add.invalidUrl')}</span>
                  ) : (
                    t('network.add.urlHint')
                  )
                }
              >
                <input
                  id="network-sub-url"
                  type="url"
                  value={url}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://"
                  className={DIALOG_MONO_FIELD}
                  aria-invalid={(url.trim() !== '' && !urlOk) || undefined}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </SettingsField>
            )}
          </SettingsDialogBody>
          <SettingsDialogFooter>
            <DialogClose render={<SetButton size="md" variant="ghost" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <SetButton
              size="md"
              variant="primary"
              type="submit"
              loading={busy}
              disabled={!nameOk || !urlOk || (!sub && url.trim() === '')}
            >
              {t(sub ? 'network.rename.save' : 'network.add.save')}
            </SetButton>
          </SettingsDialogFooter>
        </form>
      </SettingsDialogContent>
    </Dialog>
  )
}

export function RemoveSubscriptionDialog({
  sub,
  onOpenChange,
}: {
  sub: SubscriptionView | null
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    if (!sub || busy) return
    setBusy(true)
    setError(null)
    try {
      await hostAt(null, 'agentNetwork.removeSubscription', { id: sub.id })
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog open={sub !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent className={CONFIRM}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('network.subscriptions.removeTitle', { name: sub?.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('network.subscriptions.removeBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-xs text-danger">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
            {t('network.subscriptions.remove')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** A node's latency as a select's hint: the latest test, else mihomo's last health check. */
function delayText(
  node: NodeView,
  delays: Record<string, number | null>,
  t: TFunction<'settings'>,
): string | undefined {
  const key = nodeKey(node)
  // A test's null is a node that did not answer; mihomo's own checks say so with 0.
  const delay = key in delays ? (delays[key] ?? 0) : node.delay
  if (delay === null) return undefined
  return delay > 0 ? t('network.delay.ms', { ms: delay }) : t('network.delay.timeout')
}

/** The nodes as a select's options, each named with its subscription. */
function useNodeOptions(): { value: string; label: string; hint?: string }[] {
  const { t } = useTranslation('settings')
  const nodes = useAgentNetworkStore((s) => s.nodes)
  const subs = useAgentNetworkStore((s) => s.status?.subscriptions)
  const delays = useAgentNetworkStore((s) => s.delays)
  const names = new Map((subs ?? []).map((sub) => [sub.id, sub.name]))
  return (nodes ?? []).map((node) => {
    const hint = delayText(node, delays, t)
    return {
      value: `node:${nodeKey(node)}`,
      label: `${names.get(node.subscription) ?? ''} | ${node.node}`,
      ...(hint ? { hint } : {}),
    }
  })
}

function nodeLabel(ref: { subscription: string; node: string }, subs: SubscriptionView[]) {
  const sub = subs.find((s) => s.id === ref.subscription)
  return sub ? `${sub.name} | ${ref.node}` : ref.node
}

export function DefaultNodeControl({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const chosen = useSettingsStore((s) => s.settings.agentNetwork.defaultNode)
  const subs = useAgentNetworkStore((s) => s.status?.subscriptions ?? [])
  const running = useAgentNetworkStore((s) => s.status?.state === 'running')
  const testing = useAgentNetworkStore((s) => s.testing)
  const options = useNodeOptions()
  const [error, setError] = useState<string | null>(null)
  const value = chosen ? `node:${nodeKey(chosen)}` : 'none'
  const all = [{ value: 'none', label: t('network.default.none') }, ...options]
  if (chosen && !options.some((o) => o.value === value)) {
    all.push({ value, label: t('network.choice.gone', { node: nodeLabel(chosen, subs) }) })
  }
  return (
    <>
      <ControlError error={error} />
      <SetButton
        variant="ghost"
        loading={testing}
        disabled={!running || options.length === 0}
        onClick={() => {
          setError(null)
          testLatency(null).catch((e: unknown) => setError(errorMessage(e)))
        }}
      >
        {t('network.default.test')}
      </SetButton>
      <SettingSelect
        label={label}
        value={value}
        options={all}
        className="w-60"
        onChange={(next) => {
          setError(null)
          const ref = next === 'none' ? null : nodeOfKey(next.slice('node:'.length))
          update({ agentNetwork: { defaultNode: ref } }).catch((e: unknown) =>
            setError(errorMessage(e)),
          )
        }}
      />
    </>
  )
}

/** Follow the default, a node, or the system's network, for one agent. */
export function NetworkChoiceSelect({ agentId, label }: { agentId: AgentId; label: string }) {
  const { t } = useTranslation('settings')
  const network = useSettingsStore((s) => s.settings.agentNetwork)
  const subs = useAgentNetworkStore((s) => s.status?.subscriptions ?? [])
  const options = useNodeOptions()
  const [error, setError] = useState<string | null>(null)
  const choice = network.agents[agentId]
  const value =
    choice === undefined ? 'default' : choice === 'system' ? 'system' : `node:${nodeKey(choice)}`
  const all = [
    {
      value: 'default',
      label: network.defaultNode
        ? t('network.choice.followNamed', { node: nodeLabel(network.defaultNode, subs) })
        : t('network.choice.follow'),
    },
    { value: 'system', label: t('network.choice.system') },
    ...options,
  ]
  if (typeof choice === 'object' && !options.some((o) => o.value === value)) {
    all.push({ value, label: t('network.choice.gone', { node: nodeLabel(choice, subs) }) })
  }
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={label}
        value={value}
        options={all}
        className="w-60"
        onChange={(next) => {
          setError(null)
          const agents = { ...useSettingsStore.getState().settings.agentNetwork.agents }
          if (next === 'default') delete agents[agentId]
          else if (next === 'system') agents[agentId] = 'system'
          else {
            const ref = nodeOfKey(next.slice('node:'.length))
            if (ref) agents[agentId] = ref
          }
          update({ agentNetwork: { agents } }).catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
    </>
  )
}

/** The Network exit row of an agent's page, on this computer only. */
export function NetworkChoiceRow({ agentId }: { agentId: AgentId }) {
  const { t } = useTranslation('settings')
  const enabled = useSettingsStore((s) => s.settings.agentNetwork.enabled)
  useAgentNetwork()
  const name = t('network.choice.name')
  return (
    <RowShell>
      <RowLine text={<RowText name={name} description={t('network.choice.description')} />}>
        <NetworkChoiceSelect agentId={agentId} label={name} />
      </RowLine>
      {!enabled && (
        <p role="status" className="k-row-note" data-wrap="">
          {t('network.choice.off')}
        </p>
      )}
    </RowShell>
  )
}
