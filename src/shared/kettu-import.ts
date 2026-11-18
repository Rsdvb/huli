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

/** What bringing Kettu's memory over did. */
export interface KettuMemoryResult {
  imported: number
  /** Of `imported`, those whose id an entry here with other content has, added under `as`. */
  renamed: { title: string; id: string; as: string }[]
  /**
   * `imported`: brought over before, as it is now. `same`: an entry here has its title and body.
   * `invalid`: no entry, or past memory's limits. `secret`: it seems to hold a secret. `full`: its
   * layer holds as many entries as it may. `noProject`: its project's folder is gone.
   */
  skipped: Record<'imported' | 'same' | 'invalid' | 'secret' | 'full' | 'noProject', number>
}

/** What bringing Kettu's artifacts over did. Kettu's sharing links are never brought. */
export interface KettuArtifactsResult {
  imported: number
  /** Of `imported`, those whose id an artifact here has, added under `as`. */
  renamed: { title: string; id: string; as: string }[]
  /**
   * `imported`: brought over before and still here. `same`: an artifact here has its latest
   * version. `invalid`: its records fail the checks. `missingContent`: a file of a version is
   * gone or not what its record says. `scratch`: it is in a folder inside Kettu's data folder.
   * `deleted`: it is in Kettu's Recently deleted.
   */
  skipped: Record<
    'imported' | 'same' | 'invalid' | 'missingContent' | 'scratch' | 'deleted',
    number
  >
  failed: { title: string; message: string }[]
}

/** The most sessions one `kettuImport.run` takes. */
export const KETTU_IMPORT_SESSIONS = 10_000
