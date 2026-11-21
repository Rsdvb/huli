// Huli: the buttons that sign an agent in where its need shows (see agent-sign-in.ts).

import { useState } from 'react'
import {
  ComputerTerminal01Icon,
  Copy01Icon,
  Key01Icon,
  Login03Icon,
  RefreshIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { AgentAuthMethod } from '@shared/agent-host'
import { signsInWithKeyOnly } from '@shared/agents'
import type { AgentId } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { openHostSettingsItem } from '@renderer/features/settings/host-sections'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'
import {
  agentsOn,
  cancelAgentSignIn,
  openSignInPage,
  signInAgent,
  useAgentsStore,
  useSignInImage,
  useSignInPage,
  useSignInStarted,
} from '@renderer/stores/agents'

/** The method a button signs in with where the need shows: a terminal's, the agent's own, a key. */
function primaryMethod(
  methods: readonly AgentAuthMethod[],
  remote: boolean,
  terminal: boolean,
): AgentAuthMethod | null {
  return (
    (terminal ? methods.find((m) => m.type === 'terminal' && m.command) : undefined) ??
    methods.find((m) => m.type === 'agent' && !(remote && !m.delegated)) ??
    methods.find((m) => m.type === 'env') ??
    null
  )
}

/**
 * The buttons that sign the agent in where its need shows, as small as an alert's: while a sign-in
 * started here waits, Open again, Copy link and Cancel; otherwise its first method (a terminal's
 * when `onTerminal` can open one, else the agent's own page, else its key in Settings) and "I've
 * signed in", which asks the host again and has the caller try again.
 */
export function SignInActions({
  agentId,
  hostId,
  onTerminal,
  onRetry,
}: {
  agentId: AgentId
  hostId: string | null
  /** Runs a terminal sign-in's command; without it, the agent's other methods are offered. */
  onTerminal?: (command: string) => void
  onRetry: () => void
}) {
  const { t } = useTranslation(['session', 'common'])
  const status = useAgentsStore((s) => agentsOn(s, hostId).byId[agentId])
  const page = useSignInPage(hostId, agentId)
  const image = useSignInImage(hostId, agentId)
  const started = useSignInStarted(hostId, agentId)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remote = isWeb || hostId !== null
  const cancel = (): void => {
    void cancelAgentSignIn(hostId, agentId).catch((e: unknown) => setError(errorMessage(e)))
  }
  if (started || page !== null || image !== null) {
    return (
      <>
        {page !== null && (
          <>
            <Button size="xs" variant="outline" onClick={() => openSignInPage(page)}>
              {t('signIn.openPageAgain')}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(page).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              <HugeiconsIcon
                icon={copied ? Tick02Icon : Copy01Icon}
                strokeWidth={1.9}
                aria-hidden
                data-icon="inline-start"
              />
              {t(copied ? 'signIn.linkCopied' : 'signIn.copyLink')}
            </Button>
          </>
        )}
        <Button size="xs" variant="outline" onClick={cancel}>
          {t('common:actions.cancel')}
        </Button>
      </>
    )
  }
  const methods = status?.authMethods ?? []
  const keyOnly = signsInWithKeyOnly(agentId)
  const method = keyOnly ? null : primaryMethod(methods, remote, !!onTerminal)
  const reading = status?.readingSignIn === true && methods.length === 0
  const settings = (): void => openHostSettingsItem(hostId, 'agents', agentId)
  const signIn = (chosen: AgentAuthMethod): void => {
    if (chosen.type === 'terminal' && chosen.command && onTerminal)
      return onTerminal(chosen.command)
    if (chosen.type !== 'agent') return settings()
    setBusy(true)
    setError(null)
    signInAgent(hostId, agentId, chosen.id)
      .then((done) => done && onRetry())
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false))
  }
  const signedIn = (): void => {
    setError(null)
    void hostAt(hostId, 'agents.readSignIn', { agentId })
      .catch(() => {})
      .then(onRetry)
  }
  return (
    <>
      {error && (
        <span className="max-w-60 truncate text-xs text-danger" title={error}>
          {error}
        </span>
      )}
      <Button size="xs" variant="outline" onClick={signedIn}>
        <HugeiconsIcon icon={RefreshIcon} strokeWidth={1.9} aria-hidden data-icon="inline-start" />
        {t('signIn.signedIn')}
      </Button>
      {reading ? (
        <Button size="xs" disabled>
          <Spinner data-icon="inline-start" className="size-3" />
          {t('signIn.reading')}
        </Button>
      ) : method ? (
        <Button size="xs" disabled={busy} title={method.description} onClick={() => signIn(method)}>
          {busy ? (
            <Spinner data-icon="inline-start" className="size-3" />
          ) : (
            <HugeiconsIcon
              icon={
                method.type === 'terminal'
                  ? ComputerTerminal01Icon
                  : method.type === 'env'
                    ? Key01Icon
                    : Login03Icon
              }
              strokeWidth={1.9}
              aria-hidden
              data-icon="inline-start"
            />
          )}
          {method.type === 'terminal'
            ? t('signIn.inTerminal')
            : method.type === 'env'
              ? t('signIn.inSettings')
              : method.name}
        </Button>
      ) : (
        <Button size="xs" onClick={settings}>
          {t('view.signIn')}
        </Button>
      )}
    </>
  )
}
