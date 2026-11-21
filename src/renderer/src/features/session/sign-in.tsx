import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircleIcon,
  ComputerTerminal01Icon,
  Key01Icon,
  Login03Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { AgentAuthMethod } from '@shared/agent-host'
import { signsInWithKeyOnly } from '@shared/agents'
import type { AgentId } from '@shared/thread'
import { emitAppEvent, onAppEvent } from '@renderer/app/events'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Spinner } from '@renderer/components/ui/spinner'
import { useSignInRecheck, useSignInWait } from '@renderer/features/agents/agent-sign-in'
import { SignInActions } from '@renderer/features/agents/sign-in-actions'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { openHostSettingsItem } from '@renderer/features/settings/host-sections'
import { errorMessage } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'
import {
  agentName,
  agentsOn,
  cancelAgentSignIn,
  openSignInPage,
  signInAgent,
  useAgentsStore,
  useSignInImage,
  useSignInPage,
  useSignInStarted,
} from '@renderer/stores/agents'

const NO_METHODS: AgentAuthMethod[] = []

/**
 * Huli: under the thread of a session that waits for the agent's sign-in: the agent's own sign-in
 * in place, and what a sign-in started here waits for. The session tries again once the agent is
 * found signed in; the host retries it, and a terminal sign-in that ends here does too.
 */
