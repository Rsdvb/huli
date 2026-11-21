// Huli: an agent's own data on its host, which removing it may also delete: its sign-in,
// settings, caches and its own session history. The folders are the reset's (agent-reset/plan.ts),
// read from each agent's code, now taken whole; what another program or app shares stays, and the
// dialog says so. Kite's own sessions of the agent stay in Kite.
//
// The other agents', from their own docs and code, checked 2026-11-21. Where the vendor ships an
// uninstall that removes the data, that command runs instead of Kite deleting folders:
//
// - Muse Code 1.4.24 (dev.meta.ai/docs, its launchers): `$XDG_CONFIG_HOME/muse` or
//   `~/.config/muse`, `$XDG_DATA_HOME/muse` or `~/.local/share/muse` (sessions), the file
//   MUSE_AUTH_PATH names; on macOS its sign-in is in the Keychain. Its docs give no other data
//   folder on Windows, where its launcher takes the same `.config` under the home folder.
// - CodeWhale (codewhale-hq/CodeWhale d045cda, crates/paths, update/uninstall.rs): CODEWHALE_HOME
//   (`~` expanded, relative refused) or `~/.codewhale`, and `~/.deepseek/snapshots` without the
//   variable. `codewhale uninstall --yes --purge-data` purges only with the receipted install
//   (`.codewhale-install.sha256` beside the program) it removes in the same run.
// - Devin CLI 3000.14 (docs.devin.ai command reference): `devin uninstall --clean --force` removes
//   it with "all data including configuration, history"; Devin Desktop uses the same folders on
//   Windows (`%APPDATA%\devin`, `%LOCALAPPDATA%\devin`) and its bundled agent the same config.
// - Hermes Agent (NousResearch/hermes-agent aeb5a07, hermes_cli/uninstall.py): `hermes uninstall
//   --data --yes` removes its home's data and keeps its code; the home is HERMES_HOME, `~/.hermes`
//   or `%LOCALAPPDATA%\hermes`, which the Hermes desktop app shares. The unrelated IBC relayer
//   named Hermes keeps `config.toml` and `keys/` in `~/.hermes`.
// - Kilo Code (Kilo-Org/kilocode v7.8.32, cli/cmd/uninstall.ts): `kilo uninstall --force` removes
//   its XDG config, data, cache and state `kilo` folders, which its VS Code, JetBrains and desktop
//   apps share, and its program.
// - Nova (@compass-ai/nova 1.1.68, dist/cli.js): `nova uninstall --force` clears its keychain
//   entries and the active `~/.nova` (else `~/.compass`, which the Compass Sass gem shares), then
//   runs `npm uninstall -g @compass-ai/nova`.
// - Cursor CLI 2026.11.19 (cli-credentials, cursor-config): `cursor-agent logout` clears its
//   sign-in. Its folder (CURSOR_CONFIG_DIR, `$XDG_CONFIG_HOME/cursor` or `~/.cursor`) is the
//   editor's; only `cli-config.json` and its `.bad` copies, `chats`, `acp-sessions`,
//   `statsig-cache.json` and `grok-switch.json` are the CLI's alone.
// - Stakpak v0.3.88: `~/.stakpak` but `plugins`, which its `tab` installs into too; `stakpak
//   autopilot down --uninstall` removes the service it installed.
// - VT Code 0.184.0 (vtcode_paths/mod.rs, docs/guides/user-data-directories.md): XDG `vtcode`
//   folders on Linux, `com.vinhnx.vtcode` in Application Support and Caches on macOS,
//   `%APPDATA%\vinhnx\vtcode`, VTCODE_CONFIG and VTCODE_DATA, and the older VTCODE_HOME or
//   `~/.vtcode` but its desktop app's `desktop`; its keyring entries stay.
// - siGit 1.7.10 (getsigit/sigit settings.rs): SIGIT_CONFIG_DIR or `$HOME/.config/sigit`, and
//   `$HOME/.cache/sigit`; it reads only HOME, on Windows too, and keeps nothing without it.
// - GLM agent 1.17.1 (stefandevo/glm-acp-agent 9c2e632): `<XDG config>/glm-acp-agent`, and
//   ACP_GLM_SESSION_DIR or `<XDG state>/glm-acp-agent`, under the home folder on every system.
// - fast-agent 0.10.63 (fast_agent/home.py): FAST_AGENT_HOME, else `~/.fast-agent`.
// - OMP v19.0.1 (packages/utils/src/dirs.ts): `~/.omp` but `wt` (worktrees) and a GUI's `gui`.
//   PI_CONFIG_DIR renames it and PI_CODING_AGENT_DIR, which is Pi's own variable too, moves its
//   agent folder, so with either Kite cannot tell.
// - Poolside CLI (docs.poolside.ai/cli/install, Uninstall): its files in `~/.config/poolside`,
//   beside the Assistant extension's `assistant.json`, and the state folders the guide lists.
// - Minion Code 0.1.45: its files in `~/.minion` beside minionx's, `~/.minion-code` and
//   `~/minion-code-acp-debug.log`; MINION_ROOT is minionx's.
// - Harn v0.10.202 (crates/harn-vm-core/src/user_dirs.rs): its cache and sandbox folders;
//   `~/.harn` holds the signals inbox its hooks share, and its config the hosts' settings.
// - amp-acp v0.13.0: its own config and state folders. Amp's own folders are its desktop apps'.
// - Agoragentic 1.3.6 and DeepAgents' ACP adapter 0.1.44 keep nothing of their own.
//
// Shared with another program, so kept and named: Gemini CLI's `~/.gemini` (Antigravity, Gemini
// Code Assist), Qwen Code's `~/.qwen` (its desktop app, VS Code companion), Grok's `~/.grok` (the
// community grok-cli, which keeps a wallet key there), Droid's `~/.factory` (Factory App),
// Auggie's `~/.augment` (Augment's extensions), Qoder's and Qoder CN's folders (their IDEs),
// MiniMax Code's `~/.minimax` (its desktop app), Kimi Code's `~/.kimi-code` (its desktop app and
// extension), goose's folders (goose Desktop), Copilot's `~/.copilot` (VS Code, the Copilot app),
// Junie's `~/.junie` (its IDE plugin), Cortex Code's `~/.snowflake/cortex` (CoCo Desktop),
// crow-cli's `~/.agents/crow` (crow's own client), Mistral Vibe's `~/.vibe` (its VS Code
// extension and desktop app), Autohand's `~/.autohand` (Autohand Squad), Dirac's `~/.dirac` (its
// extensions, COMDIRAC), Bob's `~/.bob` (the Bob IDE), Kimchi's `~/.config/kimchi` (kimchictl,
// its extension) and Corust's `~/.corust-agent` (the corust CLI).

