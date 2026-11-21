// Huli: the import from the agents, which lists every past session of an agent across all the
// folders it ran in. Huli's own; see tools/huli/README.md.

import type { AgentId } from './agents'

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
  /** Huli: of the Claude desktop app's sessions, one it archived, which imports archived. */
  archived?: true
  /** Huli: of the Claude desktop app's sessions, one in its scratch folder: No project here. */
  scratch?: true
  /** Huli: of the Claude desktop app's sessions, one whose transcript is gone: not importable. */
  unavailable?: true
}

/** Huli: the sessions `agentHistory.list` reads from another app's index instead of the agent. */
export type HistorySource = 'claude-desktop'

/**
 * Huli: the `reason` in the data of a listing's error, of `agentHistory.list` or
 * `agents.listSessions`, when the agent cannot list such sessions at all: its dialogs then leave
 * it out rather than show an error to retry. An agent not started at its version yet is listed
 * to find out.
 */
export const CANNOT_LIST = 'cannot_list'

export interface AgentHistoryPage {
  sessions: AgentHistorySession[]
  nextCursor: string | null
  /** What this page left out: sessions another started (subagents), and ones without a message. */
  hidden: { subagents: number; empty: number }
  /** For a listing of another folder: the folder its sessions were read from, inside the chosen one. */
  source?: string
  /**
   * Huli: for the Claude desktop app's sessions, the Claude Code agent that imports them, whose
   * configuration folder holds their transcripts; it may be another than the one asked.
   */
  agentId?: AgentId
}

/**
 * Huli: what an import from another folder does with a chosen session in the agent's own folder:
 * `new`, its transcript is copied in; `newer`, the agent's copy holds less of the conversation, so
 * it is kept beside it as a backup and replaced; `same` and `older`, the agent has it already, as
 * much of it or more, and only what the session's folder lacks is copied; `conflict`, the agent's
 * copy went another way, and nothing is written; `missing`, the folder it ran in is not here.
 */
export type HistoryCopyAction = 'new' | 'newer' | 'same' | 'older' | 'conflict' | 'missing'

export interface HistoryCopyItem {
  acpSessionId: string
  title: string | null
  cwd: string
  action: HistoryCopyAction
  /** The files it writes, absolute, the transcript first when it is one of them. */
  files: string[]
  /** Files it writes beyond those `files` names, which a long list leaves out. */
  moreFiles: number
  /** For `newer` over a file: where the agent's own copy is kept first. */
  backup: string | null
}

/** The files an import from another folder writes, which the user confirms before it runs. */
export interface HistoryCopyPlan {
  /** Runs this plan with `agentHistory.copy`, once, within a few minutes. */
  token: string
  /** The agent's own folder the files go into. */
  target: string
  items: HistoryCopyItem[]
}

export interface HistoryCopyOutcome {
  acpSessionId: string
  /**
   * `copied`, its transcript was written; `present`, the agent had it already; `skipped`, it was
   * left alone, as for a conflict or a file that changed since the plan; `failed`, a write failed.
   */
  status: 'copied' | 'present' | 'skipped' | 'failed'
  written: number
  message?: string
}