export function SessionSignIn({
  agentId,
  hostId,
  panel,
  name,
  onRetry,
}: {
  agentId: AgentId
  hostId: string | null
  /** The side panel a terminal sign-in opens in. */
  panel: string
  name: string
  onRetry: () => void
}) {
  const { t } = useTranslation('session')
  const wait = useSignInWait(hostId, agentId, name)
  const image = useSignInImage(hostId, agentId)
  useSignInRecheck(hostId, agentId)
  useEffect(
    () =>
      onAppEvent((event) => {
        if (
          event.kind === 'sign-in-finished' &&
          event.agentId === agentId &&
          event.hostId === hostId
        ) {
          onRetry()
        }
      }),
    [agentId, hostId, onRetry],
  )
  return (
    <Alert variant="warning">
      <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.9} aria-hidden />
      <AlertTitle>{t('view.signInToContinue', { agent: name })}</AlertTitle>
      <AlertDescription>{wait ?? t('view.historyStays')}</AlertDescription>
      {image !== null && (
        <img
          src={image}
          alt={t('signIn.scanAlt')}
          className="mt-2 size-36 rounded-lg [image-rendering:pixelated] group-has-[>svg]/alert:col-start-2"
          draggable={false}
        />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 group-has-[>svg]/alert:col-start-2">
        <SignInActions
          agentId={agentId}
          hostId={hostId}
          onTerminal={(command) =>
            emitAppEvent({ kind: 'sign-in-terminal', panel, command, agentId })
          }
          onRetry={onRetry}
        />
      </div>
    </Alert>
  )
}

/** Huli: how soon the window coming back tries the session again while a sign-in page is open. */
const RETRY_ON_RETURN_MS = 5_000

/** The agent's sign-in methods, in place of a session that cannot start without them. */
export function SignIn({
  agentId,
  hostId,
  panel,
  onRetry,
}: {
  agentId: AgentId
  /** The host the agent is on, null for this computer. */
  hostId: string | null
  /** The side panel Sign in in terminal opens in; null before a No project session has a folder. */
  panel: string | null
  onRetry: () => void
}) {
  const { t } = useTranslation(['session', 'common', 'settings'])
  const declared = useAgentsStore(
    (s) => agentsOn(s, hostId).byId[agentId]?.authMethods ?? NO_METHODS,
  )
  const name = agentName(agentId, hostId)
  // An agent that signs in only with its key declares no method; its key is set on its page.
  const keyOnly = signsInWithKeyOnly(agentId)
  const methods = useMemo<AgentAuthMethod[]>(
    () =>
      keyOnly
        ? [
            {
              id: 'api-key',
              name: t('signIn.apiKey'),
              description: t('signIn.keyOnly', { agent: name }),
              type: 'env',
              envVars: [],
            },
          ]
        : declared,
    [keyOnly, declared, name, t],
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const page = useSignInPage(hostId, agentId)
  const image = useSignInImage(hostId, agentId)
  // Huli: a sign-in started here that waits for the agent's page or picture, and the read of how
  // the agent signs in, which its first start this run names.
  const started = useSignInStarted(hostId, agentId)
  const opening = started && page === null && image === null
  const reading = useAgentsStore((s) => agentsOn(s, hostId).byId[agentId]?.readingSignIn === true)
  useSignInRecheck(hostId, agentId)
  // A device, or this window on another host: an agent method that hands over no page opens its
  // browser on the computer the agent runs on.
  const remote = isWeb || hostId !== null
  const listed = page === null && image === null && !opening ? methods : NO_METHODS

  useEffect(
    () =>
      onAppEvent((event) => {
        if (
          event.kind === 'sign-in-finished' &&
          event.agentId === agentId &&
          event.hostId === hostId
        ) {
          onRetry()
        }
      }),
    [agentId, hostId, onRetry],
  )

  // Huli: back from the browser its page opened in, the session tries again, which is how an agent
  // that never answers its sign-in tells it is done.
  useEffect(() => {
    if (page === null) return
    let last = Date.now()
    const again = (): void => {
      if (document.visibilityState !== 'visible' || Date.now() - last < RETRY_ON_RETURN_MS) return
      last = Date.now()
      onRetry()
    }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [page, onRetry])

  const authenticate = async (method: AgentAuthMethod) => {
    setBusy(method.id)
    setError(null)
    try {
      if (await signInAgent(hostId, agentId, method.id)) onRetry()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Empty className="animate-in fade-in animation-duration-(--duration-slow)">
      <EmptyHeader>
        <EmptyMedia>
          <AgentTile agent={agentId} hostId={hostId} />
        </EmptyMedia>
        <EmptyTitle>{t('signIn.title', { agent: name })}</EmptyTitle>
        <EmptyDescription>
          {t(
            methods.some((method) => method.type === 'env')
              ? 'signIn.descriptionWithKey'
              : 'signIn.description',
            { agent: name },
          )}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-[440px] gap-3">
        {image !== null && (
          <div className="flex w-full flex-col items-center gap-2 rounded-xl bg-card p-3 text-center shadow-card">
            <img
              src={image}
              alt={t('signIn.scanAlt')}
              className="size-48 rounded-lg [image-rendering:pixelated]"
              draggable={false}
            />
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center justify-center gap-1.5 text-ui font-medium">
                <Spinner className="size-3" />
                {t('signIn.scanTitle')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('signIn.scanHint', { agent: name })}
              </span>
            </div>
            <Button
              variant="outline"
              size="compact"
              onClick={() =>
                void cancelAgentSignIn(hostId, agentId).catch((e: unknown) =>
                  setError(errorMessage(e)),
                )
              }
            >
              {t('common:actions.cancel')}
            </Button>
          </div>
        )}
        {page !== null && (
          <div className="flex w-full flex-col gap-2 rounded-xl bg-card p-3 text-left shadow-card">
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-ui font-medium">
                <Spinner className="size-3" />
                {t('signIn.pageOpen')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('signIn.pageOpenHint', { agent: name })}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button variant="outline" size="compact" onClick={() => openSignInPage(page)}>
                {t('signIn.openPageAgain')}
              </Button>
              <CopyButton text={page} label={t('signIn.copyLink')} size="icon-compact" />
              <Button
                variant="outline"
                size="compact"
                onClick={() =>
                  void cancelAgentSignIn(hostId, agentId).catch((e: unknown) =>
                    setError(errorMessage(e)),
                  )
                }
              >
                {t('common:actions.cancel')}
              </Button>
            </div>
          </div>
        )}
        {opening && (
          <div className="flex w-full flex-col gap-2 rounded-xl bg-card p-3 text-left shadow-card">
            <span className="flex items-center gap-1.5 text-ui font-medium">
              <Spinner className="size-3" />
              {t('settings:agents.signInStarting', { name })}
            </span>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="compact"
                onClick={() =>
                  void cancelAgentSignIn(hostId, agentId).catch((e: unknown) =>
                    setError(errorMessage(e)),
                  )
                }
              >
                {t('common:actions.cancel')}
              </Button>
            </div>
          </div>
        )}
        {methods.length === 0 &&
          (reading ? (
            <p className="flex items-center gap-1.5 text-ui text-muted-foreground">
              <Spinner className="size-3" />
              {t('signIn.reading')}
            </p>
          ) : (
            <p className="text-ui text-muted-foreground">
              {t('signIn.noMethods', { agent: name })}
            </p>
          ))}
        {listed.map((method) =>
          method.type === 'terminal' && method.command ? (
            <div
              key={method.id}
              className="flex w-full flex-col gap-2 rounded-xl bg-card p-3 text-left shadow-card"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-ui font-medium">{method.name}</span>
                {method.description && (
                  <span className="text-xs text-muted-foreground">{method.description}</span>
                )}
              </div>
              <div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-2.5">
                <code
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  data-selectable=""
                  title={method.command}
                >
                  {method.command}
                </code>
                <CopyButton text={method.command} label={t('signIn.copyCommand')} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {panel !== null && (
                  <Button
                    size="compact"
                    onClick={() =>
                      emitAppEvent({
                        kind: 'sign-in-terminal',
                        panel,
                        command: method.command!,
                        agentId,
                      })
                    }
                  >
                    <HugeiconsIcon
                      icon={ComputerTerminal01Icon}
                      strokeWidth={1.9}
                      aria-hidden
                      data-icon="inline-start"
                    />
                    {t('signIn.inTerminal')}
                  </Button>
                )}
                <Button variant="outline" size="compact" onClick={onRetry}>
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    strokeWidth={1.9}
                    aria-hidden
                    data-icon="inline-start"
                  />
                  {t('signIn.signedIn')}
                </Button>
              </div>
            </div>
          ) : method.type === 'env' ? (
            // The key is set on the agent's page; the agent has nothing to authenticate.
            <div
              key={method.id}
              className="flex w-full flex-col gap-2 rounded-xl bg-card p-3 text-left shadow-card"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-ui font-medium">{method.name}</span>
                {method.description && (
                  <span className="text-xs text-muted-foreground">{method.description}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {t('signIn.envHint', { agent: name })}
                </span>
              </div>
              {method.envVars && method.envVars.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted px-2.5 py-1.5">
                  {method.envVars.map((variable) => (
                    <span key={variable.name} className="text-xs">
                      <code className="font-mono" data-selectable="">
                        {variable.name}
                      </code>
                      {variable.optional && (
                        <span className="text-muted-foreground"> · {t('signIn.optional')}</span>
                      )}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="compact"
                  onClick={() => openHostSettingsItem(hostId, 'agents', agentId)}
                >
                  <HugeiconsIcon
                    icon={Key01Icon}
                    strokeWidth={1.9}
                    aria-hidden
                    data-icon="inline-start"
                  />
                  {t('signIn.inSettings')}
                </Button>
                <Button variant="outline" size="compact" onClick={onRetry}>
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    strokeWidth={1.9}
                    aria-hidden
                    data-icon="inline-start"
                  />
                  {t('signIn.keySet')}
                </Button>
              </div>
            </div>
          ) : method.type === 'agent' && remote && !method.delegated ? (
            <div
              key={method.id}
              className="flex w-full flex-col gap-2 rounded-xl bg-card p-3 text-left shadow-card"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-ui font-medium">{method.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t('signIn.onComputer', { agent: name })}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="outline" size="compact" onClick={onRetry}>
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    strokeWidth={1.9}
                    aria-hidden
                    data-icon="inline-start"
                  />
                  {t('signIn.signedIn')}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              key={method.id}
              size="compact"
              disabled={busy !== null}
              onClick={() => void authenticate(method)}
              title={method.description}
            >
              {busy === method.id ? (
                <Spinner data-icon="inline-start" className="size-3" />
              ) : (
                <HugeiconsIcon
                  icon={Login03Icon}
                  strokeWidth={1.9}
                  aria-hidden
                  data-icon="inline-start"
                />
              )}
              {method.name}
            </Button>
          ),
        )}
        {methods.length === 0 && (
          <Button variant="outline" size="compact" onClick={onRetry}>
            <HugeiconsIcon
              icon={RefreshIcon}
              strokeWidth={1.9}
              aria-hidden
              data-icon="inline-start"
            />
            {t('common:actions.retry')}
          </Button>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </EmptyContent>
    </Empty>
  )
}
