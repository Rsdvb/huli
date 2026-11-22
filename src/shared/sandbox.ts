// Huli: running an agent isolated (沙箱). The user picks a tier, at three levels: a default in
// Settings, a project's own, and a session's at its start. Kite never picks one by itself: off is
// the default, and a tier that cannot run stops the session's start instead of falling back to
// another. See tools/huli/README.md (Sandbox) for what each tier holds back and what it costs.

import { harnessOf, type HarnessId } from './agents'
import type { Platform } from './platform'
import type { AgentId } from './thread'

/**
 * off: as today. native: the harness's own sandbox, through the options Kite starts it with.
 * container: the agent's process in a Docker or Podman container with only the project mounted.
 */
export type SandboxTier = 'off' | 'native' | 'container'

export const SANDBOX_TIERS: readonly SandboxTier[] = ['off', 'native', 'container']

/**
 * What the agent's commands may reach: nothing, only the exit the agent's network setting (Agent
 * 网络) picks for it, or anything.
 */
export type SandboxNetwork = 'none' | 'agent' | 'open'

export const SANDBOX_NETWORKS: readonly SandboxNetwork[] = ['none', 'agent', 'open']

export interface SandboxChoice {
  tier: SandboxTier
  network: SandboxNetwork
}

export const SANDBOX_OFF: SandboxChoice = { tier: 'off', network: 'open' }

/** Settings' part: the default of a project that keeps none of its own, and the approvals rule. */
export interface SandboxSettings {
  tier: SandboxTier
  network: SandboxNetwork
  /**
   * In a session whose sandbox runs, an edit of a file inside the project is allowed once without
   * asking, as the auto-approve setting's edits level does. A high request never is.
   */
  autoApproveEdits: boolean
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  tier: 'off',
  network: 'none',
  autoApproveEdits: false,
}

export function isSandboxTier(value: unknown): value is SandboxTier {
  return typeof value === 'string' && (SANDBOX_TIERS as readonly string[]).includes(value)
}

export function isSandboxNetwork(value: unknown): value is SandboxNetwork {
  return typeof value === 'string' && (SANDBOX_NETWORKS as readonly string[]).includes(value)
}

/** A stored or sent choice, or null for anything else; its fields are copied, never shared. */
export function sandboxChoiceOf(value: unknown): SandboxChoice | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { tier, network } = value as Record<string, unknown>
  if (!isSandboxTier(tier) || !isSandboxNetwork(network)) return null
  // Off holds nothing back, so its network is never anything else.
  return tier === 'off' ? { ...SANDBOX_OFF } : { tier, network }
}

export function sameSandbox(a: SandboxChoice, b: SandboxChoice): boolean {
  return a.tier === b.tier && (a.tier === 'off' || a.network === b.network)
}

/**
 * The choice a new session starts with: the one asked for, else the project's, else the default.
 */
export function resolveSandbox(
  asked: SandboxChoice | null | undefined,
  project: SandboxChoice | null | undefined,
  settings: Pick<SandboxSettings, 'tier' | 'network'> | undefined,
): SandboxChoice {
  const picked =
    asked ?? project ?? (settings ? { tier: settings.tier, network: settings.network } : null)
  return picked ? (sandboxChoiceOf(picked) ?? { ...SANDBOX_OFF }) : { ...SANDBOX_OFF }
}

/** Why a tier is not offered for an agent here. */
export type SandboxBlock =
  /** The harness has no sandbox of its own. */
  | 'noSandbox'
  /** It has one, which Kite does not drive yet. */
  | 'notWired'
  /** Not on this system. */
  | 'platform'
  /** The way Kite runs this agent cannot run inside a container yet. */
  | 'protocol'

/** A one-time setup a harness's own sandbox needs on a system, which the user runs. */
export type SandboxSetup = 'claudeWindows' | 'claudeLinux' | 'codexWindows' | 'container'

export interface TierSupport {
  available: boolean
  block?: SandboxBlock
  /** The network presets the tier holds the agent to; empty when it is not available. */
  networks: SandboxNetwork[]
  setup?: SandboxSetup
}

export interface AgentSandboxSupport {
  native: TierSupport
  container: TierSupport
}

const BLOCKED = (block: SandboxBlock): TierSupport => ({ available: false, block, networks: [] })

/**
 * Harnesses with a sandbox of their own that Kite does not drive: each turns it on for its whole
 * process or only from its own CLI, while Kite runs one process for many sessions, or over an
 * interface the sandbox does not take. Checked against their docs on 2026-11-22.
 */
const OWN_SANDBOX_NOT_WIRED: ReadonlySet<HarnessId> = new Set([
  'gemini',
  'qwen',
  'copilot',
  'cursor',
  'droid',
  'qoder',
  'qoder-cn',
  'goose',
])

/**
 * The harness's own sandbox on `platform`. Claude Code sandboxes its shell commands with Seatbelt
 * on macOS, bubblewrap on Linux and WSL 2, and a sandbox user on Windows that a one-time install
 * sets up; Codex with Seatbelt, bubblewrap and its Windows sandbox. Their file tools stay checked
 * by the permission requests, as without the sandbox.
 */
