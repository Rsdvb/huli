// Settings > Agents: the agents a user picks to work with, each a harness with a configuration
// folder and a name, with its account, sign-in, API key, usage and configuration. Installs and
// updates are Settings > Harnesses'.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  Add01Icon,
  CommandLineIcon,
  ComputerTerminal01Icon,
  Edit02Icon,
  FolderOpenIcon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentAccount, AgentStatus } from '@shared/agent-host'
import { apiKeyProblem } from '@shared/api-key'
import {
  CODEBUDDY_SITES,
  isFullAccessMode,
  KEY_ONLY_ADDED_HARNESSES,
  signsInWithKeyOnly,
  takesClaudeSettings,
  takesCodebuddySettings,
  takesCodexSettings,
  takesStartMode,
  type CodebuddySite,
} from '@shared/agents'
import { takesAutoCompact } from '@shared/auto-compact'
import {
  AGENT_COLORS,
  AGENT_NAME_CHARS,
  agentColor,
  isAgentColor,
  type AgentColor,
} from '@shared/settings'
import { MULTI_AGENT_HARNESSES, type AgentId, type HarnessId } from '@shared/thread'
import { onAppEvent } from '@renderer/app/events'
import { AgentMark, AgentTile } from '@renderer/components/agents/agent-mark'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import { joinPlanTier } from '@renderer/features/account/model'
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
import { RadioGroup, RadioGroupItem } from '@renderer/components/ui/radio-group'
import { toast } from '@renderer/components/ui/toast'
import { signInTerminal as openSignInTerminal } from '@renderer/features/agents/agent-sign-in'
import { AgentStateLine } from '@renderer/features/agents/agent-state'
import { startAgentInTerminal, useStartsInTerminal } from '@renderer/features/agents/agent-terminal'
import { NodeInstallAction } from '@renderer/features/agents/node-install'
import { programCopy } from '@renderer/features/agents/harness-problem'
import { readiness, type AgentReadiness } from '@renderer/features/agents/readiness'
import { errorMessage } from '@renderer/lib/host'
import { newestLimits } from '@renderer/lib/plan-readings'
import { i18n } from '@renderer/lib/i18n'
import { isWeb } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import {
  optionsLoaded,
  optionsOn,
  readHostAgentOptions,
  useAgentOptionsStore,
} from '@renderer/stores/agent-options'
import {
  addableHarnesses,
  cancelAgentSignIn,
  signInAgent,
  useAgentsStore,
  usePlanReadings,
  useSignInImage,
  useSignInPage,
  useSignInStarted,
  type AgentsStoreHook,
} from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { openAgentSettings, openHarnessSettings, openMarketplace } from '@renderer/stores/view'
import {
  Fact,
  ListMeter,
  MovedAccountsNotice,
  ProblemFixButton,
  SignInNotice,
  UsageGroup,
  WithCode,
} from './agent-parts'
import { NetworkChoiceRow } from './agent-network-rows'
import { RemoveAgentDialog } from './agent-remove'
import { ResetRow } from './agent-reset'
import { BalanceGroup } from './agent-balance'
import { ProfilesGroup } from './agent-profiles'
import { AgentProviders, ModelProviders } from './agent-providers'
import {
  currentLimits,
  FOLLOW_AGENT,
  asksForKey,
  harnessVersion,
  startModeView,
  useAction,
  useAgentReads,
  useHasOtherAgents,
  useSignInRead,
} from './agent-helpers'
import {
  CONFIRM,
  ControlError,
  DangerButton,
  IconAction,
  PathText,
  Pill,
  SetButton,
  SettingSelect,
  SettingSwitch,
  Skel,
  Spin,
} from './controls'
import { AutoCompactRows } from './auto-compact-rows'
import { ClaudeSettingsRows } from './claude-settings-rows'
import { CodebuddySettingsRows } from './codebuddy-settings-rows'
import { CodexSettingsRows } from './codex-settings-rows'
import { PlaceRow } from './places'
import {
  DIALOG_FIELD,
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'
import {
  EmptyRow,
  GroupLabel,
  ItemPageHeader,
  ItemRow,
  RowFrame,
  RowGroup,
  RowLine,
  RowShell,
  RowText,
} from './rows'
import { entryText } from './model'
import { useApply } from './use-apply'

/** How long the dialog waits for the host to list an agent it just added, before giving up. */
const ADDED_WAIT_MS = 10_000

/** Resolves once the host lists the agent, which follows the settings change that added it. */
function listed(agents: AgentsStoreHook, agentId: AgentId, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const known = agents.getState().byId[agentId]
    if (known && known.registered !== false) return resolve()
    const timer = setTimeout(() => {
      stop()
      reject(new Error(i18n.t('settings:agents.add.notListed', { name })))
    }, ADDED_WAIT_MS)
    const stop = agents.subscribe((state) => {
      const status = state.byId[agentId]
      if (!status || status.registered === false) return
      clearTimeout(timer)
      stop()
      resolve()
    })
  })
}

/**
 * Runs the agent's terminal sign-in in a built-in terminal, which closes Settings; Huli: with the
 * way back to the agent's page once it is done.
 */
function signInTerminal(status: AgentStatus, command: string): void {
  if (openSignInTerminal(status, command)) offerWayBack(status)
}

/** Huli: how long a terminal sign-in is followed for the way back to the agent's page. */
const WAY_BACK_MS = 10 * 60_000

/** Huli: how long after its terminal is done the sign-in is given to show. */
const WAY_BACK_GRACE_MS = 3_000

/**
 * Huli: Settings closed for a terminal sign-in. Once the agent is found signed in, or its terminal
 * is done without that, a toast says so with the way back to the agent's page.
 */
function offerWayBack(status: AgentStatus): void {
  const { id, name } = status
  const signedIn = (): boolean => useAgentsStore.getState().byId[id]?.signIn === 'signed-in'
  const before = signedIn()
  let done = false
  const finish = (ok: boolean): void => {
    if (done) return
    done = true
    stop()
    toast(
      i18n.t(ok ? 'settings:agents.signInDone' : 'settings:agents.signInNotDone', { name }),
      { label: i18n.t('settings:agents.backToAgent'), onClick: () => openAgentSettings(id) },
      { tone: ok ? 'success' : 'warning' },
    )
  }
  const unsubscribe = useAgentsStore.subscribe(() => {
    if (!before && signedIn()) finish(true)
  })
  const unlisten = onAppEvent((event) => {
    if (event.kind !== 'sign-in-finished' || event.agentId !== id || event.hostId !== null) return
    setTimeout(() => finish(signedIn()), WAY_BACK_GRACE_MS)
  })
  const timer = setTimeout(() => {
    done = true
    stop()
  }, WAY_BACK_MS)
  function stop(): void {
    unsubscribe()
    unlisten()
    clearTimeout(timer)
  }
}

function useAddable(): AgentStatus[] {
  const { useAgentsStore } = useHostScope()
  return useAgentsStore(useShallow((s) => addableHarnesses(s.order, s.byId)))
}

