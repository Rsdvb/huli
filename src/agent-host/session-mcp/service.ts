// Huli: what a session's MCP panel asks of its agent's connection. An agent that reports its servers
// lists them with their states; one that reports none, or a session whose agent does not run,
// lists the servers Kite handed it at its last start, their states unknown. Nothing here runs
// before the panel opens or acts.

import {
  SOURCE_ORDER,
  type PluginReload,
  type SessionMcpView,
  type SessionMcpAction,
  type SessionMcpServer,
} from '@shared/session-mcp'
import { agentError } from '../agents'
import type { AgentConnection } from '../connection'
import { HostError } from '../errors'
import { t } from '../i18n'

/** A session as the panel reaches it: its agent's connection, and what Kite handed it. */
export interface McpSession {
  /** Null while the session's agent was let go or never started. */
  connection: AgentConnection | null
  /** The agent's own id for the session. */
  agentSessionId: string
  /** The names of the servers Kite handed the session's agent at its last start. */
  kite: readonly string[]
  /** The panel can start the session's agent to read its servers, as a typed message would. */
  startable: boolean
  /** The agent's name, for what the panel says. */
  agent: string
}

const NO_ACTIONS = { reconnect: null, toggle: false, login: false, reload: false, start: false }

/** Kite's own first, then the project's, the user's and the rest; by name within each. */
function sorted(servers: SessionMcpServer[]): SessionMcpServer[] {
  const rank = (server: SessionMcpServer) => SOURCE_ORDER.indexOf(server.source)
  return [...servers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** Kite's servers as a session whose agent says nothing of them shows them. */
function handed(names: readonly string[]): SessionMcpServer[] {
  return names.map((name) => ({
    name,
    state: 'unknown',
    error: null,
    source: 'kite',
    plugin: null,
    tools: null,
  }))
}

export async function readSessionMcp(session: McpSession): Promise<SessionMcpView> {
  const { connection } = session
  const fallback = (running: boolean, error: string | null): SessionMcpView => ({
    reported: false,
    running,
    servers: sorted(handed(session.kite)),
    can: { ...NO_ACTIONS, start: !running && session.startable },
    apps: null,
    error,
  })
  if (!connection) return fallback(false, null)
  if (!connection.readMcp) return fallback(true, null)
  let read
  try {
    read = await connection.readMcp(session.agentSessionId, session.kite)
  } catch (error) {
    return fallback(true, agentError(error).message)
  }
  if (!read) return fallback(false, null)
  return {
    reported: true,
    running: true,
    servers: sorted(read.servers),
    can: { ...read.can, start: false },
    apps: read.apps,
    error: null,
  }
}

/** Reconnects or switches a server, then reads the servers again. */
export async function actOnSessionMcp(
  session: McpSession,
  action: SessionMcpAction,
  server: string | null,
): Promise<SessionMcpView> {
  const { connection } = session
  if (!connection) throw notRunning(session)
  try {
    if (action === 'reconnect') {
      if (!connection.reconnectMcp) throw unsupported(session)
      await connection.reconnectMcp(session.agentSessionId, server)
    } else {
      if (!connection.toggleMcp || server === null) throw unsupported(session)
      await connection.toggleMcp(session.agentSessionId, server, action === 'enable', session.kite)
    }
  } catch (error) {
    throw agentError(error)
  }
  return readSessionMcp(session)
}

export async function loginSessionMcp(
  session: McpSession,
  server: string,
): Promise<{ url: string }> {
  const { connection } = session
  if (!connection) throw notRunning(session)
  if (!connection.loginMcp) throw unsupported(session)
  try {
    return await connection.loginMcp(session.agentSessionId, server)
  } catch (error) {
    throw agentError(error)
  }
}

/** Reloads skills and plugins in each session's agent, together, and counts how it went. */
export async function reloadSessions(sessions: readonly McpSession[]): Promise<PluginReload> {
  const result: PluginReload = { reloaded: 0, busy: 0, unsupported: 0, errors: [] }
  await Promise.all(
    sessions.map(async (session) => {
      const { connection } = session
      if (!connection) return
      if (!connection.reloadPlugins) {
        result.unsupported++
        return
      }
      try {
        const done = await connection.reloadPlugins(session.agentSessionId)
        if (done === 'busy') result.busy++
        else result.reloaded++
      } catch (error) {
        const message = agentError(error).message
        if (!result.errors.includes(message)) result.errors.push(message)
      }
    }),
  )
  return result
}

function notRunning(session: McpSession): HostError {
  return new HostError('agent_error', t('agentRun.notRunning', { agent: session.agent }))
}

function unsupported(session: McpSession): HostError {
  return new HostError('agent_error', t('sessionMcp.unsupported', { agent: session.agent }))
}
