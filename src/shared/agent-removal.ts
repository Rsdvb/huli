// Huli: what removing an agent can also take off its host: the agent's program, the way it was
// installed, and the agent's own data. Settings › Agents asks the host for the plan first, then
// for the steps the user saw and ticked, which the host plans again and runs only where they match.

import type { AgentResetBusy, AgentSecretStore } from './agent-reset'
import type { Platform } from './platform'
import type { AgentId } from './thread'

export type RemovalPart = 'program' | 'data'

/**
 * `command`: a command the host runs, `path` being the line as the platform's shell reads it;
 * `folder` and `file` go whole; `contents`: what the folder `path` holds but the names `except`
 * keeps; `secret`: an entry of the system's credential store, named by `path`.
 */
export type RemovalStepKind = 'command' | 'folder' | 'file' | 'contents' | 'secret'

export interface RemovalStep {
  /** `part:kind:path`: the same in every plan of the same thing, which a run is asked by. */
  id: string
  part: RemovalPart
  kind: RemovalStepKind
  path: string
  /** What Kite installed for the harness itself, rather than the user's own program. */
  kite?: true
  except?: string[]
  store?: AgentSecretStore
  /** Its size on disk; null for what has none, such as a command without a folder to measure. */
  bytes: number | null
  /** The last lines a command printed, once it ran. */
  output?: string
}

/** How the user's own program was installed, as far as the host can tell from where it lives. */
export type RemovalMethod = 'npm' | 'brew' | 'winget' | 'native' | 'uvx'

/**
 * Why the host leaves the program it found to the user: installed in a way it cannot tell,
 * the tool that removes it was not found, a path that cannot safely reach the command line, or a
 * copy that ships inside an app.
 */
export type RemovalManualReason = 'unknown' | 'tool' | 'unsafe' | 'app'

/**
 * Who else uses the program, a line the dialog adds: Claude's desktop app and IDE extensions, the
 * Codex app and the Antigravity app bring their own copies. `path-left`: the installer's line in
 * PATH or the shell's profile stays, pointing at nothing.
 */
export type ProgramNote = 'claude-apps' | 'codex-app' | 'antigravity-app' | 'path-left'

/**
 * Who else uses the data: Claude's apps use ~/.claude and the Codex app ~/.codex too; the
 * Antigravity app shares agy's sign-in. `codebuddy-sign-in`: its browser sign-in lives where Kite
 * does not know; `picked-folder`: the folder is one the user picked for the agent;
 * `keychain-left`: what it keeps in the system's credential store stays. The `*-uninstall` notes
 * say what the vendor's own uninstall command takes beyond the agent's data, such as its program or
 * what an app of the vendor shares; `cursor-editor`: only the CLI's own files go from the folder
 * the Cursor editor uses too.
 */
export type DataNote =
  | 'claude-apps'
  | 'codex-app'
  | 'antigravity-app'
  | 'codebuddy-sign-in'
  | 'picked-folder'
  | 'keychain-left'
  | 'devin-uninstall'
  | 'hermes-uninstall'
  | 'kilo-uninstall'
  | 'nova-uninstall'
  | 'codewhale-uninstall'
  | 'cursor-editor'

/** The other programs that use a folder of an agent, which Kite therefore leaves. */
export type RemovalSharer =
  | 'amp'
  | 'augment'
  | 'autohand-squad'
  | 'bob-ide'
  | 'coco-desktop'
  | 'compass-sass'
  | 'copilot'
  | 'corust'
  | 'crow'
  | 'devin-desktop'
  | 'dirac'
  | 'factory-app'
  | 'gemini'
  | 'goose-desktop'
  | 'grok-cli'
  | 'harn'
  | 'hermes-desktop'
  | 'hermes-relayer'
  | 'junie-ide'
  | 'kilo-apps'
  | 'kimchi'
  | 'kimi-apps'
  | 'minimax-desktop'
  | 'minionx'
  | 'omp-gui'
  | 'poolside-assistant'
  | 'qoder-ide'
  | 'qoder-cn-ide'
  | 'qwen-apps'
  | 'stakpak-tab'
  | 'vibe-apps'
  | 'vtcode-desktop'

/**
 * What stays, and why: a vendor's app or other agents use it too, it is the program (which
 * uninstalling removes), it belongs to the Windows sandbox accounts Codex made, other programs
 * (`with`) use it too, or it may hold the user's own work, such as worktrees with changes.
 */
export interface RemovalKept {
  path: string
  reason: 'app' | 'agents' | 'program' | 'sandbox' | 'shared' | 'work'
  store?: AgentSecretStore
  with?: RemovalSharer
}

export interface AgentRemovalPreview {
  home: string
  platform: Platform
  program: {
    /** Other agents that run on the same harness, whose program uninstalling would take. */
    blocked: string[] | null
    method: RemovalMethod | null
    steps: RemovalStep[]
    /** The user's program, found but left for the user to remove; `command` removes it by hand. */
    manual: { path: string; reason: RemovalManualReason; command?: string } | null
    notes: ProgramNote[]
  }
  data: {
    /** Whether Kite knows where the agent keeps its data. */
    known: boolean
    steps: RemovalStep[]
    kept: RemovalKept[]
    notes: DataNote[]
  }
  busy: AgentResetBusy[]
  /** Claude Code processes outside Kite that have the agent's folder open. */
  outside: number
}

export interface AgentRemovalResult {
  done: RemovalStep[]
  failed: { step: RemovalStep; error: string }[]
  /** Steps asked for that the host no longer plans, such as a folder gone meanwhile. */
  skipped: string[]
}

/** To the port that asked for the run, as each step starts and ends. */
export interface AgentRemovalProgress {
  agentId: AgentId
  stepId: string
  state: 'running' | 'done' | 'failed'
  error?: string
}

/** The most steps one run takes; a plan has far fewer. */
export const MAX_REMOVAL_STEPS = 64

export function removalStepId(part: RemovalPart, kind: RemovalStepKind, target: string): string {
  return `${part}:${kind}:${target}`
}