import path from 'node:path'
import type { DataNote, RemovalKept, RemovalSharer } from '@shared/agent-removal'
import type { Platform } from '@shared/platform'
import type { HarnessId } from '@shared/thread'
import { resetPlan, type ResetContext, type ResetPlan } from '../agent-reset/plan'
import { secretName } from '../agent-reset/secrets'
import { dataFolder } from '../doubao/program'
import { needsShell } from '../find-command'
import { formatCommand } from '../quote'
import { cmdSafe } from './commands'
import { within } from './guard'
import type { PlannedStep, RemovalFiles } from './steps'

/** The agent's own CLI as its vendor's commands run: the program, and a package's entry before them. */
export interface AgentCli {
  program: string
  args: string[]
}

export interface DataFacts extends ResetContext {
  harness: HarnessId
  /** The folder Kite gives the agent was picked by the user, rather than made by Kite. */
  picked: boolean
  /** Other agents on the same harness, which share what every copy of it keeps in one place. */
  others: readonly string[]
  /** The agent's CLI, which runs its vendor's own uninstall; absent when none was found. */
  cli?: AgentCli | null
}

export interface DataPlan {
  known: boolean
  steps: PlannedStep[]
  kept: RemovalKept[]
  notes: DataNote[]
  /** The files and folders the steps may remove. */
  roots: string[]
}

// What Codex keeps on Windows for the sandbox accounts it made, which outlive its folder.
const CODEX_SANDBOX = [
  '.sandbox',
  '.sandbox-bin',
  '.sandbox-secrets',
  '.sandbox_migration',
  'cap_sid',
]

