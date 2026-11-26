// What Settings › Agents shows on an agent's page beyond its status: where the agent reads its
// configuration, and which CLI version its adapter runs.

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConfigItem, AgentDetails } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import type { AgentId, HarnessId } from '@shared/thread'
import { dataFolder } from './doubao/program'
import type { LogFn } from './storage'

/** The variables Doubao CLI finds its data folder by. */
const DATA_VARIABLES = ['LOCALAPPDATA', 'XDG_DATA_HOME', 'HOME']

/** One configuration entry; `candidates` are the paths the agent tries, first choice first. */
export interface ConfigLocation {
  id: AgentConfigItem['id']
  candidates: string[]
  env: string | null
  /** The folder picked in Settings, which wins over the variable. */
  chosen?: boolean
  /** The path shown when none exists, when that is not the first candidate. */
  fallback?: string
}

/**
 * Where each agent reads its configuration, by the same rules the agent itself follows. `chosen`
 * is the folder picked in Settings for Claude Code or Codex, which the agent gets in its variable.
 */
export function configLocations(
  agentId: HarnessId,
  getEnv: (name: string) => string | undefined,
  home: string,
  platform: Platform,
  chosen: string | null = null,
): ConfigLocation[] {
  const p = platform === 'win32' ? path.win32 : path.posix
  // A relative value is taken from the home directory, where agents are spawned.
  const variable = (name: string): string | null => {
    const value = getEnv(name)
    return value && value.trim() !== '' ? p.resolve(home, value) : null
  }
  const layout = (
    folder: string,
    env: string | null,
    settings: ConfigLocation,
    instructions: string,
  ): ConfigLocation[] => [
    chosen !== null && folder === chosen
      ? { id: 'folder', candidates: [folder], env: null, chosen: true }
      : { id: 'folder', candidates: [folder], env },
    settings,
    { id: 'instructions', candidates: [p.join(folder, instructions)], env: null },
  ]

  switch (agentId) {
    case 'claude-code': {
      const moved = chosen ?? variable('CLAUDE_CONFIG_DIR')
      const folder = moved ?? p.join(home, '.claude')
      return layout(
        folder,
        moved ? 'CLAUDE_CONFIG_DIR' : null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'CLAUDE.md',
      )
    }
    case 'codex': {
      const moved = chosen ?? variable('CODEX_HOME')
      const folder = moved ?? p.join(home, '.codex')
      return layout(
        folder,
        moved ? 'CODEX_HOME' : null,
        { id: 'settings', candidates: [p.join(folder, 'config.toml')], env: null },
        'AGENTS.md',
      )
    }
    case 'deepseek': {
      const moved = chosen ?? variable('DSH_HOME')
      const folder = moved ?? p.join(home, '.dsh')
      // dsh reads AGENTS.md from the shared agents folder, not from its home.
      const agents = variable('DSH_AGENTS_HOME') ?? p.join(home, '.agents')
      return [
        chosen !== null && folder === chosen
          ? { id: 'folder', candidates: [folder], env: null, chosen: true }
          : { id: 'folder', candidates: [folder], env: moved ? 'DSH_HOME' : null },
        {
          id: 'settings',
          candidates: [p.join(folder, 'profiles', 'sdk', 'cordis.patch.yml')],
          env: null,
        },
        { id: 'instructions', candidates: [p.join(agents, 'AGENTS.md')], env: null },
      ]
    }
    case 'opencode': {
      const xdg = variable('XDG_CONFIG_HOME')
      const folder = p.join(xdg ?? p.join(home, '.config'), 'opencode')
      const file = variable('OPENCODE_CONFIG')
      const settings: ConfigLocation = file
        ? { id: 'settings', candidates: [file], env: 'OPENCODE_CONFIG' }
        : {
            id: 'settings',
            candidates: [p.join(folder, 'opencode.json'), p.join(folder, 'opencode.jsonc')],
            env: null,
          }
      return layout(folder, xdg ? 'XDG_CONFIG_HOME' : null, settings, 'AGENTS.md')
    }
    case 'pi': {
      const moved = variable('PI_CODING_AGENT_DIR')
      const folder = moved ?? p.join(home, '.pi', 'agent')
      return [
        ...layout(
          folder,
          moved ? 'PI_CODING_AGENT_DIR' : null,
          { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
          'AGENTS.md',
        ).map((location) =>
          // Pi reads the first of these that exists, and AGENTS.md when none does.
          location.id === 'instructions'
            ? {
                ...location,
                candidates: ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'].map((name) =>
                  p.join(folder, name),
                ),
                fallback: p.join(folder, 'AGENTS.md'),
              }
            : location,
        ),
      ]
    }
    case 'auggie': {
      // The CLI keeps user settings and prompt additions in its own folder.
      const folder = p.join(home, '.augment')
      return layout(
        folder,
        null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'APPEND_SYSTEM.md',
      )
    }
    case 'codebuddy': {
      const moved = chosen ?? variable('CODEBUDDY_CONFIG_DIR')
      const folder = moved ?? p.join(home, '.codebuddy')
      return layout(
        folder,
        moved ? 'CODEBUDDY_CONFIG_DIR' : null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'CODEBUDDY.md',
      )
    }
    case 'deepagents':
      // The adapter names neither a folder of its own nor a user instructions file.
      return []
    case 'dimcode': {
      // V2 keeps its data in its own folder; its docs name no instructions file.
      const moved = variable('DIMCODE_HOME')
      return [
        {
          id: 'folder',
          candidates: [moved ?? p.join(home, '.dimcode', 'v2')],
          env: moved ? 'DIMCODE_HOME' : null,
        },
      ]
    }
    case 'dirac': {
      const moved = variable('DIRAC_DIR')
      return [
        {
          id: 'folder',
          candidates: [moved ?? p.join(home, '.dirac', 'data')],
          env: moved ? 'DIRAC_DIR' : null,
        },
      ]
    }
    case 'glm': {
      const xdg = variable('XDG_CONFIG_HOME')
      const folder = p.join(xdg ?? p.join(home, '.config'), 'glm-acp-agent')
      return [
        { id: 'folder', candidates: [folder], env: xdg ? 'XDG_CONFIG_HOME' : null },
        // `glm-acp-agent --setup` writes its key here, with Z_AI_API_KEY overriding it.
        { id: 'settings', candidates: [p.join(folder, 'credentials.json')], env: null },
      ]
    }
    case 'nova': {
      // New installs use ~/.nova; older ones keep their ~/.compass folder.
      const folder = p.join(home, '.nova')
      const legacy = p.join(home, '.compass')
      return [
        { id: 'folder', candidates: [folder, legacy], env: null },
        {
          id: 'settings',
          candidates: [p.join(folder, 'config.json'), p.join(legacy, 'config.json')],
          env: null,
        },
        {
          id: 'instructions',
          candidates: [
            p.join(folder, 'AGENTS.md'),
            p.join(folder, 'NOVA.md'),
            p.join(legacy, 'AGENTS.md'),
            p.join(legacy, 'NOVA.md'),
          ],
          env: null,
          fallback: p.join(folder, 'AGENTS.md'),
        },
      ]
    }
    case 'qoder': {
      const moved = variable('QODER_CONFIG_DIR')
      const folder = moved ?? p.join(home, '.qoder')
      return layout(
        folder,
        moved ? 'QODER_CONFIG_DIR' : null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'AGENTS.md',
      )
    }
    case 'qoder-cn': {
      const moved = variable('QODERCN_CONFIG_DIR')
      const folder = moved ?? p.join(home, '.qoder-cn')
      return layout(
        folder,
        moved ? 'QODERCN_CONFIG_DIR' : null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'AGENTS.md',
      )
    }
    case 'sigit': {
      const moved = variable('SIGIT_CONFIG_DIR')
      const folder = moved ?? p.join(home, '.config', 'sigit')
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'SIGIT_CONFIG_DIR' : null },
        { id: 'settings', candidates: [p.join(folder, 'settings.toml')], env: null },
      ]
    }
    case 'agoragentic':
      // It names no folder and no instructions file; its key comes from the environment.
      return []
    case 'autohand': {
      const moved = variable('AUTOHAND_HOME')
      const folder = moved ?? p.join(home, '.autohand')
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'AUTOHAND_HOME' : null },
        {
          id: 'settings',
          candidates: ['config.toml', 'config.yaml', 'config.yml', 'config.json'].map((name) =>
            p.join(folder, name),
          ),
          env: null,
        },
      ]
    }
    case 'bob':
    case 'harn':
    case 'kimchi':
      // Their docs name no configuration folder.
      return []
    case 'minimax': {
      const moved = variable('MINIMAX_DATA_DIR')
      const folder = moved ?? p.join(home, '.minimax')
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'MINIMAX_DATA_DIR' : null },
        { id: 'settings', candidates: [p.join(folder, 'config.yaml')], env: null },
      ]
    }
    case 'cursor': {
      const moved = variable('CURSOR_CONFIG_DIR')
      // Cursor's docs give XDG_CONFIG_HOME a folder of its own only on Linux and BSD, but the CLI
      // (cursor-config's paths.js in 2026.11.19's packages for each system) takes it everywhere.
      const xdg = variable('XDG_CONFIG_HOME')
      const folder = moved ?? (xdg ? p.join(xdg, 'cursor') : p.join(home, '.cursor'))
      // The CLI documents only project rules and AGENTS.md, so no global instructions file shows.
      return [
        {
          id: 'folder',
          candidates: [folder],
          env: moved ? 'CURSOR_CONFIG_DIR' : xdg ? 'XDG_CONFIG_HOME' : null,
        },
        { id: 'settings', candidates: [p.join(folder, 'cli-config.json')], env: null },
      ]
    }
    case 'kimi': {
      const moved = variable('KIMI_CODE_HOME')
      const folder = moved ?? p.join(home, '.kimi-code')
      // Kimi Code stores its account, config and history in this directory.
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'KIMI_CODE_HOME' : null },
        { id: 'settings', candidates: [p.join(folder, 'config.toml')], env: null },
      ]
    }
    case 'amp': {
      const xdg = variable('XDG_CONFIG_HOME')
      const folder = p.join(xdg ?? p.join(home, '.config'), 'amp')
      const file = variable('AMP_SETTINGS_FILE')
      return [
        { id: 'folder', candidates: [folder], env: xdg ? 'XDG_CONFIG_HOME' : null },
        file
          ? { id: 'settings', candidates: [file], env: 'AMP_SETTINGS_FILE' }
          : {
              id: 'settings',
              candidates: [p.join(folder, 'settings.json'), p.join(folder, 'settings.jsonc')],
              env: null,
            },
        {
          id: 'instructions',
          candidates: [p.join(folder, 'AGENTS.md'), p.join(p.dirname(folder), 'AGENTS.md')],
          env: null,
          fallback: p.join(folder, 'AGENTS.md'),
        },
      ]
    }
    case 'goose': {
      // goose's paths.rs takes etcetera's app strategy, XDG's on macOS too, which ignores a
      // relative XDG_CONFIG_HOME.
      const rootValue = getEnv('GOOSE_PATH_ROOT')
      const root =
        rootValue && rootValue.trim() !== '' && p.isAbsolute(rootValue) ? rootValue : null
      const xdgValue = platform === 'win32' ? undefined : getEnv('XDG_CONFIG_HOME')
      const xdg = xdgValue && p.isAbsolute(xdgValue) ? xdgValue : null
      const appData = platform === 'win32' ? variable('APPDATA') : null
      let folder: string
      let env: string | null
      if (root) {
        folder = p.join(root, 'config')
        env = 'GOOSE_PATH_ROOT'
      } else if (platform === 'win32') {
        folder = p.join(appData ?? p.join(home, 'AppData', 'Roaming'), 'Block', 'goose', 'config')
        env = appData ? 'APPDATA' : null
      } else {
        // etcetera's app strategy, which goose uses, is XDG on macOS too.
        folder = p.join(xdg ?? p.join(home, '.config'), 'goose')
        env = xdg ? 'XDG_CONFIG_HOME' : null
      }
      return [
        { id: 'folder', candidates: [folder], env },
        { id: 'settings', candidates: [p.join(folder, 'config.yaml')], env: null },
        {
          id: 'instructions',
          candidates: [p.join(folder, 'AGENTS.md'), p.join(folder, '.goosehints')],
          env: null,
          fallback: p.join(folder, 'AGENTS.md'),
        },
      ]
    }
    case 'kilo': {
      const file = variable('KILO_CONFIG')
      const xdg = variable('XDG_CONFIG_HOME')
      const folder = p.join(xdg ?? p.join(home, '.config'), 'kilo')
      const settings: ConfigLocation = file
        ? { id: 'settings', candidates: [file], env: 'KILO_CONFIG' }
        : {
            id: 'settings',
            candidates: [p.join(folder, 'kilo.jsonc'), p.join(folder, 'kilo.json')],
            env: null,
          }
      return [
        { id: 'folder', candidates: [folder], env: xdg ? 'XDG_CONFIG_HOME' : null },
        settings,
        { id: 'instructions', candidates: [p.join(folder, 'AGENTS.md')], env: null },
      ]
    }
    case 'gemini': {
      // GEMINI_CLI_HOME replaces the home directory, so .gemini sits under it.
      const envHome = variable('GEMINI_CLI_HOME')
      const folder = p.join(envHome ?? home, '.gemini')
      return layout(
        folder,
        envHome ? 'GEMINI_CLI_HOME' : null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'GEMINI.md',
      )
    }
    case 'copilot': {
      const moved = variable('COPILOT_HOME')
      const folder = moved ?? p.join(home, '.copilot')
      return layout(
        folder,
        moved ? 'COPILOT_HOME' : null,
        { id: 'settings', candidates: [p.join(folder, 'config.json')], env: null },
        'copilot-instructions.md',
      )
    }
    case 'qwen': {
      const folder = p.join(home, '.qwen')
      return layout(
        folder,
        null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'QWEN.md',
      )
    }
    case 'grok': {
      const moved = variable('GROK_HOME')
      const folder = moved ?? p.join(home, '.grok')
      return layout(
        folder,
        moved ? 'GROK_HOME' : null,
        { id: 'settings', candidates: [p.join(folder, 'config.toml')], env: null },
        'AGENTS.md',
      )
    }
    case 'cline': {
      const moved = variable('CLINE_DIR')
      const folder = moved ?? p.join(home, '.cline')
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'CLINE_DIR' : null },
        {
          id: 'settings',
          candidates: [p.join(folder, 'data', 'settings', 'global-settings.json')],
          env: null,
        },
        // Cline reads its global rules from the cross-tool folder, not its own.
        { id: 'instructions', candidates: [p.join(home, '.agents', 'AGENTS.md')], env: null },
      ]
    }
    case 'droid': {
      const folder = p.join(home, '.factory')
      return layout(
        folder,
        null,
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        'AGENTS.md',
      )
    }
    case 'omp': {
      // OMP's packages/utils/src/dirs.ts: its root is `~/<PI_CONFIG_DIR or .omp>`, its agent
      // folder `agent` in it, a profile's in `profiles/<name>` (OMP_PROFILE, else PI_PROFILE),
      // else PI_CODING_AGENT_DIR; settings.ts reads config.yml, then config.yaml, from there.
      const name = getEnv('PI_CONFIG_DIR') || '.omp'
      const root = p.join(home, name)
      const profileVariable = getEnv('OMP_PROFILE') !== undefined ? 'OMP_PROFILE' : 'PI_PROFILE'
      const profileName = getEnv(profileVariable)?.trim()
      const profile = profileName && profileName !== 'default' ? profileName : null
      const moved = profile ? null : variable('PI_CODING_AGENT_DIR')
      const folder = profile
        ? p.join(root, 'profiles', profile, 'agent')
        : (moved ?? p.join(root, 'agent'))
      const env = profile
        ? profileVariable
        : moved
          ? 'PI_CODING_AGENT_DIR'
          : name !== '.omp'
            ? 'PI_CONFIG_DIR'
            : null
      return [
        { id: 'folder', candidates: [folder], env },
        {
          id: 'settings',
          candidates: [p.join(folder, 'config.yml'), p.join(folder, 'config.yaml')],
          env: null,
        },
        { id: 'instructions', candidates: [p.join(folder, 'AGENTS.md')], env: null },
      ]
    }
    case 'kiro': {
      // Kiro CLI's settings reference: KIRO_HOME, an absolute path other than the home folder or
      // above it, else `~/.kiro`, whose `settings/cli.json` holds its settings.
      const value = getEnv('KIRO_HOME')
      const rel = value && p.isAbsolute(value) ? p.relative(value, home) : null
      const moved = rel !== null && (rel.startsWith('..') || p.isAbsolute(rel)) ? value! : null
      const folder = moved ?? p.join(home, '.kiro')
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'KIRO_HOME' : null },
        { id: 'settings', candidates: [p.join(folder, 'settings', 'cli.json')], env: null },
      ]
    }
    case 'fx': {
      // fx's docs: its profile, settings and MCP servers in `~/.fx`.
      const folder = p.join(home, '.fx')
      return [
        { id: 'folder', candidates: [folder], env: null },
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
      ]
    }
    case 'hermes': {
      // hermes_constants.py: HERMES_HOME, else `%LOCALAPPDATA%\hermes` on Windows, `~/.hermes`.
      const moved = variable('HERMES_HOME')
      const localAppData = platform === 'win32' ? variable('LOCALAPPDATA') : null
      const folder =
        moved ??
        (platform === 'win32'
          ? p.join(localAppData ?? p.join(home, 'AppData', 'Local'), 'hermes')
          : p.join(home, '.hermes'))
      return [
        {
          id: 'folder',
          candidates: [folder],
          env: moved ? 'HERMES_HOME' : localAppData ? 'LOCALAPPDATA' : null,
        },
        { id: 'settings', candidates: [p.join(folder, 'config.yaml')], env: null },
      ]
    }
    case 'muse': {
      // Muse Code's own config root on every system: `$XDG_CONFIG_HOME/muse`, else
      // `~/.config/muse` (its docs, its binaries' messages and its launchers).
      const xdg = variable('XDG_CONFIG_HOME')
      const folder = p.join(xdg ?? p.join(home, '.config'), 'muse')
      return [
        { id: 'folder', candidates: [folder], env: xdg ? 'XDG_CONFIG_HOME' : null },
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
      ]
    }
    case 'codewhale': {
      const folder = p.join(home, '.codewhale')
      return [
        { id: 'folder', candidates: [folder], env: null },
        // CodeWhale reads its user settings from settings.toml; an old config.toml is unused.
        { id: 'settings', candidates: [p.join(folder, 'settings.toml')], env: null },
      ]
    }
    case 'antigravity': {
      // agy 1.5.9's data folder, and the instructions it reads for every project. An added agent's
      // process takes `<its folder>/.gemini` with `--gemini-dir`.
      const base = p.join(chosen ?? home, '.gemini')
      return [
        chosen !== null
          ? { id: 'folder', candidates: [chosen], env: null, chosen: true }
          : { id: 'folder', candidates: [p.join(base, 'antigravity-cli')], env: null },
        {
          id: 'instructions',
          candidates: [p.join(base, 'GEMINI.md'), p.join(base, 'AGENTS.md')],
          env: null,
          fallback: p.join(base, 'GEMINI.md'),
        },
      ]
    }
    case 'devin':
      return [
        { id: 'folder', candidates: [p.join(home, '.config', 'devin')], env: null },
        {
          id: 'settings',
          candidates: [p.join(home, '.config', 'devin', 'config.json')],
          env: null,
        },
      ]
    case 'cortex-code': {
      const moved = variable('SNOWFLAKE_HOME')
      const folder = p.join(moved ?? p.join(home, '.snowflake'), 'cortex')
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'SNOWFLAKE_HOME' : null },
        { id: 'settings', candidates: [p.join(folder, 'settings.json')], env: null },
        { id: 'instructions', candidates: [p.join(folder, 'AGENTS.md')], env: null },
      ]
    }
    case 'corust-agent':
      return []
    case 'crow-cli': {
      const folder = p.join(home, '.agents', 'crow')
      return [
        { id: 'folder', candidates: [folder], env: null },
        { id: 'settings', candidates: [p.join(folder, 'config.yaml')], env: null },
        {
          id: 'instructions',
          candidates: [p.join(folder, 'prompts', 'system_prompt.jinja2')],
          env: null,
        },
      ]
    }
    case 'junie': {
      const moved = variable('JUNIE_HOME')
      const folder = moved ?? p.join(home, '.junie')
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'JUNIE_HOME' : null },
        { id: 'settings', candidates: [p.join(folder, 'config.json')], env: null },
        { id: 'instructions', candidates: [p.join(folder, 'AGENTS.md')], env: null },
      ]
    }
    case 'mistral-vibe': {
      const folder = p.join(home, '.vibe')
      return [
        { id: 'folder', candidates: [folder], env: null },
        { id: 'settings', candidates: [p.join(folder, 'config.toml')], env: null },
        { id: 'instructions', candidates: [p.join(folder, 'AGENTS.md')], env: null },
      ]
    }
    case 'poolside': {
      const xdg = variable('XDG_CONFIG_HOME')
      const folder = p.join(xdg ?? p.join(home, '.config'), 'poolside')
      return [
        { id: 'folder', candidates: [folder], env: xdg ? 'XDG_CONFIG_HOME' : null },
        { id: 'settings', candidates: [p.join(folder, 'settings.yaml')], env: null },
        { id: 'instructions', candidates: [p.join(folder, 'AGENTS.md')], env: null },
      ]
    }
    case 'stakpak': {
      const folder = p.join(home, '.stakpak')
      return [
        { id: 'folder', candidates: [folder], env: null },
        { id: 'settings', candidates: [p.join(folder, 'config.toml')], env: null },
      ]
    }
    case 'vtcode': {
      const moved = variable('VTCODE_CONFIG')
      const appData = variable('APPDATA')
      const folder =
        moved ??
        (platform === 'win32'
          ? p.join(appData ?? p.join(home, 'AppData', 'Roaming'), 'vinhnx', 'vtcode', 'config')
          : platform === 'darwin'
            ? p.join(home, 'Library', 'Application Support', 'com.vinhnx.vtcode')
            : p.join(home, '.config', 'vtcode'))
      return [
        { id: 'folder', candidates: [folder], env: moved ? 'VTCODE_CONFIG' : null },
        { id: 'settings', candidates: [p.join(folder, 'vtcode.toml')], env: null },
        {
          id: 'instructions',
          candidates: [p.join(folder, 'AGENTS.override.md'), p.join(folder, 'AGENTS.md')],
          env: null,
          fallback: p.join(folder, 'AGENTS.md'),
        },
      ]
    }
    case 'fast-agent':
      // It reads the project's .fast-agent folder or FAST_AGENT_HOME, not a folder of its own.
      return []
    case 'minion':
      // It keeps its data under MINION_ROOT, else ~/.minion, which Settings does not show.
      return []
    case 'doubao':
      // Its program, sign-in and logs live in its data folder, which no variable moves.
      return [
        {
          id: 'folder',
          candidates: [
            dataFolder(
              Object.fromEntries(DATA_VARIABLES.map((name) => [name, getEnv(name)])),
              platform,
              home,
            ),
          ],
          env: null,
        },
      ]
    case 'fake-agent':
      return []
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function exists(target: string, kind: 'directory' | 'file', log: LogFn): Promise<boolean> {
  try {
    const info = await stat(target)
    return kind === 'directory' ? info.isDirectory() : info.isFile()
  } catch (error) {
    if (!isMissing(error)) log('warn', `Could not check ${target}: ${(error as Error).message}`)
    return false
  }
}

