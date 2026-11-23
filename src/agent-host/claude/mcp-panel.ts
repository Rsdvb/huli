// Huli: a Claude Code session's MCP servers for its panel, from the SDK's `mcpServerStatus`. Kite's
// own servers reach the query as `--mcp-config` and over the control channel, which Claude Code
// files under the `dynamic` scope; the others name the settings or the plugin they came from.

import type { SessionMcpServer, SessionMcpSource, SessionMcpState } from '@shared/session-mcp'
import { shownError } from '../session-mcp/text'
import type { McpServerStatus } from './sdk'

const STATES: Record<string, SessionMcpState> = {
  connected: 'connected',
  failed: 'failed',
  'needs-auth': 'needs-auth',
  pending: 'pending',
  disabled: 'disabled',
}

// `source` is an open set; a value Kite does not know is a configured source, never Kite's own.
const SOURCES: Record<string, SessionMcpSource> = {
  user: 'user',
  project: 'project',
  local: 'local',
  plugin: 'plugin',
  managed: 'managed',
  enterprise: 'managed',
  claudeai: 'cloud',
}

/** The scopes Kite's servers arrive under: its `mcpServers` option and `setMcpServers`. */
const KITE_SCOPES = new Set(['dynamic', 'sdk'])

function sourceOf(server: McpServerStatus, kite: ReadonlySet<string>): SessionMcpSource {
  const source = server.source ?? server.scope
  if (kite.has(server.name) && (source === undefined || KITE_SCOPES.has(source))) return 'kite'
  if (source === undefined) return 'other'
  // A server a plugin registers is named `plugin:<plugin>:<server>`, whatever its scope says.
  if (server.name.startsWith('plugin:')) return 'plugin'
  return SOURCES[source] ?? 'other'
}

/** The plugin of a server named `plugin:<plugin>:<server>`, else null. */
function pluginOf(name: string): string | null {
  const parts = name.split(':')
  return parts.length >= 3 && parts[0] === 'plugin' && parts[1] !== '' ? parts[1]! : null
}

/**
 * The servers as the panel lists them. `off` are Kite's own that the session turned off, which the
 * query no longer has and so does not list.
 */
export function claudeMcpServers(
  statuses: readonly McpServerStatus[],
  kite: ReadonlySet<string>,
  off: ReadonlySet<string> = new Set(),
): SessionMcpServer[] {
  const servers = statuses.map((server): SessionMcpServer => {
    const state = STATES[server.status] ?? 'unknown'
    const source = sourceOf(server, kite)
    return {
      name: server.name,
      state,
      error: state === 'failed' || state === 'needs-auth' ? shownError(server.error) : null,
      source,
      plugin: source === 'plugin' ? pluginOf(server.name) : null,
      tools:
        state === 'connected' && Array.isArray(server.tools)
          ? server.tools.flatMap((tool) => (typeof tool?.name === 'string' ? [tool.name] : []))
          : null,
    }
  })
  const listed = new Set(statuses.map((server) => server.name))
  for (const name of off) {
    if (listed.has(name) || !kite.has(name)) continue
    servers.push({
      name,
      state: 'disabled',
      error: null,
      source: 'kite',
      plugin: null,
      tools: null,
    })
  }
  return servers
}

/**
 * How a sign-in the panel started stands, from the server as a read lists it: undefined while it
 * still waits (it needs a sign-in, or connects), how it ended once connected or failed, and null
 * for one that ended without a word, as a server turned off or no longer listed.
 */
export function signInEnd(
  server: SessionMcpServer | undefined,
): { ok: boolean; error: string | null } | null | undefined {
  switch (server?.state) {
    case 'needs-auth':
    case 'pending':
      return undefined
    case 'connected':
      return { ok: true, error: null }
    case 'failed':
      return { ok: false, error: server.error }
    default:
      return null
  }
}

/** Whether a reload failed only because the session was at work. */
export function reloadBusy(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { errorCode?: unknown }).errorCode === 'reload_plugins_busy'
  )
}