export function nativeSupport(harness: HarnessId, platform: Platform): TierSupport {
  const desktop = platform === 'darwin' || platform === 'linux' || platform === 'win32'
  if (harness === 'claude-code') {
    if (!desktop) return BLOCKED('platform')
    return {
      available: true,
      // On Windows the sandbox's network rule is fixed when it is installed, so a session asks for
      // the one it was installed with; a mismatch stops the start with Claude Code's own words.
      networks: ['none', 'agent', 'open'],
      ...(platform === 'win32'
        ? { setup: 'claudeWindows' as const }
        : platform === 'linux'
          ? { setup: 'claudeLinux' as const }
          : {}),
    }
  }
  if (harness === 'codex') {
    if (!desktop) return BLOCKED('platform')
    // Codex's sandbox turns the network on or off as a whole; it cannot hold it to one exit.
    return {
      available: true,
      networks: ['none', 'open'],
      ...(platform === 'win32' ? { setup: 'codexWindows' as const } : {}),
    }
  }
  return BLOCKED(OWN_SANDBOX_NOT_WIRED.has(harness) ? 'notWired' : 'noSandbox')
}

/** How Kite runs an agent, as far as a container is concerned. */
export type ContainerLaunch = 'acp-package' | 'node-script' | 'other'

/**
 * A container runs an ACP agent that Kite installs from npm, or a script on Node.js, with the
 * engine of the system: Docker or Podman, and on Windows Docker Desktop or Docker inside WSL. The
 * engine is looked for only when such a session starts.
 */
export function containerSupport(launch: ContainerLaunch, platform: Platform): TierSupport {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return BLOCKED('platform')
  }
  if (launch === 'other') return BLOCKED('protocol')
  // Holding a container to one exit needs a proxy of its own beside it, which is not built yet.
  return { available: true, networks: ['none', 'open'], setup: 'container' }
}

export function agentSandboxSupport(
  agentId: AgentId,
  launch: ContainerLaunch,
  platform: Platform,
): AgentSandboxSupport {
  return {
    native: nativeSupport(harnessOf(agentId), platform),
    container: containerSupport(launch, platform),
  }
}

/** Whether the choice can run for an agent with this support: its tier and its network preset. */
export function supportsChoice(support: AgentSandboxSupport, choice: SandboxChoice): boolean {
  if (choice.tier === 'off') return true
  const tier = support[choice.tier]
  return tier.available && tier.networks.includes(choice.network)
}

/**
 * A folder on a Windows drive, which a container reaches through WSL's 9p file share or Docker
 * Desktop's, both several times slower than the drive itself; a folder inside WSL is not one.
 */
export function onWindowsDrive(folder: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(folder)
}

/** Kite's container image: what a pull downloads and what it then takes on disk, in MB. */
export const SANDBOX_IMAGE_MB = { download: 80, disk: 330 } as const

/**
 * What was measured on the owner's computer on 2026-11-22 (Windows 11, Ryzen 9 9950X3D, NVMe, WSL 2
 * Ubuntu 24.04 with Docker 29.9): `npm ci` with a warm cache, `tsc` and `vitest run` of a small
 * TypeScript project (46 packages, 80 modules, 40 test files), three runs each, in seconds. The
 * copy shows these numbers next to each tier.
 */
export const SANDBOX_MEASURED = {
  /** The project on E:, run on Windows itself. */
  windowsNative: 19.2,
  /** The same project in a container, mounted from E: through WSL. */
  containerWindowsDrive: 40.6,
  /** The project inside WSL's own disk, in a container. */
  containerWslDisk: 7.4,
  /** The same inside WSL without a container: the container itself adds about 3 %. */
  wslNative: 7.2,
  /** A search over 2,499 files: on Windows, and from WSL through the share. */
  searchWindows: 0.71,
  searchShare: 5.2,
  /** `docker run` of an idle container through wsl.exe, and Docker's own start once a day. */
  containerStart: 0.76,
  engineStart: 0.79,
  /** The memory Docker's services hold while one runs, and each container's own overhead, in MB. */
  engineMemoryMb: 105,
  containerMemoryMb: 11,
} as const

/** Where a container runs: Docker or Podman on the system, or Docker inside WSL on Windows. */
export type ContainerEngineKind = 'docker' | 'podman' | 'wsl-docker'

/** The container engine and Kite's image, as the host found them when asked. */
export interface ContainerStatus {
  engine: { kind: ContainerEngineKind; version: string | null } | null
  /** Why there is none: no engine found, or one found that does not answer. */
  engineProblem?: 'notFound' | 'notRunning'
  image: {
    ref: string
    present: boolean
    /** What a pull downloads and what the image then takes on disk, in MB. */
    downloadMb: number
    diskMb: number
  }
  /** A pull is running. */
  pulling: boolean
}
