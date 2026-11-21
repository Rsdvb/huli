// Huli: uninstalling an agent's program the way it was installed, as far as the host can tell
// from where it lives. What Kite installed in its harnesses folder always goes; the user's own
// program goes by its own route: `npm uninstall -g`, `brew uninstall`, `winget uninstall`, or the
// files a vendor's installer wrote, where its docs or code say which:
//
// - Claude Code (https://code.claude.com/docs/en/setup, Uninstall, checked 2026-11-21):
//   `~/.local/bin/claude` (`claude.exe` on Windows) and `~/.local/share/claude`.
// - Codex's install.sh (releases.openai.com/codex/install.sh, checked 2026-11-21): the releases
//   in `$CODEX_HOME/packages/standalone`, linked as `~/.local/bin/codex` (and
//   `codex-code-mode-host` on macOS); `packages/app-server-daemon` is not the CLI's.
// - agy's install.sh and install.ps1 (antigravity.google/cli, checked 2026-11-21): the one file
//   `~/.local/bin/agy`, or `%LOCALAPPDATA%\agy\bin\agy.exe`.
// - OpenCode 2's install script (opencode.ai/v2/install, checked 2026-11-21): `~/.opencode/bin`'s
//   `opencode` and its `opencode2` shim.
// - Doubao CLI 2.37.2's runtime.cjs: npm's package downloads the program into
//   `<data>/doubao_cli/app`, which npm leaves behind.
//
// Anything else found on PATH is left for the user, with its path.

import path from 'node:path'
import type { AgentRemovalPreview, RemovalMethod, ProgramNote } from '@shared/agent-removal'
import type { Platform } from '@shared/platform'
import type { HarnessId } from '@shared/thread'
import type { BinaryInstalls } from '../binary-install'
import { npmPrefixOf } from '../binary-install'
import type { LaunchKind } from '../catalog'
import { dataFolder } from '../doubao/program'
import { getEnv, type Env } from '../find-command'
import { shimTarget } from '../installed-cli'
import {
  brewUninstall,
  npmUninstall,
  uvCacheClean,
  wingetUninstall,
  type RemovalCommand,
} from './commands'
import { within } from './guard'
import type { PlannedStep, RemovalFiles } from './steps'

export interface RemovalTools {
  npm: string | null
  brew: string | null
  winget: string | null
  uv: string | null
}

export interface ProgramFacts {
  harness: HarnessId
  launch: LaunchKind
  installs?: BinaryInstalls
  platform: Platform
  home: string
  /** The agent's environment, which the variables that move a program are read from. */
  env: Env
  /** The harnesses folder, where Kite installs a harness's packages and releases. */
  kiteRoot: string
  /** The user's program as detection found it: the agent's CLI, or a binary harness's program. */
  program: string | null
  /** The command on PATH that starts it, such as npm's shim; null when none was found. */
  launcher: string | null
  tools: RemovalTools
  /** Other agents that run on the same harness, which need its program. */
  others: readonly string[]
}

export interface ProgramPlan {
  blocked: string[] | null
  method: RemovalMethod | null
  steps: PlannedStep[]
  manual: AgentRemovalPreview['program']['manual']
  notes: ProgramNote[]
  /** The files and folders the steps may remove. */
  roots: string[]
}

const SHIM_LIMIT = 64 * 1024
const HARNESS_FOLDER = /^[a-z0-9][a-z0-9-]*$/