/**
 * What the account line says. A missing program or a failed start comes first. An email is shown
 * as itself; an account without one is named by how it signs in or its plan, and an agent that
 * signs in to each provider itself by those providers. Null when Kettu knows none of these.
 */
function accountIdentity(
  status: AgentStatus,
  account: AgentAccount | null,
  ready: AgentReadiness,
  reading: boolean,
  text: (key: 'agents.needsSignInLine' | 'agents.readingAccount') => string,
): { tone: 'clear' | 'quiet' | 'failed'; text: string } | null {
  if (ready.kind === 'failed') return { tone: 'failed', text: ready.message }
  if (ready.kind === 'missing') return { tone: 'clear', text: ready.message }
  const email = account?.email?.trim()
  if (email) return { tone: 'clear', text: email }
  const label = account?.label.trim()
  if (label) return { tone: 'clear', text: joinPlanTier(label, account?.tier) }
  if (ready.kind === 'sign-in') return { tone: 'quiet', text: text('agents.needsSignInLine') }
  const providers = status.modelProviders?.map((provider) => provider.id) ?? []
  if (providers.length > 0) return { tone: 'clear', text: providers.join(' · ') }
  if (reading && status.capabilities.account)
    return { tone: 'quiet', text: text('agents.readingAccount') }
  return null
}

/** One agent in the list: its name, then its account and plan, and its plan usage at the end. */
export function AgentListItem({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const dot = useScopedDot(status)
  const hasOthers = useHasOtherAgents(status)
  const now = useNow()
  const ready = readiness(status)
  const reading = useAgentReads(status)
  const account = status.account?.kind === 'none' ? null : status.account
  const limits = currentLimits(newestLimits(usePlanReadings(), status), now)
  const off = status.disabled === true
  const identity = accountIdentity(status, account, ready, reading, (key) => t(key))
  const blocked = ready.kind === 'missing' || ready.kind === 'failed'
  const email = account?.email?.trim() ?? ''
  const label = account?.label.trim() ?? ''
  // The plan follows the email; without one, the plan or sign-in method is the account itself.
  const plan = !blocked && email && label ? joinPlanTier(label, account?.tier) : ''
  const line = [identity?.text, plan].filter(Boolean).join(' · ')
  const end: ReactNode =
    ready.kind === 'sign-in' ? (
      <Pill tone="attention">{t('agents.signInPill')}</Pill>
    ) : limits.length > 0 ? (
      <ListMeter limits={limits} />
    ) : status.capabilities.reports ? (
      <ListMeter limits={[]} reading={reading} />
    ) : null
  return (
    <ItemRow
      item={status.id}
      label={status.name}
      onOpen={() => openAgentSettings(status.id)}
      tile={
        <span className={cn('k-agent-mark', off && 'k-off')}>
          <AgentTile agent={status.id} size={32} dot={dot} />
        </span>
      }
      name={
        <>
          <span className="k-name">{status.name}</span>
          {status.isDefault && hasOthers && <Pill>{t('agents.default')}</Pill>}
          {off && <Pill>{t('agents.turnedOff')}</Pill>}
        </>
      }
      right={off ? null : end}
    >
      {line && (
        <small title={line} className={identity?.tone === 'failed' ? 'k-error' : undefined}>
          {line}
        </small>
      )}
    </ItemRow>
  )
}

/** The list's own action: add an agent. */
export function AgentsGroupActions() {
  return <AddAgentButton primary />
}

/** Adding stays discoverable before the first harness is installed. */
function AddAgentButton({ primary = false }: { primary?: boolean }) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const addable = useAddable()
  const add = (): void => {
    if (addable.length === 0) openHarnessSettings(null)
    else setOpen(true)
  }
  return (
    <>
      <SetButton
        ref={trigger}
        variant={primary ? 'primary' : 'ghost'}
        icon={<Icon icon={Add01Icon} size={14} />}
        onClick={add}
      >
        {t('agents.add.button')}
      </SetButton>
      <AddAgentDialog open={open} onOpenChange={setOpen} harnesses={addable} finalFocus={trigger} />
    </>
  )
}

export function NoAgents() {
  const { t } = useTranslation('settings')
  const addable = useAddable()
  return (
    <EmptyRow
      title={t('agents.empty.title')}
      hint={t(addable.length > 0 ? 'agents.empty.installed' : 'agents.empty.description')}
      action={<AddAgentButton primary />}
    />
  )
}

/** Under the list: installation and registration are separate choices. */
export function AgentsFooter() {
  const { t } = useTranslation('settings')
  return (
    <p className="ui-sg-hint">
      {t('agents.footerBefore')}
      <button type="button" onClick={() => openHarnessSettings(null)} className="k-link">
        {t('sections.harnesses')}
      </button>
      {t('agents.footerAfter')}
      <span className="block">{t('agents.registrationNote')}</span>
    </p>
  )
}

type Login = 'terminal' | 'api-key'

/** Huli: the agent a try of Add agent made: its id and name, its harness and folder choice. */
interface Made {
  id: AgentId
  name: string
  harness: AgentStatus
  folder: 'default' | 'new' | 'existing'
}

/**
 * Adding an agent: its harness, its name, its folder (a new one or an existing one picked in the
 * dialog), and how it signs in: in a terminal, or with an API key the harness keeps.
 */
