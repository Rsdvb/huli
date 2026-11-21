// Huli: an agent's own CLI in a terminal of Kite's. Its host builds every line: the start in
// `AgentStatus.terminal`, a session's resume through `sessions.terminalCommand`. The window sends
// the line back as given, which the terminal host runs only when the agent host allows it.

import type { AgentStatus, SessionSummary, SessionTerminalCommand } from '@shared/agent-host'
import { addProjectFromDialog, newSession } from '@renderer/app/actions'
import { toast } from '@renderer/components/ui/toast'
import { focusedPane } from '@renderer/features/split/layout'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { sessionFolder } from '@renderer/lib/session-folder'
import { allowsTerminal, useHostsStore } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { createTerminal } from '@renderer/stores/terminals'
import {
  closeSettings,
  newSessionPanel,
  openSession,
  panelOf,
  sessionsShown,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'

/** Whether the agent's CLI starts in a terminal of its host: one found, and a terminal allowed. */
export function startsInTerminal(
  status: Pick<AgentStatus, 'terminal' | 'disabled'> | undefined,
  hostId: string | null,
): boolean {
  return !!status?.terminal && !status.disabled && allowsTerminal(hostId)
}

/** `startsInTerminal` as a hook, which follows the host allowing its terminal. */
export function useStartsInTerminal(
  status: Pick<AgentStatus, 'terminal' | 'disabled'>,
  hostId: string | null,
): boolean {
  return useHostsStore((s) => (s.status, startsInTerminal(status, hostId)))
}

/**
 * The folder the pane in focus works in, behind Settings too, when it is on `hostId`: its
 * session's, a worktree's included, or New session's project, the selected one while it names
 * none; with its side panel, which New session has only once it names its project.
 */
function focusedFolder(hostId: string | null): { folder: string; panel: string | null } | null {
  const view = useViewStore.getState()
  if (!sessionsShown(view.main)) return null
  const focused = focusedPane(view.layout).view
  const summary =
    focused.kind === 'session' ? useSessionsStore.getState().byId[focused.sessionId] : undefined
  const folder = summary
    ? sessionFolder(summary)
    : focused.kind === 'new' && focused.noProject
      ? null
      : (focused.projectPath ?? view.projectPath)
  if (!folder || hostOfPath(folder) !== hostId) return null
  return { folder, panel: panelOf(focused) }
}

/**
 * Starts the agent's CLI in a terminal in `projectPath`: in the side panel in view when it works
 * there, else in the project's New session, which opens first.
 */
export async function startAgentInProject(status: AgentStatus, projectPath: string): Promise<void> {
  const command = status.terminal?.command
  if (!command) return
  const here = focusedFolder(hostOfPath(projectPath))
  closeSettings()
  let panel: string
  if (here?.panel && here.folder === projectPath) {
    panel = here.panel
  } else {
    newSession(projectPath)
    panel = newSessionPanel(projectPath)
  }
  toggleTerminal(panel, true)
  await createTerminal(projectPath, panel, undefined, { text: command, run: true })
}

/**
 * The agent page's Start in terminal: in the folder the pane in focus works in, else in a folder
 * the user picks, which becomes a project. Another host's agent needs one of its folders in focus.
 */
export async function startAgentInTerminal(
  status: AgentStatus,
  hostId: string | null,
): Promise<void> {
  const here = focusedFolder(hostId)
  if (here) return startAgentInProject(status, here.folder)
  if (hostId !== null) {
    toast(i18n.t('settings:agents.terminal.openProject'), undefined, { tone: 'warning' })
    return
  }
  let picked: string | null
  try {
    picked = await addProjectFromDialog()
  } catch (error) {
    toast(errorMessage(error), undefined, { tone: 'warning' })
    return
  }
  if (picked) await startAgentInProject(status, picked)
}

/**
 * Resumes the session in its agent's CLI, in a terminal of its side panel in its folder: its host
 * lets the session go first, so the terminal alone holds it.
 */
export async function resumeInTerminal(summary: SessionSummary): Promise<void> {
  let lines: SessionTerminalCommand
  try {
    lines = await host('sessions.terminalCommand', { sessionId: summary.id, run: true })
  } catch (error) {
    toast(errorMessage(error), undefined, { tone: 'warning' })
    return
  }
  openSession(summary.id, summary.projectPath)
  toggleTerminal(summary.id, true)
  await createTerminal(sessionFolder(summary), summary.id, undefined, {
    text: lines.command,
    run: true,
  })
}

/** Copies the line that resumes the session after a change to its folder, for any terminal. */
export async function copyResumeCommand(summary: SessionSummary, done: string): Promise<void> {
  try {
    const { copy } = await host('sessions.terminalCommand', { sessionId: summary.id })
    await navigator.clipboard.writeText(copy)
    toast(done)
  } catch (error) {
    toast(errorMessage(error))
  }
}