function pathsOf(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Who else brings or uses the same program, whatever is removed. */
function programNotes(harness: HarnessId): ProgramNote[] {
  switch (harness) {
    case 'claude-code':
      return ['claude-apps']
    case 'codex':
      return ['codex-app']
    case 'antigravity':
      return ['antigravity-app']
    default:
      return []
  }
}

function same(a: string, b: string, platform: Platform): boolean {
  return within(a, b, platform) && within(b, a, platform)
}

/** The program's paths, as found and as they resolve: its own, and its launcher's target. */
async function resolvedPaths(facts: ProgramFacts, files: RemovalFiles): Promise<string[]> {
  const p = pathsOf(facts.platform)
  const found: string[] = []
  const add = (file: string | null): void => {
    if (file && !found.includes(file)) found.push(file)
  }
  for (const file of [facts.program, facts.launcher]) {
    if (!file) continue
    // As found too, for a home folder that lies behind a link, as macOS's /var does.
    add(p.resolve(file))
    add(await files.realpath(file).catch(() => file))
    if (facts.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) {
      const text = await files.readText(file, SHIM_LIMIT).catch(() => null)
      const target = text === null ? null : shimTarget(text, file)
      if (target) add(p.resolve(target))
    }
  }
  return found
}

interface Found {
  method: RemovalMethod
  steps: PlannedStep[]
  roots: string[]
  notes?: ProgramNote[]
  /** The command the route takes, when it cannot run it: its tool is missing, or it is unsafe. */
  blocked?: { reason: 'tool' | 'unsafe'; command?: string }
}

function commandStep(command: RemovalCommand, measure?: string): PlannedStep | null {
  if (!command.run) return null
  return {
    part: 'program',
    kind: 'command',
    path: command.line,
    run: command.run,
    ...(measure ? { measure } : {}),
  }
}

function viaCommand(
  method: RemovalMethod,
  command: RemovalCommand | null,
  measure?: string,
): Found {
  if (!command) return { method, steps: [], roots: [], blocked: { reason: 'unsafe' } }
  const step = commandStep(command, measure)
  return step
    ? { method, steps: [step], roots: [] }
    : { method, steps: [], roots: [], blocked: { reason: 'tool', command: command.line } }
}

function slashed(file: string, platform: Platform): string {
  return platform === 'win32' ? file.toLowerCase().replaceAll('\\', '/') : file
}

/** A package manager's route, told by the folder the program lives in. */
async function managed(
  facts: ProgramFacts,
  real: readonly string[],
  files: RemovalFiles,
): Promise<Found | null> {
  const { installs, platform, tools } = facts
  if (!installs) return null
  const p = pathsOf(platform)
  if (installs.npm) {
    for (const file of real) {
      const prefix = npmPrefixOf(file, installs.npm, platform)
      if (!prefix) continue
      const folder = p.join(
        prefix,
        ...(platform === 'win32' ? [] : ['lib']),
        'node_modules',
        ...installs.npm.split('/'),
      )
      if ((await files.kind(folder)) !== 'folder') continue
      return viaCommand('npm', npmUninstall(installs.npm, prefix, tools.npm, platform), folder)
    }
  }
  const formula = installs.brew?.split('/').pop()
  for (const file of real) {
    const at = slashed(file, platform)
    if (installs.brew && formula && at.includes(`/Cellar/${formula}/`)) {
      return viaCommand('brew', brewUninstall(installs.brew, false, tools.brew, platform))
    }
    if (installs.brewCask && at.includes(`/Caskroom/${installs.brewCask}/`)) {
      return viaCommand('brew', brewUninstall(installs.brewCask, true, tools.brew, platform))
    }
    const id = installs.winget?.toLowerCase()
    if (platform === 'win32' && installs.winget && id && at.includes(`/winget/packages/${id}_`)) {
      return viaCommand('winget', wingetUninstall(installs.winget, tools.winget, platform))
    }
  }
  return null
}

const fileStep = (target: string, prune?: string[]): PlannedStep => ({
  part: 'program',
  kind: 'file',
  path: target,
  ...(prune ? { prune } : {}),
})

const folderStep = (target: string): PlannedStep => ({
  part: 'program',
  kind: 'folder',
  path: target,
})

/** A link at `link` whose target lies inside `root`, which the installer made. */
async function linkInto(
  link: string,
  root: string,
  files: RemovalFiles,
  platform: Platform,
): Promise<boolean> {
  if ((await files.kind(link)) !== 'link') return false
  const target = await files.realpath(link).catch(() => null)
  return target !== null && within(root, target, platform)
}

/** The files a vendor's own installer wrote, for the installers whose layout is known. */
async function native(
  facts: ProgramFacts,
  real: readonly string[],
  files: RemovalFiles,
): Promise<Found | null> {
  const { harness, platform, home, env } = facts
  const p = pathsOf(platform)
  const found = facts.program
  if (!found) return null
  const is = (target: string): boolean => real.some((file) => same(file, target, platform))
  const under = (root: string): boolean => real.some((file) => within(root, file, platform))
  switch (harness) {
    case 'claude-code': {
      const share = p.join(home, '.local', 'share', 'claude')
      if (platform === 'win32') {
        const exe = p.join(home, '.local', 'bin', 'claude.exe')
        if (!is(exe) || (await files.kind(exe)) !== 'file') return null
        const steps = [fileStep(exe)]
        if ((await files.kind(share)) === 'folder') steps.push(folderStep(share))
        return { method: 'native', steps, roots: [exe, share] }
      }
      if (!under(share)) return null
      const link = p.join(home, '.local', 'bin', 'claude')
      const steps = [folderStep(share)]
      if (await linkInto(link, share, files, platform)) steps.unshift(fileStep(link))
      return { method: 'native', steps, roots: [link, share] }
    }
    case 'codex': {
      if (platform === 'win32') return null
      const homes = [p.join(home, '.codex')]
      const moved = getEnv(env, 'CODEX_HOME', platform)
      if (moved && p.isAbsolute(moved)) homes.push(moved)
      const root = homes
        .map((folder) => p.join(folder, 'packages', 'standalone'))
        .find((candidate) => under(candidate))
      if (!root) return null
      const steps: PlannedStep[] = []
      const roots = [root]
      const bins = [...new Set([facts.launcher, found].map((file) => file && p.dirname(file)))]
      for (const bin of bins) {
        if (!bin) continue
        for (const name of ['codex', 'codex-code-mode-host']) {
          const link = p.join(bin, name)
          if (roots.includes(link) || !(await linkInto(link, root, files, platform))) continue
          steps.push(fileStep(link))
          roots.push(link)
        }
      }
      steps.push(folderStep(root))
      return { method: 'native', steps, roots, notes: ['path-left'] }
    }
    case 'antigravity': {
      if (platform === 'win32') {
        const local = getEnv(env, 'LOCALAPPDATA', platform)
        const base = local && p.isAbsolute(local) ? local : p.join(home, 'AppData', 'Local')
        const folder = p.join(base, 'agy')
        const exe = p.join(folder, 'bin', 'agy.exe')
        if (!is(exe) || (await files.kind(exe)) !== 'file') return null
        return {
          method: 'native',
          steps: [fileStep(exe, [p.join(folder, 'bin'), folder])],
          roots: [exe],
          notes: ['path-left'],
        }
      }
      const bin = p.join(home, '.local', 'bin', 'agy')
      if (!is(bin) || (await files.kind(bin)) !== 'file') return null
      return { method: 'native', steps: [fileStep(bin)], roots: [bin], notes: ['path-left'] }
    }
    case 'opencode': {
      if (platform === 'win32') return null
      const folder = p.join(home, '.opencode')
      const bin = p.join(folder, 'bin')
      const program = p.join(bin, 'opencode')
      if (!is(program) || (await files.kind(program)) !== 'file') return null
      const shim = p.join(bin, 'opencode2')
      const steps = [fileStep(program, [bin, folder])]
      if ((await files.kind(shim)) === 'file') steps.unshift(fileStep(shim))
      return { method: 'native', steps, roots: [program, shim], notes: ['path-left'] }
    }
    default:
      return null
  }
}

/**
 * A copy that ships inside an app, which only removing the app takes away: in a macOS bundle, a
 * Store app's package, or the Antigravity app's folder.
 */
function inApp(real: readonly string[], platform: Platform): boolean {
  return real.some((file) => {
    const at = slashed(file, platform)
    if (platform !== 'win32') return at.includes('.app/')
    return at.includes('/windowsapps/') || at.includes('/appdata/local/programs/antigravity/')
  })
}

/** Doubao's program, which npm's package downloads and npm leaves behind. */
async function doubaoRuntime(facts: ProgramFacts, files: RemovalFiles): Promise<string | null> {
  const app = pathsOf(facts.platform).join(dataFolder(facts.env, facts.platform, facts.home), 'app')
  return (await files.kind(app)) === 'folder' ? app : null
}

/** How the agent's program is removed: what Kite installed, then the user's own. */
export async function planProgram(facts: ProgramFacts, files: RemovalFiles): Promise<ProgramPlan> {
  const { harness, platform, launch } = facts
  const p = pathsOf(platform)
  const notes = programNotes(harness)
  const plan: ProgramPlan = {
    blocked: null,
    method: null,
    steps: [],
    manual: null,
    notes,
    roots: [],
  }
  if (facts.others.length > 0) return { ...plan, blocked: [...facts.others] }
  const kite = p.join(facts.kiteRoot, harness)
  if (HARNESS_FOLDER.test(harness) && (await files.kind(kite)) === 'folder') {
    plan.steps.push({ part: 'program', kind: 'folder', path: kite, kite: true })
    plan.roots.push(kite)
  }
  if (launch.kind === 'uvx') {
    plan.method = 'uvx'
    const command = uvCacheClean(launch.package, facts.tools.uv, platform)
    const step = command && commandStep(command)
    if (step) plan.steps.unshift(step)
    else if (command) plan.manual = { path: launch.package, reason: 'tool', command: command.line }
  }
  // Kite's own release of a binary harness is what Kite installed, not the user's program.
  const program =
    facts.program && !within(facts.kiteRoot, facts.program, platform) ? facts.program : null
  if (!program) {
    if (harness === 'doubao') {
      const app = await doubaoRuntime(facts, files)
      if (app) {
        plan.steps.push(folderStep(app))
        plan.roots.push(app)
      }
    }
    return plan
  }
  const real = await resolvedPaths({ ...facts, program }, files)
  const found = (await managed(facts, real, files)) ?? (await native(facts, real, files))
  if (!found) {
    plan.manual = { path: program, reason: inApp(real, platform) ? 'app' : 'unknown' }
    return plan
  }
  plan.method = found.method
  plan.notes = [...notes, ...(found.notes ?? [])]
  if (found.blocked) {
    plan.manual = {
      path: program,
      reason: found.blocked.reason,
      ...(found.blocked.command ? { command: found.blocked.command } : {}),
    }
    return plan
  }
  plan.steps.unshift(...found.steps)
  plan.roots.push(...found.roots)
  if (harness === 'doubao' && found.method === 'npm') {
    const app = await doubaoRuntime(facts, files)
    if (app) {
      plan.steps.push(folderStep(app))
      plan.roots.push(app)
    }
  }
  return plan
}