function pathsOf(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

function value(ctx: ResetContext, name: string): string | null {
  const found = ctx.getEnv(name)
  return found && found.trim() !== '' ? found : null
}

const folder = (target: string, prune?: string[]): PlannedStep => ({
  part: 'data',
  kind: 'folder',
  path: target,
  ...(prune ? { prune } : {}),
})

const contents = (target: string, except: string[], prune?: string[]): PlannedStep => ({
  part: 'data',
  kind: 'contents',
  path: target,
  except,
  ...(prune ? { prune } : {}),
})

const file = (target: string): PlannedStep => ({ part: 'data', kind: 'file', path: target })

/** The reset's entries of the system's credential store, which hold the agent's sign-in. */
function secrets(plan: ResetPlan): PlannedStep[] {
  return plan.entries.flatMap((entry) =>
    entry.kind === 'secret'
      ? [
          {
            part: 'data' as const,
            kind: 'secret' as const,
            path: secretName(entry.secret),
            secret: entry.secret,
          },
        ]
      : [],
  )
}

/** The folders of a list without one that lies inside another. */
function outermost(folders: readonly string[], platform: Platform): string[] {
  const p = pathsOf(platform)
  const key = (target: string): string =>
    platform === 'win32' ? p.resolve(target).toLowerCase() : p.resolve(target)
  const inside = (parent: string, child: string): boolean => {
    const rel = p.relative(key(parent), key(child))
    return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel))
  }
  const unique = folders.filter(
    (target, index) => folders.findIndex((other) => key(other) === key(target)) === index,
  )
  return unique.filter(
    (target) => !unique.some((other) => key(other) !== key(target) && inside(other, target)),
  )
}

/** What `kept` names that is there now. */
async function present(kept: RemovalKept[], files: RemovalFiles): Promise<RemovalKept[]> {
  const found = await Promise.all(
    kept.map(async (item) => (item.store || (await files.kind(item.path)) ? item : null)),
  )
  return found.filter((item) => item !== null)
}

function done(plan: Omit<DataPlan, 'roots'>): DataPlan {
  // A command's path is its line, and a secret's its name: neither is a path a step may reach.
  const roots = plan.steps.flatMap((step) =>
    step.kind === 'secret' || step.kind === 'command' ? [] : [step.path],
  )
  return { ...plan, roots }
}

const unknown = (): DataPlan => ({ known: false, steps: [], kept: [], notes: [], roots: [] })

const shared = (target: string, sharer: RemovalSharer): RemovalKept => ({
  path: target,
  reason: 'shared',
  with: sharer,
})

/**
 * A command of the agent's vendor, run with the agent's own CLI and shown by the CLI's name; null
 * without the CLI, or when cmd.exe, which runs a `.cmd` program, would rewrite one of its words.
 */
function vendorCommand(
  facts: DataFacts,
  name: string,
  args: string[],
  measure?: string,
): PlannedStep | null {
  const { cli, platform } = facts
  if (!cli) return null
  const words = [...cli.args, ...args]
  if (needsShell(cli.program, platform) && !words.every(cmdSafe)) return null
  return {
    part: 'data',
    kind: 'command',
    path: formatCommand({ command: name, args }, platform),
    run: { program: cli.program, args: words },
    ...(measure ? { measure } : {}),
  }
}

