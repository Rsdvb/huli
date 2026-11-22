// Huli: moving an idle session to another computer this one connects to, with its Git state and
// its conversation. Main runs the move over the hosts' existing channels: the source host packs
// the branch and the uncommitted changes as a Git bundle (nothing is pushed anywhere) and the
// agent's own transcript, main carries the pack across in parts, and the target host clones or
// reuses the project, makes the worktree, writes the transcript where its agent resumes it and
// adds the session. Every step the target took is undone when a later one fails.

import type { AgentId, HarnessId } from './thread'
import type { Platform } from './platform'

/** A move's id, which names its staging folder on each host. */
export const MOVE_ID = /^[0-9a-f]{32}$/

/** Bytes one part of a pack carries across, well under what a host takes in memory. */
export const MOVE_PART_BYTES = 8 * 1024 * 1024

/** The whole pack at most: the bundle, the transcript and what goes with them. */
export const MOVE_MAX_BYTES = 512 * 1024 * 1024

/** The target's commits a pack leaves out, at most. */
export const MOVE_MAX_HAVES = 400

/** Files besides the transcript a Claude Code session keeps in its own folder, at most. */
export const MOVE_MAX_EXTRAS = 2_000

/** How long a host keeps what a move staged before it gives the move up. */
export const MOVE_STAGING_MS = 60 * 60 * 1000

/**
 * A file of a pack: `bundle` (Git), `transcript` (the agent's own), `thread` (Kite's copy, for an
 * agent whose own history cannot move) and `extra/<path>` (a Claude Code session's subagents and
 * tool results), each segment plain.
 */
export const MOVE_FILE_NAME =
  /^(?:bundle|transcript|thread|extra\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){0,3})$/

/** How the conversation goes on there. */
export type MoveConversationKind =
  /** Claude Code's transcript, copied under the target folder's project folder, then resumed. */
  | 'claude'
  /** Codex's rollout, copied into its sessions folder, then its thread resumed. */
  | 'codex'
  /** Kite's own copy of the thread, which the agent there is given as a takeover's would be. */
  | 'carry'

/** Why a session cannot move now, as the source or the target says. */
export type MoveProblem =
  | 'busy' // a turn runs, waits for an answer, or work runs beside it
  | 'subagent' // a sub-session moves with its parent, never alone
  | 'prepared' // nothing was sent yet
  | 'noProject' // a session with No project
  | 'noGit' // its folder is not in a Git repository
  | 'noCommits' // the repository has no commit yet
  | 'operation' // a merge, rebase, cherry-pick or revert is under way
  | 'tooLarge' // the pack would pass MOVE_MAX_BYTES
  | 'noRemote' // the target has no such project and nothing to clone it from
  | 'gitMissing' // the target has no git
  | 'agentMissing' // the target has no agent of the session's kind
  | 'agentOff' // turned off there
  | 'agentNotInstalled' // not installed there, or cannot start
  | 'signedOut' // installed there, signed out
  | 'sameHost' // the target is the session's own host
  | 'offline' // the target or the source is not connected
  | 'olderHost' // the other host's Kite cannot move sessions yet

/** What the user is told before a move and that does not stop it. */
export type MoveNote =
  | 'ignoredFiles' // files .gitignore leaves out stay behind
  | 'submodules' // submodules come as their commits only
  | 'lfs' // Git LFS files come as pointers; the target fetches them itself
  | 'signInUnknown' // the target's agent has not said yet whether it is signed in
  | 'carry' // the agent there starts again from Kite's copy of the conversation

/** A remote of the source's repository, its URL without any user name or password in it. */
export interface MoveRemote {
  name: string
  url: string
}

/** What the source host says of the session: `moves.inspect`. */
export interface MoveSource {
  sessionId: string
  title: string | null
  agentId: AgentId
  harness: HarnessId
  agentName: string
  platform: Platform
  /** The folder the agent works in: the worktree's, else the project's. */
  cwd: string
  projectPath: string
  projectName: string
  /** It works in a worktree of its own. */
  worktree: boolean
  conversation: MoveConversationKind
  git: MoveSourceGit | null
  problems: MoveProblem[]
  notes: MoveNote[]
}

export interface MoveSourceGit {
  remotes: MoveRemote[]
  /** The remote to match and clone from: the branch's upstream's, else `origin`, else the first. */
  remote: string | null
  branch: string | null
  head: string
  /** The branch's upstream, as `origin/feat`; null without one. */
  upstream: string | null
  /** Changed, staged and untracked files. */
  changes: number
}

/** What the target host says it would do: `moves.check`. */
export interface MoveTarget {
  platform: Platform
  agent: {
    agentId: AgentId
    name: string
    /** Usable; or why not. */
    state: 'ready' | 'signInUnknown' | 'signedOut' | 'notInstalled' | 'off'
  } | null
  /** A project of its own whose remote is the same repository. */
  project: { path: string; remote: string } | null
  /** Where a clone would go, when no project matched and the source has a remote. */
  clonePath: string | null
  problems: MoveProblem[]
}

/** The source's pack: `moves.pack`. */
export interface MovePack {
  files: MovePackFile[]
  git: MoveGitPack
  conversation: MoveConversation
}

export interface MovePackFile {
  name: string
  size: number
  /** SHA-256 in hex, which the target checks before it uses the file. */
  sha256: string
}

