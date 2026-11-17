// Huli: bringing the sessions of an official Kettu on the same computer over, read from a copy of
// Kettu's index and imported through the agents' own sessions. Huli's own; see tools/huli/README.md.

import type { AgentId } from './agents'

/**
 * Why a session of Kettu's cannot be imported. `subagent`: it comes back under its parent, from the
 * parent's history, when the parent is opened. `noAgentSession`: its agent never had a session for
 * it. `worktree`: it works in a worktree Kettu made. `scratch`: it works in a folder inside Kettu's
 * data folder. `unknownAgent`: no agent here has its id. `missingFolder`: its project's folder is
 * gone.
 */
export type KettuSkipReason =
  'subagent' | 'noAgentSession' | 'worktree' | 'scratch' | 'unknownAgent' | 'missingFolder'

export interface KettuSession {
  /** Kettu's id for it. */
  id: string
  title: string | null
  agentId: AgentId
  /** The agent's own session, which an import resumes. */
  acpSessionId: string
  projectPath: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  archived: boolean
  origin: 'user' | 'subagent' | 'routine' | 'task'
  /** Kettu's id of the session that started it, for a subagent. */
  parentId: string | null
  /** How many subagent sessions it has in Kettu. */
  subagents: number
  /** Already here: imported before, or this app has the agent's session itself. */
  imported: boolean
  skip: KettuSkipReason | null
}

export interface KettuProject {
  path: string
  name: string
  /** Its top-level sessions in Kettu. */
  sessions: number
  /** This app lists it already. */
  added: boolean
}

export interface KettuImportScan {
  /** Kettu's index was found and read. */
  found: boolean
  /** Kettu's data folder, looked for whether found or not. */
  path: string | null
  /** Why a found index could not be read; null when it was, or was not there. */
  error: 'newer' | 'unreadable' | null
  projects: KettuProject[]
  /** Every session of Kettu's index, subagents among them, newest first. */
  sessions: KettuSession[]
  counts: {
    /** Top-level sessions. */
    sessions: number
    subagents: number
    /** Top-level sessions not imported yet that can be. */
    importable: number
    imported: number
  }
}

export interface KettuImportFailure {
  sessionId: string
  title: string | null
  message: string
}

export interface KettuImportResult {
  imported: number
  /** Of `imported`, those another program had open, imported as a copy of the agent's session. */
  forked: number
  /** Already here, subagents, and those `KettuSkipReason` keeps out. */
  skipped: number
  failed: KettuImportFailure[]
}

/** The most sessions one `kettuImport.run` takes. */
export const KETTU_IMPORT_SESSIONS = 10_000
