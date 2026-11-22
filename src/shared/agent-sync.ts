// Huli: Agent sync (Marketplace › Sync): the MCP servers, skills and instructions each agent keeps
// in its own user-level files, read when the page opens, and the changes the page asks for,
// previewed as the exact lines each file would get before anything is written.

import type { AgentId } from './thread'

export type SyncTransport = 'stdio' | 'http' | 'sse'

/** How an agent's file writes MCP servers. */
export type SyncFormat =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'qwen'
  | 'opencode'
  | 'opencode-v2'
  | 'kilo'
  | 'copilot'
  | 'cursor'
  | 'droid'
  | 'amp'
  | 'pi'
  | 'qoder'

/** A name and a value the page may show: a secret's value comes masked. */
export interface SyncPair {
  name: string
  value: string
}

/** An MCP server as the page shows it; the values of its env and headers are always masked. */
export interface SyncServerView {
  name: string
  transport: SyncTransport
  /** The command line or the URL, with what looks like a secret in it masked. */
  target: string
  env: SyncPair[]
  headers: SyncPair[]
  enabled: boolean
  /** Fields of the agent's own that other formats do not take. */
  extras: string[]
  /** Equal for two places' copies that are the same server. */
  fingerprint: string
}

/** Why a place's file could not be read; the page names it. */
export type SyncReadProblem =
  'not-utf8' | 'too-large' | 'not-file' | 'parse' | 'unpaired' | 'several'

/** A file of MCP servers, shared by the agents that read it. */
export interface SyncMcpPlace {
  /** The place's id in changes: its first candidate file. */
  id: string
  /** The file read: the candidate that exists, else the first. */
  path: string
  agentIds: AgentId[]
  format: SyncFormat
  exists: boolean
  transports: SyncTransport[]
  servers: SyncServerView[]
  /** Entries the file holds that Agent sync cannot read, by name, such as a WebSocket server. */
  unreadable: string[]
  problem: SyncReadProblem | null
  /** Where the parser stopped, for a `parse` problem. */
  detail: string | null
}

export interface SyncSkillView {
  /** The folder's name, which is how agents and Agent sync tell skills apart. */
  name: string
  title: string
  description: string
}

/** A skills folder and the agents that read it. */
export interface SyncSkillPlace {
  id: string
  /** The agents whose own folder this is, where a copy for them goes. */
  owners: AgentId[]
  /** The agents that also read it besides their own. */
  readers: AgentId[]
  exists: boolean
  skills: SyncSkillView[]
}

/** An instructions file and the shared snippets Kite keeps in its block. */
export interface SyncInstructionsPlace {
  id: string
  agentIds: AgentId[]
  exists: boolean
  /**
   * none: no block; synced: it holds the chosen snippets as they are; outdated: it holds what Kite
   * last wrote, from before a snippet changed; edited: something else, changed in the file.
   */
  block: 'none' | 'synced' | 'outdated' | 'edited'
  /** The snippets chosen for the file when it was last written. */
  snippetIds: string[]
  problem: SyncReadProblem | null
}

export interface SyncSnippet {
  id: string
  title: string
  body: string
}

export interface AgentSyncState {
  mcp: SyncMcpPlace[]
  skills: SyncSkillPlace[]
  instructions: SyncInstructionsPlace[]
  snippets: SyncSnippet[]
}

export type SyncChange =
  | { kind: 'mcp-add'; server: string; from: string; to: string }
  | { kind: 'mcp-remove'; server: string; place: string }
  | { kind: 'skill-copy'; skill: string; from: string; to: string }
  | { kind: 'instructions'; place: string; snippetIds: string[] }

export interface SyncDiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

export interface SyncDiffHunk {
  oldStart: number
  newStart: number
  lines: SyncDiffLine[]
}

/** What the preview says about a change beyond its lines. */
export type SyncNote =
  | { kind: 'converted'; server: string; from: SyncFormat; to: SyncFormat; dropped: string[] }
  | { kind: 'outside-edit' }
  | { kind: 'new-file' }

/** One file or folder the confirmed changes would write. */
export interface SyncFilePreview {
  path: string
  agentIds: AgentId[]
  action: 'edit' | 'create' | 'copy'
  /** The changed lines, secrets masked; empty for a copied folder. */
  hunks: SyncDiffHunk[]
  notes: SyncNote[]
  /** For a copied folder: what it holds. */
  files: number
  bytes: number
}

/** A change the preview leaves out, and why. */
export interface SyncProblem {
  change: SyncChange
  code:
    | 'unknown-place'
    | 'missing'
    | 'exists'
    | 'transport'
    | 'unreadable'
    | 'unsupported'
    | 'skill-link'
    | 'skill-too-large'
  detail: string | null
}

export interface SyncPreview {
  /** What `sync.apply` takes; good once, for a few minutes. */
  id: string
  files: SyncFilePreview[]
  problems: SyncProblem[]
}

export interface SyncApplied {
  /** False when a file changed after the preview, which wrote nothing. */
  ok: boolean
  /** The files that changed since the preview, when `ok` is false. */
  changed: string[]
  written: string[]
  /** The folder with copies of the files as they were, or null when none was overwritten. */
  backup: string | null
  /** A file that could not be written, and why; the ones before it were. */
  failed: { path: string; message: string } | null
}

// Bounds on what the page sends, which the host checks.
export const SYNC_MAX_CHANGES = 500
export const SYNC_MAX_SNIPPETS = 100
export const SYNC_SNIPPET_TITLE_CHARS = 120
export const SYNC_SNIPPET_BODY_CHARS = 20_000
export const SYNC_NAME_CHARS = 256
export const SYNC_PATH_CHARS = 4_096
export const SYNC_ID = /^[A-Za-z0-9_-]{1,64}$/