export interface MoveGitPack {
  head: string
  /** The branch checked out; null for a detached HEAD. */
  branch: string | null
  /** The upstream's branch on its remote, as `feat`; null without one. */
  upstream: string | null
  /** The uncommitted changes as two commits on `head`: what is staged, then the working tree. */
  wip: { index: string; tree: string } | null
  /** Whether `bundle` holds commits; false when the target has every one already. */
  bundled: boolean
}

export interface MoveConversation {
  kind: MoveConversationKind
  /** The agent's own session id; empty for `carry`. */
  acpSessionId: string
  /** The folder the transcript names, which the target rewrites to its own. */
  cwd: string
  platform: Platform
  /** Codex's rollout's file name. */
  fileName?: string
}

/** The target's project for the move: `moves.prepare`. */
export interface MovePrepared {
  projectPath: string
  /** It was cloned for this move, and goes again with an undo. */
  cloned: boolean
  /** The commits at its tips, which the pack leaves out. */
  haves: string[]
  /** Its remote for the repository, for the branch's upstream. */
  remote: string | null
}

/** What the target makes of the pack: `moves.apply`. */
export interface MoveApply {
  moveId: string
  files: MovePackFile[]
  git: MoveGitPack
  conversation: MoveConversation
  /** The target's agent the session goes on with. */
  agentId: AgentId
  title: string | null
  createdAt: number
  /** The source worked in a worktree of its own, cut from `base`. */
  worktree: { base: string; baseOid: string } | null
}

/** The steps a move shows, in order. */
export const MOVE_STEPS = ['check', 'project', 'pack', 'transfer', 'apply', 'finish'] as const
export type MoveStep = (typeof MOVE_STEPS)[number]

export type MoveStepState = 'pending' | 'running' | 'done' | 'failed'

/** A host as main names it: null for this computer. */
export type MoveHost = string | null

/** What main tells the windows of a move. */
export interface MoveProgress {
  moveId: string
  sessionId: string
  sourceHost: MoveHost
  targetHost: MoveHost
  targetName: string
  steps: { step: MoveStep; state: MoveStepState }[]
  state: 'running' | 'done' | 'failed'
  /** Bytes carried across so far, and in all, while the pack goes. */
  transfer: { sent: number; total: number } | null
  /** The move's session on the target, once there. */
  result: { sessionId: string; projectPath: string } | null
  /** Why it failed, in the host's or main's words. */
  error: string | null
  /** What the failure left: false when the undo itself failed somewhere, which `error` names. */
  undone: boolean
  /** Problems found when it rechecked before starting. */
  problems: MoveProblem[]
}

/** What the window shows before a move: both hosts' facts, joined. */
export interface MovePreview {
  source: MoveSource
  target: MoveTarget
  problems: MoveProblem[]
  notes: MoveNote[]
  /** The target's name, as main knows it. */
  targetName: string
}

/** Where the session went, as its summary carries it; absent while it was not moved. */
export interface MovedTo {
  /** The target as the computer that moved it names it: a host's id, or null for that computer. */
  hostId: string | null
  name: string
  sessionId: string
  at: number
}

/** A remote's URL without the user name and password some HTTPS URLs carry. */
export function withoutCredentials(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(url)
  if (!scheme) return url
  const [, prefix, authority, rest] = scheme
  const at = authority!.lastIndexOf('@')
  if (at < 0) return url
  const user = authority!.slice(0, at)
  // An SSH user, as in ssh://git@host/x, is no secret; anything with a password or token is.
  const keep = /^ssh:\/\//i.test(prefix!) && !user.includes(':') ? `${user}@` : ''
  return `${prefix}${keep}${authority!.slice(at + 1)}${rest}`
}

/**
 * The repository a remote URL names, alike for its HTTPS, SSH and scp-like forms: host and path,
 * lowercased, without `.git` or a trailing slash. Null for what names no repository.
 */
export function remoteKey(url: string): string | null {
  const value = url.trim()
  if (value === '' || value.length > 2_048) return null
  let host: string
  let repo: string
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(value)
  if (scheme) {
    const [, protocol, authority, pathPart] = scheme
    if (protocol!.toLowerCase() === 'file') return `file:${pathPart!.replace(/\/+$/, '')}`
    host = authority!.slice(authority!.lastIndexOf('@') + 1).replace(/:\d+$/, '')
    repo = pathPart!
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(value)
    if (!scp || /^[A-Za-z]$/.test(scp[1]!)) return value.startsWith('/') ? `file:${value}` : null
    host = scp[1]!
    repo = scp[2]!
  }
  const cleaned = repo
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  if (host === '' || cleaned === '') return null
  return `${host.toLowerCase()}/${cleaned.toLowerCase()}`
}

/** Whether a remote can be cloned on another computer: not a folder of the source's own. */
export function isClonable(url: string): boolean {
  const key = remoteKey(url)
  if (key === null || key.startsWith('file:')) return false
  return /^(?:https?|ssh|git):\/\//i.test(url) || /^(?:[^@/\s]+@)?[^:/\s]{2,}:(?!\/\/)/.test(url)
}

/** The repository's name as a remote URL ends, for the folder a clone goes in. */
export function repoName(url: string): string | null {
  const key = remoteKey(url)
  if (key === null) return null
  const last = key.split('/').pop() ?? ''
  const name = last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  return name === '' ? null : name.slice(0, 64)
}
