// Huli: a Codex thread's MCP servers and apps for the session's MCP panel, from
// `mcpServerStatus/list`, the layers `config/read` names for each server's keys and `app/list`.
// Kite hands its own servers in the thread's config, renamed as `sessionConfig` names them.

import type {
  SessionMcpApp,
  SessionMcpServer,
  SessionMcpSource,
  SessionMcpState,
} from '@shared/session-mcp'
import { isWebUrl } from '../elicitation'
import { shownError } from '../session-mcp/text'
import { plainErrorDetail } from './mcp-status'
import type {
  AppInfo,
  ConfigLayerMetadata,
  McpServerConnectionStatus,
  McpServerStatus,
} from './protocol'

const STATES: Record<McpServerConnectionStatus, SessionMcpState> = {
  connected: 'connected',
  starting: 'pending',
  notStarted: 'pending',
  authenticationRequired: 'needs-auth',
  failed: 'failed',
  cancelled: 'failed',
  disabled: 'disabled',
}

const LAYERS: Record<string, SessionMcpSource> = {
  user: 'user',
  project: 'project',
  system: 'managed',
  mdm: 'managed',
  enterpriseManaged: 'managed',
  legacyManagedConfigTomlFromFile: 'managed',
  legacyManagedConfigTomlFromMdm: 'managed',
}

/** A server's name as a thread's `mcp_servers` table takes it. */
export function codexServerName(name: string): string {
  return name.replace(/\s+/g, '_')
}

function stateOf(server: McpServerStatus): SessionMcpState {
  const status = server.runtimeStatus
  const state = status === null ? 'unknown' : (STATES[status] ?? 'unknown')
  // A server that failed or never said why, while its sign-in is missing, waits for one.
  if (server.authStatus === 'notLoggedIn' && (state === 'failed' || state === 'unknown')) {
    return 'needs-auth'
  }
  return state
}

/** The layer that set a key of the server's table: `mcp_servers.<name>` or one of its keys. */
function layerOf(name: string, origins: Record<string, ConfigLayerMetadata>): string | null {
  const key = `mcp_servers.${name}`
  for (const [path, origin] of Object.entries(origins)) {
    if (path === key || path.startsWith(`${key}.`)) return origin?.name?.type ?? null
  }
  return null
}

/**
 * The servers as the panel lists them. `kite` are the names of Kite's own as Codex has them;
 * `failure` gives the startup error Codex last reported for a server.
 */
export function codexMcpServers(
  servers: readonly McpServerStatus[],
  kite: ReadonlySet<string>,
  origins: Record<string, ConfigLayerMetadata>,
  failure: (name: string) => string | null,
): SessionMcpServer[] {
  return servers.map((server): SessionMcpServer => {
    const state = stateOf(server)
    const plugin =
      typeof server.pluginId === 'string' && server.pluginId !== '' ? server.pluginId : null
    const layer = layerOf(server.name, origins)
    const source: SessionMcpSource = kite.has(server.name)
      ? 'kite'
      : plugin
        ? 'plugin'
        : layer
          ? (LAYERS[layer] ?? 'other')
          : 'other'
    const why = state === 'failed' ? (failure(server.name) ?? server.toolsError) : null
    return {
      name: server.name,
      state,
      error: why ? shownError(plainErrorDetail(why)) : null,
      source,
      plugin: source === 'plugin' ? plugin : null,
      tools: state === 'connected' ? Object.keys(server.tools ?? {}) : null,
    }
  })
}

/** The apps the ChatGPT account linked, as the panel lists them; the rest are only on offer. */
export function codexApps(apps: readonly AppInfo[]): SessionMcpApp[] {
  return apps
    .filter((app) => app.isAccessible === true && typeof app.id === 'string')
    .map((app) => ({
      id: app.id,
      name: typeof app.name === 'string' && app.name !== '' ? app.name : app.id,
      description: typeof app.description === 'string' ? app.description : null,
      enabled: app.isEnabled !== false,
      linked: true,
      url: typeof app.installUrl === 'string' && isWebUrl(app.installUrl) ? app.installUrl : null,
    }))
}