async function resolveItem(location: ConfigLocation, log: LogFn): Promise<AgentConfigItem> {
  const kind = location.id === 'folder' ? 'directory' : 'file'
  const chosen = location.chosen ?? false
  for (const candidate of location.candidates) {
    if (await exists(candidate, kind, log)) {
      return { id: location.id, path: candidate, exists: true, env: location.env, chosen }
    }
  }
  const path = location.fallback ?? location.candidates[0] ?? ''
  return { id: location.id, path, exists: false, env: location.env, chosen }
}

/** The package whose `package.json` names the CLI an agent's package runs, and the field for it. */
export const CLI_VERSION_SOURCES: Partial<Record<AgentId, { package: string; field: string }>> = {
  'claude-code': { package: '@anthropic-ai/claude-agent-sdk', field: 'claudeCodeVersion' },
  codex: { package: '@openai/codex', field: 'version' },
}

/** The CLI version an installed adapter carries, from the install in `installRoot`. */
export async function readCliVersion(
  agentId: AgentId,
  installRoot: string,
  log: LogFn,
): Promise<string | null> {
  const source = CLI_VERSION_SOURCES[agentId]
  if (!source) return null
  const file = path.join(installRoot, 'node_modules', source.package, 'package.json')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    // Not installed yet is normal.
    if (!isMissing(error)) log('warn', `Could not read ${file}: ${(error as Error).message}`)
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const value =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)[source.field]
        : undefined
    if (typeof value === 'string' && value !== '') return value
    log('warn', `${file} has no "${source.field}" string`)
  } catch (error) {
    log('warn', `Could not parse ${file}: ${(error as Error).message}`)
  }
  return null
}

