// Huli: resetting an agent's environment on its host, back to how a fresh install finds it, while
// its history and settings stay. Settings › Agents asks for the list first, then for the reset.

/**
 * What a reset removes: the agent's sign-in and keys, the anonymous ids it made on this computer,
 * and its caches, logs and temporary files.
 */
export const AGENT_RESET_CATEGORIES = ['credentials', 'identifiers', 'caches'] as const
export type AgentResetCategory = (typeof AGENT_RESET_CATEGORIES)[number]

/** Where an agent keeps a secret outside its files. */
export type AgentSecretStore = 'keychain' | 'credential-manager' | 'secret-service'

/**
 * One thing a reset removes. `file` and `folder` go whole; `keys` are taken out of the JSON file
 * at `path`, the rest of it kept; `secret` is an entry of the system's credential store, named by
 * `path`; `logout` is the agent's own sign-out, the command it runs in `path`; `api-key` is a key
 * Kite handed the agent, in the variables `keys` of the settings file at `path`; `kite-key` is a
 * key Kite keeps for the agent itself, the variable `path`, which the window clears.
 */
export interface AgentResetItem {
  category: AgentResetCategory
  kind: 'file' | 'folder' | 'keys' | 'secret' | 'logout' | 'api-key' | 'kite-key'
  path: string
  keys?: string[]
  store?: AgentSecretStore
  /** Its size on disk; null for what has none, such as a secret. */
  bytes: number | null
  /** Why the reset cannot change it, such as a file that is not JSON; it is left as it is. */
  problem?: string
}

/** A session of the agent that works or waits now, which a reset waits for. */
export interface AgentResetBusy {
  sessionId: string
  title: string | null
}

export interface AgentResetPreview {
  /** The agent's own folder, or null for one it has none of. */
  folder: string | null
  /** The home folder of the host, which the list shortens paths under. */
  home: string
  /** The categories whose files Kite knows for this agent; the others offer only a sign-out. */
  known: AgentResetCategory[]
  items: AgentResetItem[]
  /** What stays that is there now: its history and settings, by their names in its folder. */
  kept: string[]
  busy: AgentResetBusy[]
  /** Claude Code processes outside Kite that have the folder open, which may write it back. */
  outside: number
  /**
   * Who else uses what the reset removes: the agent's own program, run by the user in the same
   * folder, or the vendor's app, which shares the sign-in.
   */
  shared: 'program' | 'app' | null
}

export interface AgentResetResult {
  removed: AgentResetItem[]
  failed: { item: AgentResetItem; error: string }[]
}
