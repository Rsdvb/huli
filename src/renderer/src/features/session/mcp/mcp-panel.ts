// Huli: the session's MCP panel (MCP 服务器…): which session it shows, and a count each
// `session.mcpChanged` of that session bumps, so the open panel reads again. Its dialog loads the
// first time it is asked for; nothing here reads before.

import { create } from 'zustand'
import type { SessionSummary } from '@shared/agent-host'
import type { PluginReload } from '@shared/session-mcp'
import { toast } from '@renderer/components/ui/toast'
import { i18n } from '@renderer/lib/i18n'

export interface McpLoginEnd {
  server: string
  ok: boolean
  error: string | null
}

interface McpPanelStore {
  /** The session the panel shows; null while it is closed. */
  summary: SessionSummary | null
  /** The panel was asked for, so its dialog's code is loaded. */
  loaded: boolean
  /** How often the session's servers changed since the panel opened. */
  changes: number
  /** How many sign-ins of each server ended since the panel opened. */
  logins: Record<string, number>
  /** The server a thread's notice opened the panel at, which it scrolls to and marks. */
  focus: string | null
}

export const useMcpPanelStore = create<McpPanelStore>()(() => ({
  summary: null,
  loaded: false,
  changes: 0,
  logins: {},
  focus: null,
}))

/** Opens the session's panel, at one of its servers when a notice names it. */
export function askMcpPanel(summary: SessionSummary, focus: string | null = null): void {
  useMcpPanelStore.setState({ summary, loaded: true, changes: 0, logins: {}, focus })
}

export function closeMcpPanel(): void {
  useMcpPanelStore.setState({ summary: null })
}

/**
 * The session's agent says its servers changed: an open panel of it reads them again, and says how
 * a sign-in it started ended.
 */
export function mcpPanelChanged(sessionId: string, login?: McpLoginEnd): void {
  const { summary, changes, logins } = useMcpPanelStore.getState()
  if (summary?.id !== sessionId) return
  useMcpPanelStore.setState({
    changes: changes + 1,
    ...(login ? { logins: { ...logins, [login.server]: (logins[login.server] ?? 0) + 1 } } : {}),
  })
  if (!login) return
  if (login.ok) {
    toast(i18n.t('session:mcp.login.done', { name: login.server }), undefined, { tone: 'success' })
  } else {
    const error = login.error ?? ''
    toast(i18n.t('session:mcp.login.failed', { name: login.server, error }), undefined, {
      tone: 'warning',
    })
  }
}

/** Says how a reload of skills and plugins went, over one session or every running one. */
export function reloadToast(result: PluginReload, all: boolean): void {
  if (result.errors.length > 0) {
    toast(i18n.t('session:mcp.reload.failed', { error: result.errors[0] }), undefined, {
      tone: 'warning',
    })
    return
  }
  if (!all) {
    if (result.busy > 0) toast(i18n.t('session:mcp.reload.busy'), undefined, { tone: 'info' })
    else if (result.reloaded > 0)
      toast(i18n.t('session:mcp.reload.done'), undefined, { tone: 'success' })
    else toast(i18n.t('session:mcp.reload.unsupported'), undefined, { tone: 'info' })
    return
  }
  if (result.reloaded + result.busy + result.unsupported === 0) {
    toast(i18n.t('session:mcp.reload.noneRunning'), undefined, { tone: 'info' })
    return
  }
  const parts = [
    result.reloaded > 0
      ? i18n.t('session:mcp.reload.reloadedSome', { count: result.reloaded })
      : null,
    result.busy > 0 ? i18n.t('session:mcp.reload.busySome', { count: result.busy }) : null,
    result.unsupported > 0
      ? i18n.t('session:mcp.reload.unsupportedSome', { count: result.unsupported })
      : null,
  ].filter((part): part is string => part !== null)
  toast(parts.join(i18n.t('session:mcp.reload.join')), undefined, {
    tone: result.reloaded > 0 ? 'success' : 'info',
  })
}