type LogEntry = Parameters<LogFn>

/** Runs `read` with a log that holds its entries, so concurrent reads can be logged in a fixed order. */
async function withLogs<T>(read: (log: LogFn) => Promise<T>): Promise<[T, LogEntry[]]> {
  const entries: LogEntry[] = []
  const result = await read((...entry) => {
    entries.push(entry)
  })
  return [result, entries]
}

export interface AgentDetailsContext {
  getEnv(name: string): string | undefined
  home: string
  platform: Platform
  /** The folder picked in Settings for an agent whose folder can be moved; null otherwise. */
  chosen?: string | null
  /** The directory of the adapter install a package agent runs; null for the others. */
  adapterDir: string | null
  log: LogFn
}

/** Never rejects: a place or version that cannot be read comes back as missing or null. */
export async function readAgentDetails(
  agentId: HarnessId,
  ctx: AgentDetailsContext,
): Promise<AgentDetails> {
  const locations = configLocations(agentId, ctx.getEnv, ctx.home, ctx.platform, ctx.chosen)
  const installRoot = ctx.adapterDir
  const [items, version] = await Promise.all([
    Promise.all(locations.map((location) => withLogs((log) => resolveItem(location, log)))),
    withLogs(async (log) =>
      installRoot === null ? null : readCliVersion(agentId, installRoot, log),
    ),
  ])
  // The reads finish in any order; replay their logs in the order the page lists them.
  for (const [, entries] of [...items, version]) for (const entry of entries) ctx.log(...entry)
  return { cliVersion: version[0], config: items.map(([item]) => item) }
}

