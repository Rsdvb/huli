// Huli: a session's MCP panel. What the session's agent says of the MCP servers it has, read only
// when the panel opens and again when the agent reports a change, and what the panel can do with
// them: reconnect, turn one off for the session and on again, sign in to one, reload the skills
// and plugins. Codex's apps (ChatGPT's connectors) are listed beside them, read-only.

/** Where a server the session's agent has comes from. */
export type SessionMcpSource =
  /** Kite handed it to the session: its own server, or one the Marketplace keeps. */
  | 'kite'
  /** The agent's own settings for every project. */
  | 'user'
  /** The project's shared file, such as `.mcp.json` or `.codex/config.toml`. */
  | 'project'
  /** The project's settings of the user's own, such as Claude Code's local scope. */
  | 'local'
  /** A plugin the agent installed. */
  | 'plugin'
  /** An administrator's or the organization's settings. */
  | 'managed'
  /** The agent's account online, such as claude.ai's connectors. */
  | 'cloud'
  /** One the agent names no source for. */
  | 'other'

/** A server's state as the agent reports it; `unknown` where the agent reports none. */
export type SessionMcpState =
  'connected' | 'pending' | 'failed' | 'needs-auth' | 'disabled' | 'unknown'

export interface SessionMcpServer {
  /** As the agent names it, which its tools are prefixed with. */
  name: string
  state: SessionMcpState
  /** Why it failed, as the agent said; null otherwise. */
  error: string | null
  source: SessionMcpSource
  /** The plugin it came with, by the agent's name for it, when its source is a plugin. */
  plugin: string | null
  /** Its tools' names; null where the agent did not list them, as before it connected. */
  tools: string[] | null
}

/** One of Codex's apps, a connector of the ChatGPT account. */
export interface SessionMcpApp {
  id: string
  name: string
  description: string | null
  /** Codex's settings leave it on. */
  enabled: boolean
  /** The account linked it, so its tools reach it. */
  linked: boolean
  /** Its own page on ChatGPT, where it is linked; null where Codex names none. */
  url: string | null
}

/** What the panel offers for the session's agent; each absent action is left out of it. */
export interface SessionMcpActions {
  /** One server at a time, every server together (Codex reloads them all), or neither. */
  reconnect: 'server' | 'all' | null
  /** A server turned off for this session alone, and on again. */
  toggle: boolean
  /** The agent signs in to a server that needs it, in the browser. */
  login: boolean
  /** The agent reloads its skills and plugins without starting again. */
  reload: boolean
  /** The session's agent is not running, and the panel can start it to read its servers. */
  start: boolean
}

export interface SessionMcpView {
  /** The agent reported its servers; false lists only those Kite handed the session. */
  reported: boolean
  /** The session's agent runs; a session it does not run shows what Kite hands it. */
  running: boolean
  servers: SessionMcpServer[]
  can: SessionMcpActions
  /** Codex's apps; null where the agent has none or did not list them. */
  apps: SessionMcpApp[] | null
  /** Why the agent could not be read, while what Kite hands the session still shows. */
  error: string | null
}

export type SessionMcpAction = 'reconnect' | 'disable' | 'enable'

export const SESSION_MCP_ACTIONS: readonly SessionMcpAction[] = ['reconnect', 'disable', 'enable']

/** The longest server name a request may name; agents' own names are far shorter. */
export const MCP_SERVER_NAME_CHARS = 256

/** How a reload of skills and plugins went, over the sessions it reached. */
export interface PluginReload {
  /** Sessions whose agent reloaded. */
  reloaded: number
  /** Sessions whose agent was busy with a turn, which a later reload reaches. */
  busy: number
  /** Running sessions whose agent cannot reload without starting again. */
  unsupported: number
  /** Why the reload failed, for each session it failed in. */
  errors: string[]
}

/** Where Codex's apps are managed: the ChatGPT account's connector settings. */
export const CHATGPT_APPS_URL = 'https://chatgpt.com/#settings/Connectors'

/** The order the panel lists servers in, by where they come from. */
export const SOURCE_ORDER: readonly SessionMcpSource[] = [
  'kite',
  'project',
  'local',
  'user',
  'plugin',
  'cloud',
  'managed',
  'other',
]