/** The other agents' data, by the sources the header lists; null for an agent not among them. */
async function vendorData(facts: DataFacts, files: RemovalFiles): Promise<DataPlan | null> {
  const { home, platform } = facts
  const p = pathsOf(platform)
  /** A variable's path: `~` is the home folder, and a relative one is taken from it. */
  const env = (name: string): string | null => {
    const found = value(facts, name)
    if (!found) return null
    const expanded = found === '~' || /^~[\\/]/.test(found) ? p.join(home, found.slice(1)) : found
    return p.resolve(home, expanded)
  }
  const base = (name: string, ...fallback: string[]): string =>
    env(name) ?? p.join(home, ...fallback)
  const config = base('XDG_CONFIG_HOME', '.config')
  const data = base('XDG_DATA_HOME', '.local', 'share')
  const state = base('XDG_STATE_HOME', '.local', 'state')
  const cache = base('XDG_CACHE_HOME', '.cache')
  const roaming = (): string => env('APPDATA') ?? p.join(home, 'AppData', 'Roaming')
  const local = (): string => env('LOCALAPPDATA') ?? p.join(home, 'AppData', 'Local')
  const own = async (
    steps: PlannedStep[],
    kept: RemovalKept[] = [],
    notes: DataNote[] = [],
  ): Promise<DataPlan> => done({ known: true, steps, kept: await present(kept, files), notes })
  const left = (folders: string[], sharer: RemovalSharer): Promise<DataPlan> =>
    own(
      [],
      folders.map((target) => shared(target, sharer)),
    )
  const there = async (target: string): Promise<boolean> => (await files.kind(target)) !== null
  const pruned =
    (root: string) =>
    (step: PlannedStep): PlannedStep => ({ ...step, prune: [root] })

  switch (facts.harness) {
    case 'muse': {
      const steps = [folder(p.join(config, 'muse')), folder(p.join(data, 'muse'))]
      const auth = env('MUSE_AUTH_PATH')
      if (auth && !steps.some((step) => within(step.path, auth, platform))) steps.push(file(auth))
      return own(steps, [], platform === 'darwin' ? ['keychain-left'] : [])
    }
    case 'codewhale': {
      const set = value(facts, 'CODEWHALE_HOME')
      const usable = set !== null && (set === '~' || /^~[\\/]/.test(set) || p.isAbsolute(set))
      const target = (usable ? env('CODEWHALE_HOME') : null) ?? p.join(home, '.codewhale')
      const receipt = facts.cli
        ? p.join(p.dirname(facts.cli.program), '.codewhale-install.sha256')
        : null
      const uninstall =
        receipt && (await files.kind(receipt)) === 'file'
          ? vendorCommand(facts, 'codewhale', ['uninstall', '--yes', '--purge-data'], target)
          : null
      if (uninstall) return own([uninstall], [], ['codewhale-uninstall'])
      const steps = [folder(target)]
      if (!set) steps.push(folder(p.join(home, '.deepseek', 'snapshots')))
      return own(steps)
    }
    case 'devin': {
      const uninstall = vendorCommand(facts, 'devin', ['uninstall', '--clean', '--force'])
      if (uninstall) return own([uninstall], [], ['devin-uninstall'])
      return left(
        platform === 'win32'
          ? [p.join(roaming(), 'devin'), p.join(local(), 'devin')]
          : [p.join(config, 'devin'), p.join(data, 'devin')],
        'devin-desktop',
      )
    }
    case 'hermes': {
      const folderPath =
        env('HERMES_HOME') ??
        (platform === 'win32' ? p.join(local(), 'hermes') : p.join(home, '.hermes'))
      const relayer =
        (await there(p.join(folderPath, 'keys'))) ||
        (await there(p.join(folderPath, 'config.toml')))
      if (relayer) return left([folderPath], 'hermes-relayer')
      const uninstall = vendorCommand(facts, 'hermes', ['uninstall', '--data', '--yes'], folderPath)
      if (uninstall) return own([uninstall], [], ['hermes-uninstall'])
      return left([folderPath], 'hermes-desktop')
    }
    case 'kilo': {
      const uninstall = vendorCommand(facts, 'kilo', ['uninstall', '--force'])
      if (uninstall) return own([uninstall], [], ['kilo-uninstall'])
      return left(
        [config, data, cache, state].map((root) => p.join(root, 'kilo')),
        'kilo-apps',
      )
    }
    case 'nova': {
      const nova = p.join(home, '.nova')
      if ((await files.kind(nova)) !== 'folder') {
        const compass = p.join(home, '.compass')
        if ((await files.kind(compass)) === 'folder') return left([compass], 'compass-sass')
        return own([folder(nova)])
      }
      const uninstall = vendorCommand(facts, 'nova', ['uninstall', '--force'], nova)
      if (uninstall) return own([uninstall], [], ['nova-uninstall'])
      return own([folder(nova)], [], ['keychain-left'])
    }
    case 'cursor': {
      const xdg = env('XDG_CONFIG_HOME')
      const root =
        env('CURSOR_CONFIG_DIR') ?? (xdg ? p.join(xdg, 'cursor') : p.join(home, '.cursor'))
      const at = (name: string): string => p.join(root, name)
      const logout = vendorCommand(facts, 'cursor-agent', ['logout'])
      const steps: PlannedStep[] = [
        ...(logout ? [logout] : []),
        file(at('cli-config.json')),
        folder(at('chats')),
        folder(at('acp-sessions')),
        file(at('statsig-cache.json')),
        file(at('grok-switch.json')),
      ]
      for (const name of (await files.list(root)).sort()) {
        if (/^cli-config\.json\.bad/i.test(name)) steps.push(file(at(name)))
      }
      return own(steps, [], logout ? ['cursor-editor'] : ['cursor-editor', 'keychain-left'])
    }
    case 'stakpak': {
      const root = p.join(home, '.stakpak')
      const service =
        platform === 'darwin'
          ? p.join(home, 'Library', 'LaunchAgents', 'dev.stakpak.autopilot.plist')
          : platform === 'win32'
            ? null
            : p.join(config, 'systemd', 'user', 'stakpak-autopilot.service')
      const down =
        service && (await there(service))
          ? vendorCommand(facts, 'stakpak', ['autopilot', 'down', '--uninstall'])
          : null
      return own(
        [...(down ? [down] : []), contents(root, ['plugins'])],
        [shared(p.join(root, 'plugins'), 'stakpak-tab')],
      )
    }
    case 'vtcode': {
      const vinhnx = p.join(roaming(), 'vinhnx')
      const folders =
        platform === 'win32'
          ? [p.join(vinhnx, 'vtcode')]
          : platform === 'darwin'
            ? ['Application Support', 'Caches'].map((name) =>
                p.join(home, 'Library', name, 'com.vinhnx.vtcode'),
              )
            : [config, data, state, cache].map((root) => p.join(root, 'vtcode'))
      const moved = ['VTCODE_CONFIG', 'VTCODE_DATA'].flatMap((name) => env(name) ?? [])
      const legacy = env('VTCODE_HOME') ?? p.join(home, '.vtcode')
      const steps = outermost([...folders, ...moved], platform).map((target) =>
        platform === 'win32' && target === folders[0] ? folder(target, [vinhnx]) : folder(target),
      )
      return own(
        [...steps, contents(legacy, ['desktop'])],
        [shared(p.join(legacy, 'desktop'), 'vtcode-desktop')],
        ['keychain-left'],
      )
    }
    case 'sigit': {
      const root = platform === 'win32' ? env('HOME') : home
      const settings = env('SIGIT_CONFIG_DIR') ?? (root ? p.join(root, '.config', 'sigit') : null)
      const caches = root ? p.join(root, '.cache', 'sigit') : null
      return own([settings, caches].flatMap((target) => (target ? [folder(target)] : [])))
    }
    case 'glm': {
      const sessions = env('ACP_GLM_SESSION_DIR') ?? p.join(state, 'glm-acp-agent')
      return own(
        outermost([p.join(config, 'glm-acp-agent'), sessions], platform).map((target) =>
          folder(target),
        ),
      )
    }
    case 'fast-agent':
      return own([folder(base('FAST_AGENT_HOME', '.fast-agent'))], [], ['keychain-left'])
    case 'omp': {
      if (value(facts, 'PI_CODING_AGENT_DIR') || value(facts, 'PI_CONFIG_DIR')) return unknown()
      const root = p.join(home, '.omp')
      return own(
        [contents(root, ['wt', 'gui'])],
        [{ path: p.join(root, 'wt'), reason: 'work' }, shared(p.join(root, 'gui'), 'omp-gui')],
      )
    }
    case 'poolside': {
      const roots = outermost(
        [p.join(home, '.config', 'poolside'), p.join(config, 'poolside')],
        platform,
      )
      const settings = roots.flatMap((root) =>
        ['settings.yaml', 'credentials.json', 'pool.json'].map((name) =>
          pruned(root)(file(p.join(root, name))),
        ),
      )
      const saved =
        platform === 'darwin'
          ? [p.join(home, 'Library', 'Application Support', 'poolside')]
          : platform === 'win32'
            ? [p.join(local(), 'poolside')]
            : [
                p.join(home, '.local', 'state', 'poolside'),
                p.join(home, '.local', 'share', 'poolside'),
              ]
      return own(
        [...settings, ...saved.map((target) => folder(target))],
        roots.map((root) => shared(p.join(root, 'assistant.json'), 'poolside-assistant')),
        ['keychain-left'],
      )
    }
    case 'minion': {
      const root = p.join(home, '.minion')
      const at = (name: string): string => p.join(root, name)
      const steps = [
        file(at('minion-code.json')),
        file(at('credentials.json')),
        folder(at('sessions')),
      ]
      if (!value(facts, 'MINION_ROOT')) steps.push(folder(at('runtime')))
      return own(
        [
          ...steps.map(pruned(root)),
          folder(p.join(home, '.minion-code')),
          file(p.join(home, 'minion-code-acp-debug.log')),
        ],
        ['config.yaml', 'skills', 'decay-cache'].map((name) => shared(at(name), 'minionx')),
      )
    }
    case 'harn': {
      const caches =
        env('HARN_CACHE_DIR') ??
        (platform === 'darwin' ? p.join(home, 'Library', 'Caches', 'harn') : p.join(cache, 'harn'))
      const sandbox =
        platform === 'darwin'
          ? p.join(home, 'Library', 'Caches', '.harn-sandbox')
          : platform === 'win32'
            ? p.join(local(), '.harn-sandbox')
            : p.join(cache, '.harn-sandbox')
      const settings = platform === 'win32' ? p.join(roaming(), 'Harn') : p.join(config, 'harn')
      return own(
        [folder(caches), folder(sandbox)],
        [shared(p.join(home, '.harn'), 'harn'), shared(settings, 'harn')],
        ['keychain-left'],
      )
    }
    case 'amp': {
      const adapter =
        platform === 'win32' ? p.join(roaming(), 'amp-acp') : p.join(config, 'amp-acp')
      const sessions = env('AMP_ACP_STATE_DIR') ?? p.join(state, 'amp-acp')
      // Amp itself ignores the XDG variables on macOS and Windows.
      const amp =
        platform === 'win32' || platform === 'darwin'
          ? [p.join(home, '.config', 'amp'), p.join(home, '.local', 'share', 'amp')]
          : [p.join(config, 'amp'), p.join(data, 'amp')]
      return own(
        outermost([adapter, sessions], platform).map((target) => folder(target)),
        amp.map((target) => shared(target, 'amp')),
      )
    }
    case 'goose': {
      const set = value(facts, 'GOOSE_PATH_ROOT')
      const root = set && p.isAbsolute(set) ? set : null
      return left(
        root
          ? ['config', 'data', 'state'].map((name) => p.join(root, name))
          : platform === 'win32'
            ? [p.join(roaming(), 'Block', 'goose')]
            : [config, data, state].map((folderPath) => p.join(folderPath, 'goose')),
        'goose-desktop',
      )
    }
    case 'gemini':
      return left([p.join(env('GEMINI_CLI_HOME') ?? home, '.gemini')], 'gemini')
    case 'qwen':
      return left([base('QWEN_HOME', '.qwen')], 'qwen-apps')
    case 'grok':
      return left([base('GROK_HOME', '.grok')], 'grok-cli')
    case 'droid':
      return left([p.join(home, '.factory')], 'factory-app')
    case 'auggie':
      return left([base('AUGMENT_CACHE_DIR', '.augment')], 'augment')
    case 'qoder':
      return left([base('QODER_CONFIG_DIR', '.qoder')], 'qoder-ide')
    case 'qoder-cn':
      return left([base('QODERCN_CONFIG_DIR', '.qoder-cn')], 'qoder-cn-ide')
    case 'minimax':
      return left(
        [env('MINIMAX_DATA_DIR') ?? base('MAVIS_DATA_DIR', '.minimax')],
        'minimax-desktop',
      )
    case 'kimi':
      return left([base('KIMI_CODE_HOME', '.kimi-code')], 'kimi-apps')
    case 'copilot':
      return left([base('COPILOT_HOME', '.copilot')], 'copilot')
    case 'junie':
      return left([base('JUNIE_HOME', '.junie')], 'junie-ide')
    case 'cortex-code':
      return left([p.join(base('SNOWFLAKE_HOME', '.snowflake'), 'cortex')], 'coco-desktop')
    case 'crow-cli':
      return left([p.join(home, '.agents', 'crow')], 'crow')
    case 'mistral-vibe':
      return left([base('VIBE_HOME', '.vibe')], 'vibe-apps')
    case 'autohand':
      return left([base('AUTOHAND_HOME', '.autohand')], 'autohand-squad')
    case 'dirac':
      return left([base('DIRAC_DIR', '.dirac')], 'dirac')
    case 'bob':
      return left([p.join(home, '.bob')], 'bob-ide')
    case 'kimchi':
      return left([p.join(home, '.config', 'kimchi')], 'kimchi')
    case 'corust-agent': {
      const set = value(facts, 'CORUST_HOME')
      return left([p.join(set && p.isAbsolute(set) ? set : home, '.corust-agent')], 'corust')
    }
    case 'agoragentic':
    case 'deepagents':
      return own([])
    default:
      return null
  }
}