/** Where the agent keeps MCP servers of its own, and what moved the file, if anything. */
export interface McpLocation {
  path: string
  env: string | null
  chosen: boolean
  exists: boolean
}

/**
 * The file in which the agent keeps MCP servers for every project. Claude Code keeps them in
 * `.claude.json`, Codex in `config.toml` of its folder, and OpenCode in its settings file. Only the
 * file's existence is checked; it is never read.
 */
export async function mcpLocation(
  agentId: AgentId,
  getEnv: (name: string) => string | undefined,
  home: string,
  platform: Platform,
  chosen: string | null = null,
  log: LogFn,
): Promise<McpLocation | null> {
  const p = platform === 'win32' ? path.win32 : path.posix
  // A relative value is taken from the home directory, where agents are spawned.
  const variable = (name: string): string | null => {
    const value = getEnv(name)
    return value && value.trim() !== '' ? p.resolve(home, value) : null
  }
  switch (agentId) {
    case 'claude-code': {
      const env = variable('CLAUDE_CONFIG_DIR')
      const dir = chosen ?? env ?? home
      return {
        path: p.join(dir, '.claude.json'),
        env: chosen ? null : env ? 'CLAUDE_CONFIG_DIR' : null,
        chosen: chosen !== null,
        exists: await exists(p.join(dir, '.claude.json'), 'file', log),
      }
    }
    case 'codex': {
      const env = variable('CODEX_HOME')
      const dir = chosen ?? env ?? p.join(home, '.codex')
      return {
        path: p.join(dir, 'config.toml'),
        env: chosen ? null : env ? 'CODEX_HOME' : null,
        chosen: chosen !== null,
        exists: await exists(p.join(dir, 'config.toml'), 'file', log),
      }
    }
    case 'opencode': {
      const file = variable('OPENCODE_CONFIG')
      if (file) {
        return {
          path: file,
          env: 'OPENCODE_CONFIG',
          chosen: false,
          exists: await exists(file, 'file', log),
        }
      }
      const xdg = variable('XDG_CONFIG_HOME')
      const dir = p.join(xdg ?? p.join(home, '.config'), 'opencode')
      const candidates = [p.join(dir, 'opencode.json'), p.join(dir, 'opencode.jsonc')]
      const found = await firstExisting(candidates, log)
      return {
        path: found ?? candidates[0]!,
        env: xdg ? 'XDG_CONFIG_HOME' : null,
        chosen: false,
        exists: found !== null,
      }
    }
    default:
      return null
  }
}

async function firstExisting(candidates: string[], log: LogFn): Promise<string | null> {
  for (const candidate of candidates) if (await exists(candidate, 'file', log)) return candidate
  return null
}
