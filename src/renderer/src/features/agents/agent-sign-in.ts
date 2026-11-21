// Huli: signing an agent in where the need shows, not only on its page in Settings: a session that
// waits for the sign-in and New session with a signed-out agent offer its own methods in place,
// and ask the host again once the user says it is done or comes back to the window.

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { newSession } from '@renderer/app/actions'
import { emitAppEvent } from '@renderer/app/events'
import { toast } from '@renderer/components/ui/toast'
import { signInFolder } from '@renderer/features/settings/agent-helpers'
import { focusedPane } from '@renderer/features/split/layout'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import {
  agentsOn,
  useAgentsStore,
  useSignInImage,
  useSignInPage,
  useSignInStarted,
} from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { createTerminal } from '@renderer/stores/terminals'
import {
  closeSettings,
  newSessionPanel,
  panelOf,
  sessionsShown,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'

/**
 * Runs the agent's terminal sign-in in the built-in terminal of the side panel in view, when it
 * works in a folder of this computer, else of New session in one; copies the command without one.
 * True when a terminal opened.
 */
export function signInTerminal(status: AgentStatus, command: string): boolean {
  const view = useViewStore.getState()
  const focused = focusedPane(view.layout).view
  const here =
    sessionsShown(view.main) && focused.projectPath && hostOfPath(focused.projectPath) === null
      ? { projectPath: focused.projectPath, panel: panelOf(focused) }
      : null
  const projectPath =
    here?.projectPath ??
    signInFolder({
      selected: view.projectPath,
      projects: useProjectsStore.getState().projects,
      sessions: useSessionsStore.getState().byId,
    })
  if (!projectPath) {
    void navigator.clipboard.writeText(command).then(
      () => {
        toast(i18n.t('settings:agents.signInCopied'))
        emitAppEvent({ kind: 'sign-in-started', agentId: status.id, hostId: null })
      },
      () => toast(i18n.t('settings:agents.signInCopyFailed'), undefined, { tone: 'warning' }),
    )
    return false
  }
  closeSettings()
  if (!here) newSession(projectPath)
  const panel = here?.panel ?? newSessionPanel(projectPath)
  toggleTerminal(panel, true)
  void createTerminal(projectPath, panel, undefined, {
    text: command,
    run: true,
    signInAgent: status.id,
  })
  return true
}

/** How soon a window coming back asks the agent's sign-in again. */
const AGAIN_MS = 2_000

/**
 * Asks the host whether a signed-out agent still is, once when it shows signed out here and each
 * time the window comes back, as from a browser or a terminal it signed in in.
 */
export function useSignInRecheck(hostId: string | null, agentId: AgentId | null): void {
  const signedOut = useAgentsStore(
    (s) => !!agentId && agentsOn(s, hostId).byId[agentId]?.signIn === 'required',
  )
  useEffect(() => {
    if (!agentId || !signedOut) return
    const ask = (): void => {
      hostAt(hostId, 'agents.readSignIn', { agentId }).catch((error: unknown) =>
        console.warn(`Could not read the sign-in: ${errorMessage(error)}`),
      )
    }
    ask()
    let last = Date.now()
    const again = (): void => {
      if (document.visibilityState !== 'visible' || Date.now() - last < AGAIN_MS) return
      last = Date.now()
      ask()
    }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [hostId, agentId, signedOut])
}

/**
 * What a sign-in started here waits for, as a line: the browser, the picture to scan, or the page
 * itself; null while none waits.
 */
export function useSignInWait(
  hostId: string | null,
  agentId: AgentId,
  name: string,
): string | null {
  const { t } = useTranslation(['session', 'settings'])
  const page = useSignInPage(hostId, agentId)
  const image = useSignInImage(hostId, agentId)
  const started = useSignInStarted(hostId, agentId)
  if (image !== null) return t('signIn.scanHint', { agent: name })
  if (page !== null) return t('signIn.pageOpenHint', { agent: name })
  if (started) return t('settings:agents.signInStartingHint')
  return null
}