function AddAgentDialog({
  open,
  onOpenChange,
  harnesses,
  finalFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  harnesses: AgentStatus[]
  /** Takes focus on close: the dialog's autofocused field is taken for the opener otherwise. */
  finalFocus: RefObject<HTMLElement | null>
}) {
  const { api, request, useAgentsStore, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [harness, setHarness] = useState<HarnessId>(harnesses[0]?.harnessId ?? 'claude-code')
  const [name, setName] = useState('')
  const [folder, setFolder] = useState<'default' | 'new' | 'existing'>('default')
  const [picked, setPicked] = useState<string | null>(null)
  const [login, setLogin] = useState<Login>('terminal')
  const [site, setSite] = useState<CodebuddySite>('international')
  const [key, setKey] = useState({ baseUrl: '', key: '', model: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Huli: the agent a try made before a later step failed, which a retry goes on with instead of
  // making another; its harness and folder stay as they were.
  const [made, setMade] = useState<Made | null>(null)
  const chosen = made?.harness ?? harnesses.find((h) => h.harnessId === harness) ?? harnesses[0]
  const canUseDefault = made ? made.folder === 'default' : chosen?.registered === false
  const multiple = !!chosen && MULTI_AGENT_HARNESSES.includes(chosen.harnessId)
  const selectedFolder = made?.folder ?? (folder === 'default' && !canUseDefault ? 'new' : folder)
  const useDefault = selectedFolder === 'default'
  const trimmed = useDefault ? (chosen?.harnessName ?? '') : name.trim()
  const tooLong = [...trimmed].length > AGENT_NAME_CHARS
  const providers = chosen?.apiKey?.providers ?? false
  // An added agent of such a harness has no other sign-in, and picks the site its key is from.
  const keyOnly = !useDefault && !!chosen && KEY_ONLY_ADDED_HARNESSES.includes(chosen.harnessId)
  const loginMode: Login = keyOnly ? 'api-key' : login
  const valid =
    !!chosen &&
    trimmed.length > 0 &&
    !tooLong &&
    (useDefault || multiple) &&
    (selectedFolder !== 'existing' || picked !== null) &&
    (useDefault || loginMode === 'terminal' || key.key.trim().length > 0)

  const reset = (): void => {
    setName('')
    setFolder('default')
    setPicked(null)
    setLogin('terminal')
    setSite('international')
    setKey({ baseUrl: '', key: '', model: '' })
    setError(null)
    setBusy(false)
    setMade(null)
  }

  const pick = async (): Promise<void> => {
    try {
      const path = await api.dialogs.chooseAgentFolder()
      if (path) {
        setPicked(path)
        setFolder('existing')
      }
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy || !chosen) return
    // Huli: a key the host would refuse is refused before the agent is made.
    const problem = !useDefault && loginMode === 'api-key' ? keyProblem(key, providers) : null
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      let id: AgentId
      if (made) {
        id = made.id
        if (!useDefault && made.name !== trimmed) {
          await api.settings.renameAgent(id, trimmed)
          setMade({ ...made, name: trimmed })
        }
      } else {
        id = useDefault
          ? chosen.harnessId
          : await api.settings.addAgent(
              chosen.harnessId,
              trimmed,
              selectedFolder === 'new' ? null : picked,
            )
        setMade({ id, name: trimmed, harness: chosen, folder: selectedFolder })
      }
      if (useDefault) {
        await useSettingsStore.getState().update({
          agents: { [chosen.harnessId]: { enabled: true, hidden: false } },
        })
      }
      await listed(useAgentsStore, id, trimmed)
      if (keyOnly) {
        await request('agents.setCodebuddySite', { agentId: id, change: { site } })
      }
      if (!useDefault && loginMode === 'api-key') {
        await request('agents.setApiKey', {
          agentId: id,
          key: key.key.trim(),
          ...(providers && key.baseUrl.trim() ? { baseUrl: key.baseUrl.trim() } : {}),
          ...(providers && key.model.trim() ? { model: key.model.trim() } : {}),
        })
      }
      onOpenChange(false)
      reset()
      openAgentSettings(id)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <SettingsDialogContent className="sm:max-w-135" finalFocus={finalFocus}>
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <SettingsDialogHeader title={t('agents.add.title')}>
            {t('agents.add.description')}
          </SettingsDialogHeader>
          <SettingsDialogBody>
            {made && (
              <p className="kettu-sd__hint" role="status" data-wrap="">
                {t('agents.add.made', { name: made.name })}
              </p>
            )}
            <SettingsField label={t('agents.add.harness')}>
              <SettingSelect
                label={t('agents.add.harness')}
                className="k-select--full"
                value={chosen?.harnessId ?? harness}
                disabled={made !== null}
                options={(made ? [made.harness] : harnesses).map((h) => ({
                  value: h.harnessId,
                  label: h.harnessName,
                  icon: <AgentMark agent={h.harnessId} size={16} />,
                }))}
                onChange={(next) => {
                  setHarness(next)
                  setPicked(null)
                  setFolder('default')
                }}
              />
            </SettingsField>
            {!useDefault && (
              <SettingsField
                label={t('agents.add.name')}
                htmlFor="agent-name"
                hint={
                  tooLong && (
                    <span className="kettu-sd__error">
                      {t('agents.add.nameTooLong', { count: AGENT_NAME_CHARS })}
                    </span>
                  )
                }
              >
                <input
                  id="agent-name"
                  value={name}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('agents.add.namePlaceholder')}
                  aria-invalid={tooLong || undefined}
                  className={DIALOG_FIELD}
                  onChange={(event) => setName(event.target.value)}
                />
              </SettingsField>
            )}
            <SettingsField label={t('agents.add.folder')}>
              <RadioGroup
                aria-label={t('agents.add.folder')}
                value={selectedFolder}
                disabled={made !== null}
                onValueChange={(next) => setFolder(next as typeof folder)}
                className="kettu-sd__choices"
              >
                {canUseDefault && (
                  <Choice
                    value="default"
                    checked={useDefault}
                    title={t('agents.add.folderDefault')}
                    description={t('agents.add.folderDefaultHint', {
                      name: chosen?.harnessName ?? '',
                    })}
                    // Huli: which folder that is, where the harness keeps one.
                    extra={
                      useDefault &&
                      chosen?.configDir?.runs && <PathText path={chosen.configDir.runs} />
                    }
                  />
                )}
                {multiple && (
                  <>
                    <Choice
                      value="new"
                      checked={selectedFolder === 'new'}
                      title={t('agents.add.folderNew')}
                      description={t('agents.add.folderNewHint')}
                    />
                    <Choice
                      value="existing"
                      checked={selectedFolder === 'existing'}
                      title={t('agents.add.folderExisting')}
                      description={t('agents.add.folderExistingHint')}
                      extra={
                        selectedFolder === 'existing' && (
                          <span className="k-end k-shrink">
                            {picked && <PathText path={picked} />}
                            <SetButton
                              icon={<Icon icon={FolderOpenIcon} size={14} />}
                              onClick={() => void pick()}
                            >
                              {t('agents.add.choose')}
                            </SetButton>
                          </span>
                        )
                      }
                    />
                  </>
                )}
              </RadioGroup>
            </SettingsField>
            {keyOnly && (
              <SettingsField label={t('agents.add.site')} hint={t('agents.add.siteHint')}>
                <SettingSelect
                  label={t('agents.add.site')}
                  className="k-select--full"
                  value={site}
                  options={CODEBUDDY_SITES.map((value) => ({
                    value,
                    label: t(`agents.codebuddy.site.${value}`),
                  }))}
                  onChange={setSite}
                />
              </SettingsField>
            )}
            {!useDefault && (
              <SettingsField
                label={t('agents.add.login')}
                hint={keyOnly && t('agents.keyOnly.note', { name: chosen?.harnessName ?? '' })}
              >
                <RadioGroup
                  aria-label={t('agents.add.login')}
                  value={loginMode}
                  onValueChange={(next) => setLogin(next as Login)}
                  className="kettu-sd__choices"
                >
                  {!keyOnly && (
                    <Choice
                      value="terminal"
                      checked={loginMode === 'terminal'}
                      title={t('agents.add.loginTerminal')}
                      description={t('agents.add.loginTerminalHint', {
                        name: chosen?.harnessName ?? '',
                      })}
                    />
                  )}
                  <Choice
                    value="api-key"
                    checked={loginMode === 'api-key'}
                    title={t('agents.add.loginKey')}
                    description={t(
                      providers
                        ? 'agents.add.loginKeyHint'
                        : chosen?.harnessId === 'deepseek'
                          ? 'agents.add.loginKeyHintDeepSeek'
                          : chosen?.harnessId === 'codebuddy'
                            ? 'agents.add.loginKeyHintCodebuddy'
                            : 'agents.add.loginKeyHintOpenAi',
                    )}
                    extra={
                      loginMode === 'api-key' &&
                      chosen && <ApiKeyFields status={chosen} value={key} onChange={setKey} />
                    }
                  />
                </RadioGroup>
              </SettingsField>
            )}
            {error && <p className="kettu-sd__error">{error}</p>}
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
              disabled={!valid && !busy}
            >
              {t('agents.add.submit')}
            </SetButton>
          </SettingsDialogFooter>
        </form>
      </SettingsDialogContent>
    </Dialog>
  )
}

/** One choice of a few as a tile, with what it does under it and anything it needs inside. */
export function Choice({
  value,
  checked,
  title,
  description,
  extra,
}: {
  value: string
  checked: boolean
  title: string
  description: string
  extra?: ReactNode
}) {
  const id = useId()
  return (
    <div className="kettu-sd__choice" data-checked={checked || undefined}>
      <label htmlFor={id}>
        <RadioGroupItem id={id} value={value} className="mt-0.5" />
        <span className="ui-sg-label">
          <b>{title}</b>
          <small>{description}</small>
        </span>
      </label>
      {extra && <div className="kettu-sd__choice-extra">{extra}</div>}
    </div>
  )
}

interface KeyValue {
  baseUrl: string
  key: string
  model: string
}

/** Huli: why the key typed cannot be handed over, as the host would refuse it; null when it can. */
function keyProblem(value: KeyValue, providers: boolean): string | null {
  const problem = apiKeyProblem(
    {
      key: value.key,
      ...(providers && value.baseUrl.trim() ? { baseUrl: value.baseUrl } : {}),
      ...(providers && value.model.trim() ? { model: value.model } : {}),
    },
    providers,
  )
  return problem && i18n.t(`settings:agents.key.problem.${problem}`)
}

// Providers whose Anthropic-compatible address Claude Code takes, filled in with one click. Volcano
// Engine Ark's Coding Plan (Doubao), as its documentation gives it: no /v3 on the path.
const PROVIDER_PRESETS = [
  {
    id: 'doubao',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    model: 'ark-code-latest',
  },
  {
    id: 'doubaoIntl',
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding',
    model: 'ark-code-latest',
  },
] as const

/** The provider's address, the key and the model; Codex takes only an OpenAI key. */
function ApiKeyFields({
  status,
  value,
  onChange,
}: {
  status: AgentStatus
  value: KeyValue
  onChange: (value: KeyValue) => void
}) {
  const { t } = useTranslation('settings')
  const providers = status.apiKey?.providers ?? false
  return (
    <div className="kettu-sd__stack">
      <input
        id="agent-key"
        type="password"
        value={value.key}
        autoComplete="off"
        spellCheck={false}
        aria-label={t('agents.key.key')}
        placeholder={t('agents.key.key')}
        className={DIALOG_MONO_FIELD}
        onChange={(event) => onChange({ ...value, key: event.target.value })}
      />
      {providers && (
        <>
          <p className="kettu-sd__hint">
            {t('agents.key.presets')}
            {PROVIDER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="ml-2 font-medium text-foreground underline-offset-2 hover:underline focus-ring rounded-xs"
                onClick={() => onChange({ ...value, baseUrl: preset.baseUrl, model: preset.model })}
              >
                {t(`agents.key.preset.${preset.id}`)}
              </button>
            ))}
          </p>
          <input
            id="agent-base-url"
            value={value.baseUrl}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('agents.key.baseUrl')}
            placeholder={t('agents.key.baseUrlOptional')}
            className={DIALOG_MONO_FIELD}
            onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
          />
          <input
            id="agent-model"
            value={value.model}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('agents.key.model')}
            placeholder={t('agents.key.modelOptional')}
            className={DIALOG_MONO_FIELD}
            onChange={(event) => onChange({ ...value, model: event.target.value })}
          />
        </>
      )}
      <p className="kettu-sd__hint">
        {t(
          providers
            ? 'agents.key.noteClaude'
            : status.harnessId === 'codebuddy'
              ? 'agents.key.noteCodebuddy'
              : 'agents.key.noteCodex',
          { command: status.cli?.command ?? '' },
        )}
      </p>
    </div>
  )
}

