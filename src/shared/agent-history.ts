// Huli: the import from the agents, which lists every past session of an agent across all the
// folders it ran in. Huli's own; see tools/huli/README.md.

/** One of the agent's own sessions, as Settings › General › Import from agents lists it. */
export interface AgentHistorySession {
  /** The agent's own id, which `sessions.import` takes. */
  acpSessionId: string
  title: string | null
  /** The folder it ran in, as the agent recorded it: the project it is imported into. */
  cwd: string
  /** Epoch ms; null when the agent does not say. */
  createdAt: number | null
  updatedAt: number | null
  /** Already a session here, by the agent's own id. */
  imported: boolean
  /** Its folder is gone, so it cannot be imported. */
  missing: boolean
  /**
   * For an imported Claude Code session, what another folder's copy of its transcript holds:
   * `newer`, the conversation carried on past this one, which importing it again brings in;
   * `fork`, a conversation that went another way, which imports as a copy of its own.
   */
  outside?: 'newer' | 'fork'
}

export interface AgentHistoryPage {
  sessions: AgentHistorySession[]
  nextCursor: string | null
  /** What this page left out: sessions another started (subagents), and ones without a message. */
  hidden: { subagents: number; empty: number }
}