async function claudeData(facts: DataFacts, files: RemovalFiles): Promise<DataPlan> {
  const p = pathsOf(facts.platform)
  const reset = await resetPlan('claude-code', facts)
  const moved = facts.chosen ?? value(facts, 'CLAUDE_CONFIG_DIR')
  const own = reset.folder ?? p.join(facts.home, '.claude')
  const steps: PlannedStep[] = []
  const kept: RemovalKept[] = []
  // Every Claude Code keeps its device keys in ~/.claude, whatever folder it was given.
  const deviceKeys = p.join(facts.home, '.claude', '.device-keys.json')
  if (!moved && facts.others.length > 0) {
    steps.push(contents(own, ['.device-keys.json']))
    kept.push({ path: deviceKeys, reason: 'agents' })
  } else {
    steps.push(folder(own))
  }
  if (!moved) {
    // `.claude.json` sits in the home folder unless the folder was moved, with older backups.
    steps.push(file(p.join(facts.home, '.claude.json')))
    for (const name of (await files.list(facts.home)).sort()) {
      if (/^\.claude\.json\.backup(\.\d+)?$/.test(name)) steps.push(file(p.join(facts.home, name)))
    }
  }
  // The sign-in's file in the folder CLAUDE_SECURESTORAGE_CONFIG_DIR names instead.
  for (const entry of reset.entries) {
    if (entry.kind === 'path' && entry.category === 'credentials') {
      const rel = p.relative(own, entry.path)
      if (rel.startsWith('..') || p.isAbsolute(rel)) steps.push(file(entry.path))
    }
  }
  steps.push(...secrets(reset))
  const notes: DataNote[] = moved ? [] : ['claude-apps']
  if (facts.picked) notes.push('picked-folder')
  return done({ known: true, steps, kept: await present(kept, files), notes })
}