/** An agent's own page: its account, API key, usage and configuration. */
export function AgentPage({ agentId }: { agentId: AgentId }) {
  const { useAgentsStore } = useHostScope()
  const status = useAgentsStore((s) => s.byId[agentId])
  if (!status) return <AgentPageHeader status={null} />
  return <AgentPageBody status={status} />
}

/** The page's header, without an agent once it is gone from the list. */
function AgentPageHeader({ status, actions }: { status: AgentStatus | null; actions?: ReactNode }) {
  const { t } = useTranslation('settings')
  const dot = useScopedDot(status ?? null)
  const hasOthers = useHasOtherAgents(status)
  const named = status?.account?.kind === 'none' ? '' : (status?.account?.label ?? '')
  // An agent named after its harness, with no account to name and no badge, adds no line.
  const subtitle =
    !!status && (status.name !== status.harnessName || !!named || !status.isDefault || hasOthers)
  return (
    <ItemPageHeader
      back={t('sections.agents')}
      onBack={() => openAgentSettings(null)}
      item={status?.id ?? 'agent'}
      icon={status && <AgentTile agent={status.id} size={42} dot={dot} />}
      title={status?.name ?? null}
      subtitle={status && subtitle && <AgentSubtitle status={status} />}
      actions={actions}
    >
      {status && <AgentPageLine status={status} />}
    </ItemPageHeader>
  )
}

