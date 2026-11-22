// Huli: what a session in the harness's own sandbox starts its agent with. Claude Code takes its
// SDK's `sandbox` option; Codex a sandbox policy on every turn. Both are set to fail closed: a
// sandbox that cannot start stops the session, and no command may ask to run outside it.

import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { SandboxNetwork } from '@shared/sandbox'

/** A sandboxed session's choice as its driver gets it. */
export interface SessionSandbox {
  tier: 'native' | 'container'
  network: SandboxNetwork
  /** The folders its agent may write: the session's own and, for a worktree, its project. */
  roots: string[]
  /**
   * The port of the listener the agent's network setting gives it, for `agent`; null when the
   * setting gives it none, which `agent` refuses rather than open the network.
   */
  proxyPort: number | null
  /** The project's `.git` may be written, as the user let the sandbox commit. */
  gitWritable: boolean
}

export class SandboxUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'network' | 'mode' | 'setup',
  ) {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}

/**
 * Folders in the home folder that hold keys and sign-ins: a sandboxed command may read none of
 * them, though it may read the rest of the computer as before.
 */
const SECRET_DIRS: readonly string[][] = [
  ['.ssh'],
  ['.gnupg'],
  ['.aws'],
  ['.azure'],
  ['.kube'],
  ['.docker'],
  ['.git-credentials'],
  ['.netrc'],
  ['.config', 'gh'],
  ['.config', 'gcloud'],
]

/** The part of Claude Code's `SandboxSettings` Kite sets. */
export interface ClaudeSandboxOption {
  enabled: true
  failIfUnavailable: true
  allowUnsandboxedCommands: false
  autoAllowBashIfSandboxed: false
  filesystem: { allowWrite: string[]; denyWrite?: string[]; denyRead: string[] }
  network: {
    allowedDomains?: string[]
    strictAllowlist?: boolean
    httpProxyPort?: number
    socksProxyPort?: number
  }
}

/**
 * Claude Code's sandbox for a session: its shell commands write only inside the session's folders
 * and read none of the key folders; their network is off, through the agent's own exit, or open,
 * where Claude Code asks before a command first reaches each new domain. Its Read, Edit and Web
 * tools and MCP servers run outside the sandbox and stay held by the permission requests.
 */
export function claudeSandbox(
  sandbox: SessionSandbox,
  home: string,
  platform: Platform,
): ClaudeSandboxOption {
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  return {
    enabled: true,
    // A sandbox that cannot start ends the query with an error result instead of running unheld.
    failIfUnavailable: true,
    // No command may set dangerouslyDisableSandbox and run outside it.
    allowUnsandboxedCommands: false,
    // Kite's approvals still decide which commands run.
    autoAllowBashIfSandboxed: false,
    filesystem: {
      allowWrite: [...new Set(sandbox.roots)],
      // Commits and history stay as they are unless the user lets the sandbox commit.
      ...(sandbox.gitWritable
        ? {}
        : { denyWrite: [...new Set(sandbox.roots)].map((root) => join(root, '.git')) }),
      denyRead: SECRET_DIRS.map((dir) => join(home, ...dir)),
    },
    network: claudeNetwork(sandbox),
  }
}

function claudeNetwork(sandbox: SessionSandbox): ClaudeSandboxOption['network'] {
  switch (sandbox.network) {
    // The model's calls are Claude Code's own, outside the sandbox: its commands get none.
    case 'none':
    case 'model':
      return { allowedDomains: [], strictAllowlist: true }
    case 'agent':
      if (sandbox.proxyPort === null) throw noExit()
      // Claude Code's own proxy steps aside for the listener, which reaches only the exit the
      // agent's network setting picked and refuses everything while it has none.
      return { httpProxyPort: sandbox.proxyPort, socksProxyPort: sandbox.proxyPort }
    case 'open':
      return {}
  }
}

function noExit(): SandboxUnavailableError {
  return new SandboxUnavailableError(
    'The agent network setting gives this agent no exit of its own',
    'network',
  )
}

/** Codex's sandbox policies, as `turn/start` takes them. */
export type CodexPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

/**
 * The policy a sandboxed Codex session's turn runs with, from the one its mode would: read-only
 * stays read-only, every other mode writes only inside the session's folders, and the network is
 * on only when the choice opens it. Full access is never sandboxed, so it is refused.
 */
export function codexPolicy(mode: CodexPolicy, sandbox: SessionSandbox): CodexPolicy {
  if (sandbox.network === 'agent') {
    throw new SandboxUnavailableError(
      "Codex's sandbox turns the network on or off as a whole",
      'network',
    )
  }
  // Codex calls its model itself, outside the sandbox, so only the commands lose the network.
  const networkAccess = sandbox.network === 'open'
  if (mode.type === 'readOnly') return { type: 'readOnly', networkAccess }
  if (mode.type === 'dangerFullAccess') {
    throw new SandboxUnavailableError('Full access does not run in a sandbox', 'mode')
  }
  return {
    type: 'workspaceWrite',
    // The session's folder is Codex's workspace already; a worktree's project is added.
    writableRoots: [...new Set([...mode.writableRoots, ...sandbox.roots])],
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

/** The `sandbox` mode `thread/start` takes for a policy. */
export function codexSandboxMode(
  policy: CodexPolicy,
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (policy.type === 'readOnly') return 'read-only'
  if (policy.type === 'dangerFullAccess') return 'danger-full-access'
  return 'workspace-write'
}

/** What `windowsSandbox/readiness` answers, read leniently: the field's name is not documented. */
export function codexWindowsReady(
  result: unknown,
): 'ready' | 'notConfigured' | 'updateRequired' | null {
  const values =
    typeof result === 'string'
      ? [result]
      : typeof result === 'object' && result !== null
        ? Object.values(result as Record<string, unknown>)
        : []
  for (const value of values) {
    if (value === 'ready' || value === 'notConfigured' || value === 'updateRequired') return value
  }
  return null
}