async function codexData(facts: DataFacts, files: RemovalFiles): Promise<DataPlan> {
  const p = pathsOf(facts.platform)
  const reset = await resetPlan('codex', facts)
  const own = reset.folder ?? p.join(facts.home, '.codex')
  const moved = facts.chosen ?? value(facts, 'CODEX_HOME')
  const sandbox = facts.platform === 'win32' ? CODEX_SANDBOX : []
  const kept: RemovalKept[] = [
    // The standalone installer's program; uninstalling it removes it.
    { path: p.join(own, 'packages'), reason: 'program' },
    ...sandbox.map((name): RemovalKept => ({ path: p.join(own, name), reason: 'sandbox' })),
  ]
  const notes: DataNote[] = moved ? [] : ['codex-app']
  if (facts.picked) notes.push('picked-folder')
  return done({
    known: true,
    steps: [contents(own, ['packages', ...sandbox]), ...secrets(reset)],
    kept: await present(kept, files),
    notes,
  })
}

async function antigravityData(facts: DataFacts, files: RemovalFiles): Promise<DataPlan> {
  const p = pathsOf(facts.platform)
  const base = p.join(facts.home, '.gemini')
  const reset = await resetPlan('antigravity', facts)
  // The keyring entry, the older token and the app's own folder are the Antigravity app's too.
  const kept: RemovalKept[] = [
    { path: p.join(base, 'antigravity'), reason: 'app' },
    { path: p.join(base, 'jetski-standalone-oauth-token'), reason: 'app' },
    ...reset.entries.flatMap((entry): RemovalKept[] =>
      entry.kind === 'secret'
        ? [{ path: secretName(entry.secret), reason: 'app', store: entry.secret.store }]
        : [],
    ),
  ]
  return done({
    known: true,
    steps: [folder(p.join(base, 'antigravity-cli'))],
    kept: await present(kept, files),
    notes: ['antigravity-app'],
  })
}