/** Beside the mark: the harness and how the agent signs in, and renaming an added agent. */
function AgentSubtitle({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const hasOthers = useHasOtherAgents(status)
  const [renaming, setRenaming] = useState(false)
  // Huli: an account an earlier run remembered is not named while the sign-in is read again.
  const account =
    status.account?.kind === 'none' || status.readingSignIn === true ? null : status.account
  return (
    <>
      {/* As tall as the rename button, whether or not it shows. */}
      <span className="k-name k-tall">
        {[status.name === status.harnessName ? '' : status.harnessName, account?.label ?? '']
          .filter(Boolean)
          .join(' · ')}
      </span>
      {status.isDefault ? (
        hasOthers && <Pill>{t('agents.default')}</Pill>
      ) : (
        <>
          <IconAction
            label={t('agents.rename.button')}
            icon={Edit02Icon}
            onClick={() => setRenaming(true)}
          />
          <RenameDialog status={status} open={renaming} onOpenChange={setRenaming} />
        </>
      )}
    </>
  )
}

/** The line under it: the agent's state and the harness it runs on. */
function AgentPageLine({ status }: { status: AgentStatus }) {
  const { t } = useTranslation(['settings', 'agents'])
  const ready = readiness(status).kind === 'ready'
  const version = harnessVersion(status)
  const copy = programCopy(status)
  const harness = [
    t('agents.onHarness', {
      harness: version ? `${status.harnessName} ${version}` : status.harnessName,
    }),
    copy,
  ]
    .filter(Boolean)
    .join(' · ')
  if (status.disabled) {
    return (
      <>
        <span aria-hidden className="k-dot" />
        <span className="k-name">
          {t('agents.turnedOff')} · {harness}
        </span>
      </>
    )
  }
  // Huli: while the sign-in is read, the agent is not known to be ready.
  if (ready && status.readingSignIn) {
    return (
      <>
        <span aria-hidden className="ui-ss-spinner" />
        <span className="k-name">
          {t('agents:state.checkingSignIn')} · {harness}
        </span>
      </>
    )
  }
  return ready ? (
    <>
      <span aria-hidden className="k-dot" data-tone="ok" />
      <span className="k-name">
        {t('agents:state.ready')} · {harness}
      </span>
    </>
  ) : (
    <>
      <AgentStateLine status={status} />
      <span className="k-name">· {harness}</span>
    </>
  )
}

function AgentEnvKeyRow({
  agentId,
  agentName,
  variable,
}: {
  agentId: AgentId
  agentName: string
  variable: { name: string; optional: boolean; set: boolean }
}) {
  const { t } = useTranslation(['settings', 'common'])
  const { api } = useHostScope()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (next: string | null): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.setAgentEnv(agentId, variable.name, next)
      setValue('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <RowFrame
      text={
        <RowText
          name={variable.name}
          description={variable.set ? t('agents.key.envSet', { name: agentName }) : ''}
        />
      }
    >
      <div className="kettu-sd__stack">
        <input
          type="password"
          value={value}
          autoComplete="off"
          spellCheck={false}
          aria-label={variable.name}
          placeholder={variable.name}
          className={DIALOG_MONO_FIELD}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="flex gap-2">
          <SetButton disabled={busy || !value.trim()} onClick={() => void save(value)}>
            {t('agents.key.save')}
          </SetButton>
          {variable.set && (
            <SetButton variant="ghost" disabled={busy} onClick={() => void save(null)}>
              {t('agents.key.clear')}
            </SetButton>
          )}
        </div>
        <ControlError error={error} />
      </div>
    </RowFrame>
  )
}

function AgentPageBody({ status }: { status: AgentStatus }) {
  const { hostId, request } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [act, busy, error, clearError] = useAction()
  const r = readiness(status)
  const reading = useAgentReads(status, { force: status.signIn === 'required' })
  const signInReading = useSignInRead(status)
  const refreshAccount = useRefresh()
  const [accountError, setAccountError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const signOut = () => act(() => request('agents.logout', { agentId: status.id }))
  const running = status.state === 'ready'
  const providerMode = status.providers !== undefined
  const off = status.disabled === true
  const modelProviderMode = status.modelProviders !== undefined
  // A DeepSeek account is billed by use like an API key, with no plan limits.
  const dshAccount = status.harnessId === 'deepseek' && status.account?.kind === 'account'
  const terminalSignIn = status.authMethods.find(
    (m) => m.type === 'terminal' && m.command && !asksForKey(status, m),
  )
  const accountLabel = status.account?.kind === 'none' ? '' : (status.account?.label ?? '')
  const signInPage = useSignInPage(hostId, status.id)
  const signInImage = useSignInImage(hostId, status.id)
  const signInStarted = useSignInStarted(hostId, status.id)
  const remote = isWeb || hostId !== null
  // Huli: an error of a sign-in tried while the agent was off is gone once it is on again.
  useEffect(() => clearError(), [off, clearError])
  // Huli: the methods show as soon as the agent's start names them. A sign-in started here shows
  // while it waits, and an agent that tells whether it is signed in only once a session starts
  // offers its sign-in without saying it needs one.
  const readingMethods =
    status.readingSignIn === true ||
    (signInReading && status.signIn === 'unknown' && status.authMethods.length === 0)
  const waiting =
    (signInPage !== null || signInImage !== null || signInStarted) && status.signIn !== 'signed-in'
  const unsure = r.kind === 'ready' && status.signIn === 'unknown' && !readingMethods
  const pageSignIns =
    unsure && !off
      ? status.authMethods.filter((m) => m.type === 'agent' && !(remote && !m.delegated))
      : []
  // Huli: an agent that signs in only through its own page or picture has no terminal to name.
  const signsInItself =
    !terminalSignIn && status.authMethods.some((m) => m.type === 'agent' || m.type === 'env')
  // Only what the agent reported: the group goes when none of its rows has anything to show.
  const hasAccountRows =
    !!accountLabel ||
    readingMethods ||
    status.signIn === 'required' ||
    !!status.account?.email ||
    !!status.apiKey ||
    status.authMethods.some((m) => m.type === 'env' && (m.envVars?.length ?? 0) > 0) ||
    (!off && ((!!terminalSignIn && hostId === null) || pageSignIns.length > 0)) ||
    (status.canLogout && status.signIn === 'signed-in')
  const askSignOut = () => setSigningOut(true)
  const startsInTerminal = useStartsInTerminal(status, hostId)

  const actions = (
    <>
      {startsInTerminal && (
        <SetButton
          icon={<Icon icon={CommandLineIcon} size={14} />}
          title={t('agents.terminal.startHint')}
          onClick={() => void startAgentInTerminal(status, hostId)}
        >
          {t('agents.terminal.start')}
        </SetButton>
      )}
      {r.kind === 'failed' && (
        <SetButton
          loading={busy}
          icon={<Icon icon={RefreshIcon} size={14} />}
          onClick={() => act(() => request('agents.retry', { agentId: status.id }))}
        >
          {t('common:actions.retry')}
        </SetButton>
      )}
      {/* Huli: Kite's own Node.js install shows under the message instead. */}
      {r.kind === 'missing' && r.problem.fix && !r.node && (
        <ProblemFixButton status={status} fix={r.problem.fix} />
      )}
    </>
  )

  return (
    <div>
      <AgentPageHeader status={status} actions={actions} />

      <div>
        <EnableGroup status={status} />
        {(r.kind === 'failed' || r.kind === 'missing') && (
          <p
            className={r.kind === 'failed' ? 'ui-sg-hint k-error' : 'ui-sg-hint'}
            data-wrap=""
            data-selectable=""
          >
            <WithCode text={r.message} />{' '}
            {r.kind === 'missing' && !r.node && (
              <button
                type="button"
                onClick={() => openHarnessSettings(status.harnessId)}
                className="k-link"
              >
                {t('agents.openHarness', { harness: status.harnessName })}
              </button>
            )}
          </p>
        )}
        {r.kind === 'missing' && r.node && <NodeInstallAction className="mb-3" />}
        {status.movedAccounts?.refused && <MovedAccountsNotice status={status} />}
        {signsInWithKeyOnly(status.id) && (
          <p className="ui-sg-hint" data-wrap="">
            {t('agents.keyOnly.note', { name: status.harnessName })}
          </p>
        )}
        {!providerMode &&
          !off &&
          (r.kind === 'sign-in' || waiting) &&
          status.authMethods.length > 0 && (
            <div>
              <SignInNotice
                status={status}
                busy={busy}
                page={signInPage}
                image={signInImage}
                pending={signInStarted}
                remote={remote}
                {...(hostId === null && {
                  onTerminal: (command: string) => signInTerminal(status, command),
                })}
                {...(status.apiKey && { onApiKey: () => setKeyOpen(true) })}
                onAuthenticate={(methodId) => act(() => signInAgent(hostId, status.id, methodId))}
                onCancel={() => act(() => cancelAgentSignIn(hostId, status.id))}
              />
            </div>
          )}
        {error && (
          <p className="ui-sg-hint k-error" data-wrap="">
            {error}
          </p>
        )}

        {providerMode ? (
          <AgentProviders
            status={status}
            reading={reading}
            running={running}
            onSignIn={(command) => signInTerminal(status, command)}
          />
        ) : modelProviderMode ? (
          <ModelProviders
            status={status}
            reading={reading}
            onSignIn={hostId === null ? (command) => signInTerminal(status, command) : null}
          />
        ) : hasAccountRows ? (
          <section className="k-group" aria-label={t('agents.account')}>
            <GroupLabel
              group={{
                id: 'account',
                label: t('agents.account'),
                actions: status.capabilities.account ? (
                  <IconAction
                    label={t('agents.refreshAccount')}
                    icon={RefreshIcon}
                    busy={refreshAccount.phase === 'turning'}
                    onClick={() => {
                      setAccountError(null)
                      void refreshAccount
                        .run(() =>
                          request('agents.refreshAccount', { agentId: status.id, force: true }),
                        )
                        .catch((e: unknown) => setAccountError(errorMessage(e)))
                    }}
                  />
                ) : undefined,
              }}
            />
            {accountError && (
              <p className="ui-sg-hint k-error" data-wrap="">
                {accountError}
              </p>
            )}
            <RowGroup>
              {/* A subscription's label is its plan; the other kinds, and a DeepSeek account,
                  which has none, name how the agent signs in. */}
              {(accountLabel || readingMethods || status.signIn === 'required') && (
                <Fact
                  name={t(
                    status.account?.kind === 'account' && !dshAccount && !readingMethods
                      ? 'agents.plan'
                      : 'agents.loginMethod',
                  )}
                  pending={
                    readingMethods
                      ? t('agents.readingSignIn')
                      : status.signIn === 'required'
                        ? t('agents.notSignedIn')
                        : null
                  }
                >
                  {readingMethods ? null : accountLabel || null}
                </Fact>
              )}
              {status.account?.email && !readingMethods && (
                <Fact
                  name={t(status.account.email.includes('@') ? 'agents.email' : 'agents.phone')}
                >
                  {status.account.email}
                </Fact>
              )}
              {status.apiKey && (
                <ApiKeyRow status={status} open={keyOpen} onOpenChange={setKeyOpen} />
              )}
              {status.authMethods
                .filter((method) => method.type === 'env')
                .flatMap((method) =>
                  (method.envVars ?? []).map((variable) => (
                    <AgentEnvKeyRow
                      key={`${method.id}:${variable.name}`}
                      agentId={status.id}
                      agentName={status.name}
                      variable={variable}
                    />
                  )),
                )}
              {!off &&
                ((terminalSignIn && hostId === null) ||
                  pageSignIns.length > 0 ||
                  (status.canLogout && status.signIn === 'signed-in')) && (
                  <RowFrame
                    text={
                      <RowText
                        name={t('agents.signInRow')}
                        description={t(
                          unsure
                            ? 'agents.signInUnknownHint'
                            : signsInItself
                              ? 'agents.signInRowHintItself'
                              : 'agents.signInRowHint',
                          { name: status.name },
                        )}
                      />
                    }
                  >
                    {!waiting &&
                      pageSignIns.map((method) => (
                        <SetButton
                          key={method.id}
                          disabled={busy}
                          title={method.description}
                          onClick={() => act(() => signInAgent(hostId, status.id, method.id))}
                        >
                          {method.name}
                        </SetButton>
                      ))}
                    {status.canLogout && status.signIn === 'signed-in' && !off && (
                      <SetButton variant="ghost" disabled={busy} onClick={askSignOut}>
                        {t('agents.signOut')}
                      </SetButton>
                    )}
                    {terminalSignIn?.command && hostId === null && !off && (
                      <SetButton
                        icon={<Icon icon={ComputerTerminal01Icon} size={14} />}
                        onClick={() => signInTerminal(status, terminalSignIn.command!)}
                      >
                        {t(
                          status.signIn === 'signed-in'
                            ? 'agents.signInAgain'
                            : 'agents.signInInTerminal',
                        )}
                      </SetButton>
                    )}
                  </RowFrame>
                )}
            </RowGroup>
          </section>
        ) : null}

        {!providerMode && status.profiles && <ProfilesGroup status={status} />}

        {/* Spending is a usage statistic, shown on the Usage page; what is billed by use, as an
            API key, a provider or a DeepSeek account, has no plan limits to show here. Huli: a
            DeepSeek balance shows in its own group. */}
        {status.disabled ? null : status.balance !== undefined ? (
          <BalanceGroup status={status} reading={reading} />
        ) : providerMode ||
          modelProviderMode ||
          status.account?.kind === 'api_key' ||
          dshAccount ? null : (
          <UsageGroup status={status} reading={reading} running={running} />
        )}

        <ConfigurationGroup status={status} />

        <DangerGroup status={status} />
      </div>
      {/* Signing out of an agent that shares its sign-in signs its vendor's own apps out too;
          Huli: a default agent shares its folder with its CLI in a terminal, which signs out too. */}
      <AlertDialog open={signingOut} onOpenChange={setSigningOut}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                status.sharesSignIn ? 'agents.signOutShared.title' : 'agents.signOutConfirm.title',
                {
                  name: status.name,
                },
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {status.sharesSignIn
                ? t('agents.signOutShared.body', { name: status.name })
                : status.isDefault && status.cli?.command
                  ? t('agents.signOutConfirm.bodyCli', {
                      name: status.name,
                      command: status.cli.command,
                    })
                  : t('agents.signOutConfirm.body', { name: status.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setSigningOut(false)
                signOut()
              }}
            >
              {t('agents.signOutShared.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Turns the agent off and on: off, it never starts and nothing offers it, and nothing is lost. */
function EnableGroup({ status }: { status: AgentStatus }) {
  const { hostId, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [apply, error] = useApply()
  const [confirming, setConfirming] = useState(false)
  const stored = useSettingsStore((s) => s.settings.disabledAgents)
  const running = useSessionsStore(
    (s) =>
      Object.values(s.byId).filter(
        (session) =>
          hostOfSession(session) === hostId &&
          session.agentId === status.id &&
          (session.status === 'running' || session.status === 'awaiting_permission'),
      ).length,
  )
  // An older host reports nothing about it and takes no such setting.
  if (status.disabled === undefined) return null
  const off = stored ? stored.includes(status.id) : status.disabled
  const set = (disabled: boolean) => {
    const others = (stored ?? []).filter((id) => id !== status.id)
    apply({ disabledAgents: disabled ? [...others, status.id] : others })
  }
  return (
    <section className="k-group">
      <RowGroup>
        <RowShell id="enabled">
          <RowLine
            text={
              <RowText
                name={entryText('agents.enabled').name}
                description={t(off ? 'agents.enable.off' : 'agents.enable.on')}
              />
            }
          >
            <SettingSwitch
              label={t('agents.enable.switch', { name: status.name })}
              checked={!off}
              onChange={(on) => (on || running === 0 ? set(!on) : setConfirming(true))}
            />
          </RowLine>
          {error && (
            <p role="status" className="k-row-note k-error" data-wrap="">
              {error}
            </p>
          )}
        </RowShell>
      </RowGroup>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('agents.enable.confirmTitle', { name: status.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('agents.enable.confirmBody', { count: running })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirming(false)
                set(true)
              }}
            >
              {t('agents.enable.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** Whether Kettu handed the harness a key, and setting, replacing or clearing it. */
function ApiKeyRow({
  status,
  open,
  onOpenChange: setOpen,
}: {
  status: AgentStatus
  /** Huli: the dialog that sets the key, which the sign-in card opens too. */
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { request, useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [act, busy, error] = useAction()
  const [clearing, setClearing] = useState(false)
  // Huli: a key just saved is checked by reading the sign-in again, which says whether it took.
  const [check, setCheck] = useState<'checking' | 'rejected' | null>(null)
  const set = !!status.apiKey?.set
  const checkKey = (): void => {
    setCheck('checking')
    request('agents.readSignIn', { agentId: status.id })
      .catch(() => {})
      .then(() => {
        const signIn = useAgentsStore.getState().byId[status.id]?.signIn
        if (signIn === 'required') return setCheck('rejected')
        setCheck(null)
        if (signIn === 'signed-in') {
          toast(t('agents.key.accepted', { name: status.name }), undefined, { tone: 'success' })
        }
      })
  }
  const note =
    check === 'checking'
      ? t('agents.key.checking')
      : check === 'rejected'
        ? t('agents.key.rejected', { name: status.name })
        : null
  return (
    <RowFrame
      id="api-key"
      text={
        <RowText
          name={t('agents.key.row')}
          description={
            set
              ? t('agents.key.set', { name: status.harnessName })
              : t(
                  status.apiKey?.providers
                    ? 'agents.key.notSet'
                    : status.harnessId === 'deepseek'
                      ? 'agents.key.notSetDeepSeek'
                      : status.harnessId === 'codebuddy'
                        ? 'agents.key.notSetCodebuddy'
                        : 'agents.key.notSetOpenAi',
                )
          }
        />
      }
    >
      <ControlError error={error} />
      {note && (
        <span
          role="status"
          className={check === 'rejected' ? 'k-value k-error' : 'k-value k-muted'}
          data-wrap=""
        >
          {check === 'checking' && <Spin />}
          {note}
        </span>
      )}
      <SetButton
        onClick={() => {
          setCheck(null)
          setOpen(true)
        }}
      >
        {t(set ? 'agents.key.replace' : 'agents.key.setButton')}
      </SetButton>
      {set && (
        <SetButton variant="ghost" disabled={busy} onClick={() => setClearing(true)}>
          {t('agents.key.clear')}
        </SetButton>
      )}
      <ApiKeyDialog status={status} open={open} onOpenChange={setOpen} onSaved={checkKey} />
      {/* Huli: clearing the key signs the agent out; Codex's runs `codex logout`. */}
      <AlertDialog open={clearing} onOpenChange={setClearing}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('agents.key.clearConfirm.title', { name: status.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {status.harnessId === 'codex'
                ? t('agents.key.clearConfirm.bodyCodex', { name: status.name })
                : t('agents.key.clearConfirm.body', { name: status.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setClearing(false)
                setCheck(null)
                act(() => request('agents.clearApiKey', { agentId: status.id }))
              }}
            >
              {t('agents.key.clear')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </RowFrame>
  )
}

function ApiKeyDialog({
  status,
  open,
  onOpenChange,
  onSaved,
}: {
  status: AgentStatus
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Huli: the key was handed to the harness. */
  onSaved?: () => void
}) {
  const { request } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [value, setValue] = useState<KeyValue>({ baseUrl: '', key: '', model: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const providers = status.apiKey?.providers ?? false
  const close = (): void => {
    onOpenChange(false)
    setValue({ baseUrl: '', key: '', model: '' })
    setError(null)
    setBusy(false)
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!value.key.trim() || busy) return
    const problem = keyProblem(value, providers)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      await request('agents.setApiKey', {
        agentId: status.id,
        key: value.key.trim(),
        ...(providers && value.baseUrl.trim() ? { baseUrl: value.baseUrl.trim() } : {}),
        ...(providers && value.model.trim() ? { model: value.model.trim() } : {}),
      })
      close()
      onSaved?.()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <SettingsDialogContent>
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <SettingsDialogHeader title={t('agents.key.title', { name: status.name })}>
            {status.isDefault &&
              (status.cli?.command
                ? t('agents.key.defaultWarning', {
                    name: status.harnessName,
                    command: status.cli.command,
                  })
                : t('agents.key.defaultWarningShared', { name: status.harnessName }))}
          </SettingsDialogHeader>
          <SettingsDialogBody>
            <ApiKeyFields status={status} value={value} onChange={setValue} />
            {error && <p className="kettu-sd__error">{error}</p>}
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
              disabled={!value.key.trim() && !busy}
            >
              {t('agents.key.save')}
            </SetButton>
          </SettingsDialogFooter>
        </form>
      </SettingsDialogContent>
    </Dialog>
  )
}

/** Where the agent reads its configuration, and the harness it runs on. */
function ConfigurationGroup({ status }: { status: AgentStatus }) {
  const { hostId, useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const details = useAgentsStore((s) => s.details[status.id])
  const version = harnessVersion(status)
  return (
    <section className="k-group" aria-label={t('agents.configuration')}>
      <GroupLabel group={{ id: 'configuration', label: t('agents.configuration') }} />
      <RowGroup>
        <RowFrame text={<RowText name={t('agents.harness')} />}>
          <span className="k-fact">
            {version ? `${status.harnessName} ${version}` : status.harnessName}
          </span>
          <SetButton variant="ghost" onClick={() => openHarnessSettings(status.harnessId)}>
            {t('agents.openHarnessButton')}
          </SetButton>
        </RowFrame>
        {takesStartMode(status.id) && <StartModeRow key={status.id} status={status} />}
        {takesAutoCompact(status.id) && <AutoCompactRows key={status.id} status={status} />}
        {takesClaudeSettings(status.id) && <ClaudeSettingsRows key={status.id} status={status} />}
        {takesCodebuddySettings(status.id) && (
          <CodebuddySettingsRows key={status.id} status={status} />
        )}
        {takesCodexSettings(status.id) && <CodexSettingsRows key={status.id} status={status} />}
        {/* Huli: the agent network is this computer's alone. */}
        {hostId === null && !isWeb && <NetworkChoiceRow agentId={status.id} />}
        {/* The Marketplace shows this computer's servers only. */}
        {hostId === null && (
          <RowFrame
            id="mcp-servers"
            text={
              <RowText
                name={t('agents.mcpServers.name')}
                description={t('agents.mcpServers.description')}
              />
            }
          >
            <SetButton variant="ghost" onClick={() => openMarketplace({ tab: 'installed' })}>
              {t('agents.mcpServers.open')}
            </SetButton>
          </RowFrame>
        )}
        {details?.config.map((item) => (
          <PlaceRow
            key={item.id}
            name={t(`agents.config.${item.id}`)}
            item={item}
            note={item.id === 'folder' && status.configDir?.created && t('agents.createdByKettu')}
          />
        ))}
        {details && details.config.length === 0 && (
          <RowShell>
            <p className="ui-ss-empty">{t('agents.noConfig')}</p>
          </RowShell>
        )}
      </RowGroup>
    </section>
  )
}

/** The permission mode the agent's new sessions start in, for the agents that take one. */
function StartModeRow({ status }: { status: AgentStatus }) {
  const { hostId, useSettingsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const entry = useAgentOptionsStore((s) => optionsOn(s, hostId)[status.id])
  const loaded = useAgentOptionsStore((s) => optionsLoaded(s, hostId))
  const loadFailed = useAgentOptionsStore((s) => hostId === null && s.error !== null)
  // An older host sends no start modes.
  const stored = useSettingsStore((s) => s.settings.startModes?.[status.id])
  const [hostFailed, setHostFailed] = useState(false)
  const [apply, error] = useApply()
  // Another host's options are read when a connection to it opens; Settings may come before.
  useEffect(() => {
    if (hostId === null || loaded) return
    readHostAgentOptions(hostId).catch(() => setHostFailed(true))
  }, [hostId, loaded])
  const view = startModeView({
    agentId: status.id,
    entry,
    loaded,
    failed: loadFailed || hostFailed,
    stored,
  })
  const note =
    error ??
    (view.state === 'unused'
      ? t('agents.startMode.unused')
      : view.state === 'failed'
        ? t('agents.startMode.readFailed')
        : null)
  const { name, description } = entryText('agents.start-mode')
  return (
    <RowShell id="start-mode">
      <RowLine text={<RowText name={name} description={description} />}>
        {view.state === 'loading' ? (
          <Skel width={210} className="k-skel--field" />
        ) : (
          <SettingSelect
            label={name}
            value={view.value}
            disabled={view.state !== 'ready'}
            options={[
              {
                value: FOLLOW_AGENT,
                label: t(
                  `agents.startMode.follow.${status.harnessId === 'codex' || status.harnessId === 'deepseek' || status.harnessId === 'doubao' ? status.harnessId : 'claude-code'}`,
                ),
              },
              ...view.choices.map((choice) => ({
                value: choice.value,
                label: choice.offered
                  ? choice.name
                  : t('agents.startMode.unoffered', { mode: choice.name }),
                danger: isFullAccessMode(choice.value),
              })),
            ]}
            onChange={(next) =>
              apply({ startModes: { [status.id]: next === FOLLOW_AGENT ? null : next } })
            }
          />
        )}
      </RowLine>
      {note && (
        <p role="status" className={error ? 'k-row-note k-error' : 'k-row-note'} data-wrap="">
          {note}
        </p>
      )}
    </RowShell>
  )
}

/** Remove an agent; a default one simply stops being registered. */
function DangerGroup({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const [removing, setRemoving] = useState(false)
  return (
    <section className="k-group">
      <RowGroup>
        {status.color && <ColorRow status={status} />}
        {/* Huli: back to what a fresh install finds, its history and settings kept. */}
        <ResetRow status={status} />
        <RowFrame
          text={
            <RowText name={t('agents.remove.name')} description={t('agents.remove.description')} />
          }
        >
          <DangerButton onClick={() => setRemoving(true)}>
            {t('agents.remove.buttonEllipsis')}
          </DangerButton>
        </RowFrame>
      </RowGroup>
      <RemoveAgentDialog status={status} open={removing} onOpenChange={setRemoving} />
    </section>
  )
}

/** The dot an added agent's mark carries, chosen from the palette. */
function ColorRow({ status }: { status: AgentStatus }) {
  const { api } = useHostScope()
  const { t } = useTranslation('settings')
  const color = useScopedDot(status)
  const [act, busy, error] = useAction()
  return (
    <RowFrame
      text={<RowText name={t('agents.color.name')} description={t('agents.color.description')} />}
    >
      <ControlError error={error} />
      <RadioGroup
        aria-label={t('agents.color.name')}
        value={color}
        disabled={busy}
        onValueChange={(next) => {
          if (isAgentColor(next)) act(() => api.settings.setAgentColor(status.id, next))
        }}
        className="k-swatches"
      >
        {AGENT_COLORS.map((option) => (
          <RadioGroupItem
            key={option}
            value={option}
            aria-label={t(`agents.color.${option}`)}
            title={t(`agents.color.${option}`)}
            style={{ backgroundColor: `var(--agent-${option})` }}
            className="size-4.5 shadow-none data-checked:border-0 data-checked:shadow-[0_0_0_2px_var(--bg-surface),0_0_0_3.5px_var(--control-on)]"
          />
        ))}
      </RadioGroup>
    </RowFrame>
  )
}

/**
 * An added agent's dot as the scoped host's settings have it, so a choice shows at once. A host
 * from before colors reports none and has no dot to choose.
 */
function useScopedDot(status: AgentStatus | null): AgentColor | null {
  const { useSettingsStore } = useHostScope()
  const id = status?.color ? status.id : null
  return useSettingsStore((s) => (id ? agentColor(s.settings.addedAgents, id) : null))
}

function RenameDialog({
  status,
  open,
  onOpenChange,
}: {
  status: AgentStatus
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { api } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [name, setName] = useState(status.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const tooLong = [...trimmed].length > AGENT_NAME_CHARS
  const valid = trimmed.length > 0 && !tooLong
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    if (trimmed === status.name) return onOpenChange(false)
    setBusy(true)
    try {
      await api.settings.renameAgent(status.id, trimmed)
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setName(status.name)
        setError(null)
        onOpenChange(next)
      }}
    >
      <SettingsDialogContent className="sm:max-w-110">
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <SettingsDialogHeader title={t('agents.rename.title')} />
          <SettingsDialogBody>
            <SettingsField
              label={t('agents.add.name')}
              htmlFor="agent-rename"
              hint={
                (tooLong || error) && (
                  <span className="kettu-sd__error">
                    {tooLong ? t('agents.add.nameTooLong', { count: AGENT_NAME_CHARS }) : error}
                  </span>
                )
              }
            >
              <input
                id="agent-rename"
                value={name}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                className={DIALOG_FIELD}
                aria-invalid={tooLong || error !== null || undefined}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => {
                  setName(event.target.value)
                  setError(null)
                }}
              />
            </SettingsField>
          </SettingsDialogBody>
          <SettingsDialogFooter>
            <DialogClose render={<SetButton size="md" variant="ghost" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <SetButton size="md" variant="primary" type="submit" disabled={!valid || busy}>
              {t('agents.rename.save')}
            </SetButton>
          </SettingsDialogFooter>
        </form>
      </SettingsDialogContent>
    </Dialog>
  )
}
