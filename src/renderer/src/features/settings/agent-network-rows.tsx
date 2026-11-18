// Huli: the rows of Settings › Agent network, and the Network exit row of an agent's page. They
// show and change this computer's agent network only. Huli's own; see tools/huli/README.md.

import { useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from 'react'
import {
  Delete02Icon,
  Edit02Icon,
  FileImportIcon,
  Globe02Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
  formatBytes,
  isInterfaceName,
  isSubscriptionName,
  cleanSubscriptionName,
  MAX_SUBSCRIPTION_BYTES,
  SUBSCRIPTION_NAME_CHARS,
  type AgentNetworkChoice,
  type AgentNetworkStatus,
  type ExitIp,
  type NetworkInterfaceView,
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
import { RadioGroup, RadioGroupTile } from '@renderer/components/ui/radio-group'
import { errorCode, errorMessage, hostAt } from '@renderer/lib/host'
import { mediumAgo } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import {
  checkExit,
  loadInterfaces,
  nodeKey,
  nodeOfKey,
  testLatency,
  useAgentNetwork,
  useAgentNetworkStore,
  useExitIp,
  useLiveInterfaces,
} from '@renderer/stores/agent-network'
import { useAgentsStore } from '@renderer/stores/agents'
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
import { EmptyRow, RowLine, RowShell, RowText } from './rows'
import {
  DIALOG_FIELD,
  DIALOG_MONO_FIELD,
  SETTINGS_TILE,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

/** One empty list, so a selector before the status came returns the same value each time. */
const NO_SUBSCRIPTIONS: SubscriptionView[] = []

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

/** The text of a file picked to import, refused past the size the host takes. */
async function readPicked(file: File, t: TFunction<'settings'>): Promise<string> {
  if (file.size > MAX_SUBSCRIPTION_BYTES) throw new Error(t('network.import.tooLarge'))
  return file.text()
}

/** A hidden file input; a click on it shows the system's picker, and `picked` gets the file. */
function FilePicker({
  inputRef,
  picked,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  picked: (file: File) => void
}) {
  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Cleared, so picking the same file again still reads it.
    event.target.value = ''
    if (file) picked(file)
  }
  return (
    <input
      ref={inputRef}
      type="file"
      accept=".yaml,.yml,.txt,.conf,text/plain,application/x-yaml"
      hidden
      onChange={change}
    />
  )
}

export function SubscriptionRow({
  sub,
  onRename,
  onRemove,
}: {
  sub: SubscriptionView
  onRename: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const fromFile = sub.source === 'file'
  const first = [
    sub.host ?? t('network.subscriptions.fromFile'),
    sub.nodes === null
      ? t('network.subscriptions.notRead')
      : t('network.subscriptions.nodes', { count: sub.nodes }),
    sub.updatedAt
      ? t(fromFile ? 'network.subscriptions.imported' : 'network.subscriptions.updated', {
          time: mediumAgo(sub.updatedAt),
        })
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const usage = usageLine(sub, t)
  const failure =
    sub.error && sub.failedAt
      ? t('network.subscriptions.failed', { time: mediumAgo(sub.failedAt), error: sub.error })
      : null
  const reimport = (file: File) => {
    setBusy(true)
    setError(null)
    readPicked(file, t)
      .then((content) => hostAt(null, 'agentNetwork.reimportSubscription', { id: sub.id, content }))
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false))
  }
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
                {failure && (
                  <>
                    <br />
                    <span className="text-danger">{failure}</span>
                  </>
                )}
              </>
            }
          />
        }
      >
        <ControlError error={error} />
        {fromFile ? (
          <>
            <FilePicker inputRef={fileInput} picked={reimport} />
            <IconAction
              label={t('network.subscriptions.reimport')}
              icon={FileImportIcon}
              busy={busy}
              onClick={() => fileInput.current?.click()}
            />
          </>
        ) : (
          <IconAction
            label={t('network.subscriptions.refresh')}
            icon={RefreshIcon}
            busy={busy}
            onClick={() => {
              setBusy(true)
              setError(null)
              // A failed download shows in the row itself, from the status, with its time.
              hostAt(null, 'agentNetwork.refresh', { id: sub.id })
                .catch((e: unknown) => {
                  if (errorCode(e) !== 'unavailable') setError(errorMessage(e))
                })
                .finally(() => setBusy(false))
            }}
          />
        )}
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

export function RefreshAllAction() {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  return (
    <IconAction
      label={t('network.subscriptions.refreshAll')}
      icon={RefreshIcon}
      busy={busy}
      onClick={() => {
        setBusy(true)
        hostAt(null, 'agentNetwork.refresh', { id: null })
          .catch(() => {})
          .finally(() => setBusy(false))
      }}
    />
  )
}

/** A file's name without its extension, as a subscription's name. */
function nameOfFile(file: File): string {
  const base = cleanSubscriptionName(file.name.replace(/\.[^.]*$/, '').replace(/\|/g, ' '))
  return base.slice(0, SUBSCRIPTION_NAME_CHARS).trim()
}

/**
 * Add from a link or, with `fromFile`, from a file; or rename with `sub`. The link and the
 * file's content never come back.
 */
export function SubscriptionDialog({
  sub,
  fromFile = false,
  open,
  onOpenChange,
}: {
  sub: SubscriptionView | null
  fromFile?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  // The parent keys the dialog by what it edits, so each opening starts afresh.
  const [name, setName] = useState(sub?.name ?? '')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const clean = cleanSubscriptionName(name)
  const nameOk = isSubscriptionName(clean)
  const adding = sub === null
  const urlOk = !adding || fromFile || /^https?:\/\/[^\s/]+\S*$/i.test(url.trim())
  const fileTooLarge = file !== null && file.size > MAX_SUBSCRIPTION_BYTES
  const sourceOk = !adding || (fromFile ? file !== null && !fileTooLarge : url.trim() !== '')
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!nameOk || !urlOk || !sourceOk || busy) return
    setBusy(true)
    setError(null)
    try {
      if (sub) await hostAt(null, 'agentNetwork.renameSubscription', { id: sub.id, name: clean })
      else if (fromFile && file) {
        const content = await readPicked(file, t)
        await hostAt(null, 'agentNetwork.importSubscription', { name: clean, content })
      } else await hostAt(null, 'agentNetwork.addSubscription', { name: clean, url: url.trim() })
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
          <SettingsDialogHeader
            title={t(
              sub
                ? 'network.rename.title'
                : fromFile
                  ? 'network.import.title'
                  : 'network.add.title',
            )}
          />
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
            {adding && fromFile && (
              <SettingsField
                label={t('network.import.file')}
                hint={
                  error ? (
                    <span className="kettu-sd__error">{error}</span>
                  ) : fileTooLarge ? (
                    <span className="kettu-sd__error">{t('network.import.tooLarge')}</span>
                  ) : (
                    t('network.import.hint')
                  )
                }
              >
                <div className="flex min-w-0 items-center gap-2">
                  <FilePicker
                    inputRef={fileInput}
                    picked={(picked) => {
                      setFile(picked)
                      setError(null)
                      if (name.trim() === '') setName(nameOfFile(picked))
                    }}
                  />
                  <SetButton type="button" onClick={() => fileInput.current?.click()}>
                    {t('network.import.choose')}
                  </SetButton>
                  {file && <span className="k-fact truncate">{file.name}</span>}
                </div>
              </SettingsField>
            )}
            {adding && !fromFile && (
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
              disabled={!nameOk || !urlOk || !sourceOk}
            >
              {t(
                sub ? 'network.rename.save' : fromFile ? 'network.import.save' : 'network.add.save',
              )}
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
  const subs = useAgentNetworkStore((s) => s.status?.subscriptions ?? NO_SUBSCRIPTIONS)
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

const NO_INTERFACES: NetworkInterfaceView[] = []

/** The computer's interfaces as last read; empty until read. */
function useInterfaces(): NetworkInterfaceView[] {
  return useAgentNetworkStore((s) => s.interfaces ?? NO_INTERFACES)
}

/** An interface an agent is bound to, with its live state: connected, disconnected or gone. */
function interfaceLabel(
  name: string,
  interfaces: NetworkInterfaceView[],
  t: TFunction<'settings'>,
): string {
  const found = interfaces.find((item) => item.name === name)
  // Until the list is read, the name alone, rather than a state not known yet.
  if (interfaces.length === 0 || found?.up) return t('network.choice.interface', { name })
  return t(found ? 'network.choice.interfaceDown' : 'network.choice.interfaceGone', { name })
}

/** Sets one agent's choice: null follows the default. */
function setChoice(agentId: AgentId, choice: AgentNetworkChoice | null) {
  const agents = { ...useSettingsStore.getState().settings.agentNetwork.agents }
  if (choice === null) delete agents[agentId]
  else agents[agentId] = choice
  return update({ agentNetwork: { agents } })
}

/** Follow the default, a node, one network interface, or the system's network, for one agent. */
export function NetworkChoiceSelect({ agentId, label }: { agentId: AgentId; label: string }) {
  const { t } = useTranslation('settings')
  const network = useSettingsStore((s) => s.settings.agentNetwork)
  const subs = useAgentNetworkStore((s) => s.status?.subscriptions ?? NO_SUBSCRIPTIONS)
  const interfaces = useInterfaces()
  const options = useNodeOptions()
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const choice = network.agents[agentId]
  const bound = typeof choice === 'object' && 'interface' in choice ? choice.interface : null
  // An agent bound to an interface shows its state live.
  useLiveInterfaces(bound !== null)
  const value =
    choice === undefined
      ? 'default'
      : choice === 'system'
        ? 'system'
        : 'interface' in choice
          ? 'interface'
          : `node:${nodeKey(choice)}`
  const all: { value: string; label: string; hint?: string }[] = [
    {
      value: 'default',
      label: network.defaultNode
        ? t('network.choice.followNamed', { node: nodeLabel(network.defaultNode, subs) })
        : t('network.choice.follow'),
    },
    ...options,
  ]
  if (typeof choice === 'object' && !('interface' in choice)) {
    if (!options.some((o) => o.value === value)) {
      all.push({ value, label: t('network.choice.gone', { node: nodeLabel(choice, subs) }) })
    }
  }
  if (bound !== null) {
    all.push({ value: 'interface', label: interfaceLabel(bound, interfaces, t) })
  }
  all.push({ value: 'pick-interface', label: t('network.choice.pickInterface') })
  all.push({ value: 'system', label: t('network.choice.system') })
  const agentName = useAgentNetworkName(agentId)
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
          if (next === 'interface') return
          if (next === 'pick-interface') {
            setPicking(true)
            return
          }
          const ref = next.startsWith('node:') ? nodeOfKey(next.slice('node:'.length)) : null
          const picked = next === 'default' ? null : next === 'system' ? 'system' : ref
          if (next.startsWith('node:') && !ref) return
          setChoice(agentId, picked).catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
      <InterfaceDialog
        key={picking ? 'open' : 'closed'}
        open={picking}
        agent={agentName}
        current={bound}
        onOpenChange={setPicking}
        onPick={(name) => setChoice(agentId, { interface: name })}
      />
    </>
  )
}

/** The agent's name as Settings shows it, for the dialog's line. */
function useAgentNetworkName(agentId: AgentId): string {
  const name = useAgentsStore((s) => s.byId[agentId]?.name)
  return name ?? agentId
}

/** A connected or disconnected mark, and a TUN or VPN one, for an interface. */
function InterfaceMarks({ item }: { item: NetworkInterfaceView }) {
  const { t } = useTranslation('settings')
  return (
    <>
      <Pill tone={item.up ? 'success' : 'warning'}>
        {t(item.up ? 'network.interfaces.up' : 'network.interfaces.down')}
      </Pill>
      {item.tunnel && <Pill>{t('network.interfaces.tunnel')}</Pill>}
    </>
  )
}

/**
 * Picks the one interface an agent's traffic leaves through, from the computer's interfaces with
 * their live state; `onPick` saves it.
 */
function InterfaceDialog({
  open,
  agent,
  current,
  onOpenChange,
  onPick,
}: {
  open: boolean
  agent: string
  current: string | null
  onOpenChange: (open: boolean) => void
  onPick: (name: string) => Promise<unknown>
}) {
  const { t } = useTranslation(['settings', 'common'])
  const read = useAgentNetworkStore((s) => s.interfaces)
  const interfaces = read ?? NO_INTERFACES
  const [chosen, setChosen] = useState<string | null>(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useLiveInterfaces(open)
  // A bound interface that is gone stays listed, so the dialog shows what the agent is set to.
  const listed =
    current !== null && read !== null && !interfaces.some((item) => item.name === current)
      ? [...interfaces, { name: current, description: null, up: false, tunnel: false }]
      : interfaces
  const save = async (): Promise<void> => {
    if (chosen === null || busy) return
    setBusy(true)
    setError(null)
    try {
      await onPick(chosen)
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent className="sm:max-w-130">
        <SettingsDialogHeader title={t('network.interfaces.title')}>
          {t('network.interfaces.body', { agent })}
        </SettingsDialogHeader>
        <SettingsDialogBody>
          {read === null ? (
            <p className="kettu-sd__text">{t('network.interfaces.loading')}</p>
          ) : listed.length === 0 ? (
            <p className="kettu-sd__text">{t('network.interfaces.empty')}</p>
          ) : (
            <RadioGroup
              aria-label={t('network.interfaces.title')}
              value={chosen}
              onValueChange={(name) => setChosen(name as string)}
              className="kettu-sd__choices"
            >
              {listed.map((item) => (
                <RadioGroupTile key={item.name} value={item.name} className={SETTINGS_TILE}>
                  <span className="ui-sg-label">
                    <b className="k-row-title">
                      {item.name}
                      <InterfaceMarks item={item} />
                    </b>
                    {item.description && <small>{item.description}</small>}
                  </span>
                </RadioGroupTile>
              ))}
            </RadioGroup>
          )}
          {error && <span className="kettu-sd__error">{error}</span>}
        </SettingsDialogBody>
        <SettingsDialogFooter>
          <DialogClose render={<SetButton size="md" variant="ghost" />}>
            {t('common:actions.cancel')}
          </DialogClose>
          <SetButton
            size="md"
            variant="primary"
            loading={busy}
            disabled={chosen === null}
            onClick={() => void save()}
          >
            {t('network.interfaces.save')}
          </SetButton>
        </SettingsDialogFooter>
      </SettingsDialogContent>
    </Dialog>
  )
}

/** One of the computer's interfaces in Settings › Agent network, with the agents bound to it. */
export function InterfaceRow({ item, agents }: { item: NetworkInterfaceView; agents: string[] }) {
  const { t } = useTranslation('settings')
  // Shown, so its state stays live.
  useLiveInterfaces(true)
  const lines = [
    item.description,
    agents.length > 0 ? t('network.interfaces.bound', { agents: agents.join(', ') }) : null,
  ].filter(Boolean)
  return (
    <RowShell>
      <RowLine text={<RowText name={item.name} description={lines.join(' · ') || undefined} />}>
        <InterfaceMarks item={item} />
      </RowLine>
    </RowShell>
  )
}

/** No interface read yet, or none found; reads them while shown. */
export function InterfacesEmpty() {
  const { t } = useTranslation('settings')
  const read = useAgentNetworkStore((s) => s.interfaces !== null)
  useLiveInterfaces(true)
  return (
    <RowShell>
      <EmptyRow
        title={t(read ? 'network.interfaces.empty' : 'network.interfaces.loading')}
        hint={t('network.interfaces.description')}
      />
    </RowShell>
  )
}

/** Reads the interfaces again now. */
export function RefreshInterfacesAction() {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  return (
    <IconAction
      label={t('network.interfaces.refresh')}
      icon={RefreshIcon}
      busy={busy}
      onClick={() => {
        setBusy(true)
        loadInterfaces()
          .catch(() => {})
          .finally(() => setBusy(false))
      }}
    />
  )
}

/** A country or region's name in the interface's language, from its ISO code. */
function regionName(code: string): string {
  try {
    return new Intl.DisplayNames([i18n.language], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

function exitText(exit: ExitIp | null, t: TFunction<'settings'>): string {
  if (!exit) return t('network.exit.unchecked')
  if (exit.failure === 'unsupported') return t('network.exit.unsupported')
  const via = exit.via
  if (!exit.ip) return t(`network.exit.${via}Unreachable`)
  return exit.country
    ? t(`network.exit.${via}`, { ip: exit.ip, country: regionName(exit.country) })
    : t(`network.exit.${via}IpOnly`, { ip: exit.ip })
}

/** Where the agent's traffic last left from, or that it could not get out. */
export function ExitLine({ agentId }: { agentId: AgentId }) {
  const { t } = useTranslation('settings')
  const exit = useExitIp(agentId)
  return <span className={exit && !exit.ip ? 'text-danger' : undefined}>{exitText(exit, t)}</span>
}

/** Checks the agent's exit now, through its own listener while it uses a node. */
export function ExitCheckAction({ agentId }: { agentId: AgentId }) {
  const { t } = useTranslation('settings')
  const busy = useAgentNetworkStore((s) => s.checkingExit[agentId] === true)
  return (
    <IconAction
      label={t('network.exit.check')}
      icon={Globe02Icon}
      busy={busy}
      onClick={() => void checkExit(agentId).catch(() => {})}
    />
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
      <RowLine
        text={
          <RowText
            name={name}
            description={
              <>
                {t('network.choice.description')}
                <br />
                <ExitLine agentId={agentId} />
              </>
            }
          />
        }
      >
        <ExitCheckAction agentId={agentId} />
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