/** Where the agent keeps its data, and what of it may go. */
export async function planData(facts: DataFacts, files: RemovalFiles): Promise<DataPlan> {
  const p = pathsOf(facts.platform)
  const { home } = facts
  const picked: DataNote[] = facts.picked ? ['picked-folder'] : []
  const resolve = (target: string): string => p.resolve(home, target)
  switch (facts.harness) {
    case 'claude-code':
      return claudeData(facts, files)
    case 'codex':
      return codexData(facts, files)
    case 'antigravity':
      return antigravityData(facts, files)
    case 'deepseek': {
      const moved = facts.chosen ?? value(facts, 'DSH_HOME')
      const kept: RemovalKept[] = [{ path: p.join(home, '.agents'), reason: 'agents' }]
      return done({
        known: true,
        steps: [folder(moved ? resolve(moved) : p.join(home, '.dsh'))],
        kept: await present(kept, files),
        notes: picked,
      })
    }
    case 'codebuddy': {
      const moved = facts.chosen ?? value(facts, 'CODEBUDDY_CONFIG_DIR')
      return done({
        known: true,
        steps: [folder(moved ? resolve(moved) : p.join(home, '.codebuddy'))],
        kept: [],
        notes: ['codebuddy-sign-in', ...picked],
      })
    }
    case 'doubao': {
      const env = Object.fromEntries(
        ['LOCALAPPDATA', 'XDG_DATA_HOME', 'HOME'].map((name) => [name, facts.getEnv(name)]),
      )
      const own = dataFolder(env, facts.platform, home)
      const kept: RemovalKept[] = [{ path: p.join(own, 'app'), reason: 'program' }]
      return done({
        known: true,
        steps: [contents(own, ['app'], [own])],
        kept: await present(kept, files),
        notes: [],
      })
    }
    case 'pi': {
      const reset = await resetPlan('pi', facts)
      const own = reset.folder ?? p.join(home, '.pi', 'agent')
      const parent = p.join(home, '.pi')
      return done({
        known: true,
        steps: [folder(own, p.dirname(own) === parent ? [parent] : undefined)],
        kept: [],
        notes: [],
      })
    }
    case 'cline': {
      const reset = await resetPlan('cline', facts)
      return done({
        known: true,
        steps: outermost(reset.roots, facts.platform).map((target) => folder(target)),
        kept: [],
        notes: [],
      })
    }
    case 'dimcode': {
      const moved = value(facts, 'DIMCODE_HOME')
      return done({
        known: true,
        steps: [folder(moved ? resolve(moved) : p.join(home, '.dimcode'))],
        kept: [],
        notes: [],
      })
    }
    case 'opencode': {
      const xdg = (name: string, fallback: string[]): string =>
        p.join(resolve(value(facts, name) ?? p.join(home, ...fallback)), 'opencode')
      return done({
        known: true,
        steps: outermost(
          [
            xdg('XDG_DATA_HOME', ['.local', 'share']),
            xdg('XDG_CONFIG_HOME', ['.config']),
            xdg('XDG_CACHE_HOME', ['.cache']),
            xdg('XDG_STATE_HOME', ['.local', 'state']),
          ],
          facts.platform,
        ).map((target) => folder(target)),
        kept: [],
        notes: [],
      })
    }
    default: {
      const vendor = await vendorData(facts, files)
      if (vendor) return vendor
      if (facts.chosen) {
        return done({
          known: true,
          steps: [folder(resolve(facts.chosen))],
          kept: [],
          notes: picked,
        })
      }
      return unknown()
    }
  }
}
