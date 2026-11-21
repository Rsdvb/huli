// What deleting an agent's data takes, by each agent's own folders and on each system, what stays
// because another program or app shares it, and the guard no path may get past.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RemovalSharer } from '@shared/agent-removal'
import type { Platform } from '@shared/platform'
import type { HarnessId } from '@shared/thread'
import { fakeRemovalFiles, type FakeEntry } from '../testing/fake-removal-files'
import { planData, type AgentCli, type DataFacts } from './data'
import { removalRefusal, within, type RemovalGuard } from './guard'
import { prepareRemoval, runRemoval, type RemovalFacts } from './removal'

const HOMES = { win32: 'C:\\Users\\me', darwin: '/Users/me', linux: '/home/me' } as const

const pathsOf = (platform: Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

function facts(
  platform: keyof typeof HOMES,
  harness: HarnessId,
  over: Partial<DataFacts> & { env?: Record<string, string> } = {},
): DataFacts {
  const { env = {}, ...rest } = over
  return {
    harness,
    platform,
    home: HOMES[platform],
    getEnv: (name) => env[name],
    chosen: null,
    picked: false,
    others: [],
    realpath: async (target) => target,
    ...rest,
  }
}

async function plan(f: DataFacts, entries: Record<string, FakeEntry> = {}) {
  return planData(f, fakeRemovalFiles(f.platform, entries))
}

/** The data part of the dialog's preview, read against a fake disk. */
async function previewData(f: DataFacts, entries: Record<string, FakeEntry>) {
  const removal: RemovalFacts = {
    program: {
      harness: f.harness,
      launch: { kind: 'binary', command: f.harness, args: [] },
      platform: f.platform,
      home: f.home,
      env: {},
      kiteRoot: pathsOf(f.platform).join(f.home, '.huli', 'harnesses'),
      program: null,
      launcher: null,
      tools: { npm: null, brew: null, winget: null, uv: null },
      others: [],
    },
    data: f,
    protect: [f.home],
    otherFolders: [],
  }
  const prepared = await prepareRemoval(removal, {
    files: fakeRemovalFiles(f.platform, entries),
    secrets: { has: async () => false, remove: async () => {} },
    size: async () => 1,
    log: () => {},
  })
  return prepared.preview.data
}

const paths = (planned: Awaited<ReturnType<typeof planData>>) =>
  planned.steps.map((step) =>
    step.kind === 'contents' ? `${step.path} except ${step.except?.join(',')}` : step.path,
  )

describe('planData', () => {
  it('takes Claude Code’s folder, .claude.json and its backups, and its keychain entry', async () => {
    const home = HOMES.darwin
    const planned = await plan(facts('darwin', 'claude-code'), {
      [`${home}/.claude.json`]: { kind: 'file' },
      [`${home}/.claude.json.backup`]: { kind: 'file' },
      [`${home}/.claude.json.backup.1763600000000`]: { kind: 'file' },
      [`${home}/.claude.json.other`]: { kind: 'file' },
    })
    expect(paths(planned)).toEqual([
      `${home}/.claude`,
      `${home}/.claude.json`,
      `${home}/.claude.json.backup`,
      `${home}/.claude.json.backup.1763600000000`,
      'Claude Code-credentials',
      'Claude Code',
    ])
    expect(planned.notes).toEqual(['claude-apps'])
  })

  it('keeps the device keys every Claude Code shares while other Claude agents remain', async () => {
    const home = HOMES.win32
    const planned = await plan(facts('win32', 'claude-code', { others: ['Claude (work)'] }), {
      [`${home}\\.claude\\.device-keys.json`]: { kind: 'file' },
    })
    expect(paths(planned)[0]).toBe(`${home}\\.claude except .device-keys.json`)
    expect(planned.kept).toEqual([
      { path: `${home}\\.claude\\.device-keys.json`, reason: 'agents' },
    ])
    // Windows' Credential Manager entry, with its split parts.
    expect(planned.steps.at(-1)?.secret).toEqual({
      store: 'credential-manager',
      target: 'Claude Code-credentials/claude-code-user',
      parts: true,
    })
  })

  it('takes only the folder of an added agent, with the keychain names its folder hashes to', async () => {
    const folder = '/Users/me/.huli/agents/claude-code-work'
    const planned = await plan(facts('darwin', 'claude-code', { chosen: folder }))
    expect(paths(planned)[0]).toBe(folder)
    expect(paths(planned)).not.toContain('/Users/me/.claude.json')
    expect(paths(planned).slice(1)).toEqual([
      expect.stringMatching(/^Claude Code-credentials-[0-9a-f]{8}$/),
      expect.stringMatching(/^Claude Code-[0-9a-f]{8}$/),
    ])
    expect(planned.notes).toEqual([])
    const picked = await plan(facts('darwin', 'claude-code', { chosen: folder, picked: true }))
    expect(picked.notes).toEqual(['picked-folder'])
  })

  it('keeps Codex’s program and, on Windows, its sandbox accounts’ files', async () => {
    const home = HOMES.win32
    const planned = await plan(facts('win32', 'codex'), {
      [`${home}\\.codex\\packages\\standalone\\current`]: { kind: 'file' },
      [`${home}\\.codex\\.sandbox-secrets\\x`]: { kind: 'file' },
    })
    expect(paths(planned)).toEqual([
      `${home}\\.codex except packages,.sandbox,.sandbox-bin,.sandbox-secrets,.sandbox_migration,cap_sid`,
      expect.stringMatching(/^cli\|[0-9a-f]{16}\.Codex Auth$/),
    ])
    expect(planned.kept).toEqual([
      { path: `${home}\\.codex\\packages`, reason: 'program' },
      { path: `${home}\\.codex\\.sandbox-secrets`, reason: 'sandbox' },
    ])
    expect(planned.notes).toEqual(['codex-app'])
    const moved = await plan(facts('linux', 'codex', { env: { CODEX_HOME: '/data/codex' } }))
    expect(paths(moved)[0]).toBe('/data/codex except packages')
    expect(moved.notes).toEqual([])
  })

  it('takes agy’s own folder and leaves what the Antigravity app shares', async () => {
    const home = HOMES.linux
    const planned = await plan(facts('linux', 'antigravity'), {
      [`${home}/.gemini/antigravity/brain/x`]: { kind: 'file' },
    })
    expect(paths(planned)).toEqual([`${home}/.gemini/antigravity-cli`])
    expect(planned.kept).toEqual([
      { path: `${home}/.gemini/antigravity`, reason: 'app' },
      { path: 'service=gemini, username=antigravity', reason: 'app', store: 'secret-service' },
    ])
    expect(planned.steps.some((step) => step.kind === 'secret')).toBe(false)
  })

  it('takes dsh’s folder but never the agents folder it shares', async () => {
    const home = HOMES.darwin
    const planned = await plan(facts('darwin', 'deepseek'), {
      [`${home}/.agents/AGENTS.md`]: { kind: 'file' },
    })
    expect(paths(planned)).toEqual([`${home}/.dsh`])
    expect(planned.kept).toEqual([{ path: `${home}/.agents`, reason: 'agents' }])
    const moved = await plan(facts('darwin', 'deepseek', { env: { DSH_HOME: 'work/dsh' } }))
    expect(paths(moved)).toEqual([`${home}/work/dsh`])
  })

  it('takes Doubao’s data folder but its program, on each system', async () => {
    const win = await plan(facts('win32', 'doubao', { env: { LOCALAPPDATA: 'D:\\Local' } }), {
      'D:\\Local\\doubao_cli\\app\\current\\doubao.exe': { kind: 'file' },
    })
    expect(paths(win)).toEqual(['D:\\Local\\doubao_cli except app'])
    expect(win.kept).toEqual([{ path: 'D:\\Local\\doubao_cli\\app', reason: 'program' }])
    const mac = await plan(facts('darwin', 'doubao'))
    expect(paths(mac)).toEqual(['/Users/me/Library/Application Support/doubao_cli except app'])
    const linux = await plan(facts('linux', 'doubao', { env: { XDG_DATA_HOME: '/data' } }))
    expect(paths(linux)).toEqual(['/data/doubao_cli except app'])
  })

  it('takes OpenCode’s XDG folders and Cline’s without a folder twice', async () => {
    const opencode = await plan(facts('linux', 'opencode', { env: { XDG_CACHE_HOME: '/cache' } }))
    expect(paths(opencode)).toEqual([
      '/home/me/.local/share/opencode',
      '/home/me/.config/opencode',
      '/cache/opencode',
      '/home/me/.local/state/opencode',
    ])
    const cline = await plan(facts('linux', 'cline'))
    expect(paths(cline)).toEqual(['/home/me/.cline'])
  })

  it('knows no data of an agent it has no folder for', async () => {
    const planned = await plan(facts('linux', 'fake-agent'))
    expect(planned).toEqual({ known: false, steps: [], kept: [], notes: [], roots: [] })
  })

  it('takes Muse Code’s config and data folders, as moved, and its moved sign-in file', async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const p = pathsOf(platform)
      const home = HOMES[platform]
      const planned = await plan(facts(platform, 'muse'))
      expect(planned.known).toBe(true)
      expect(paths(planned)).toEqual([
        p.join(home, '.config', 'muse'),
        p.join(home, '.local', 'share', 'muse'),
      ])
      // Its sign-in on macOS is in the Keychain, which no folder holds.
      expect(planned.notes).toEqual(platform === 'darwin' ? ['keychain-left'] : [])
    }
    const moved = await plan(
      facts('linux', 'muse', {
        env: { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data', MUSE_AUTH_PATH: '/keys/muse.json' },
      }),
    )
    expect(paths(moved)).toEqual(['/cfg/muse', '/data/muse', '/keys/muse.json'])
  })

  it('knows a folder that is not there yet holds no data, and offers nothing', async () => {
    const preview = await previewData(facts('win32', 'muse'), {})
    expect(preview).toEqual({ known: true, steps: [], kept: [], notes: [] })
    const shared = await previewData(facts('linux', 'gemini'), {})
    expect(shared).toEqual({ known: true, steps: [], kept: [], notes: [] })
  })

  it('takes the folders of agents that keep their own, by their variables', async () => {
    const cases: [keyof typeof HOMES, HarnessId, Record<string, string>, string[]][] = [
      ['linux', 'codewhale', {}, ['/home/me/.codewhale', '/home/me/.deepseek/snapshots']],
      ['darwin', 'codewhale', { CODEWHALE_HOME: '~/cw' }, ['/Users/me/cw']],
      ['linux', 'sigit', {}, ['/home/me/.config/sigit', '/home/me/.cache/sigit']],
      ['linux', 'sigit', { SIGIT_CONFIG_DIR: '/s' }, ['/s', '/home/me/.cache/sigit']],
      // siGit reads only HOME on Windows, and keeps nothing without it.
      ['win32', 'sigit', {}, []],
      ['win32', 'sigit', { HOME: 'D:\\h' }, ['D:\\h\\.config\\sigit', 'D:\\h\\.cache\\sigit']],
      [
        'win32',
        'glm',
        {},
        ['C:\\Users\\me\\.config\\glm-acp-agent', 'C:\\Users\\me\\.local\\state\\glm-acp-agent'],
      ],
      [
        'linux',
        'glm',
        { XDG_CONFIG_HOME: '/c', ACP_GLM_SESSION_DIR: '/sessions' },
        ['/c/glm-acp-agent', '/sessions'],
      ],
      ['linux', 'fast-agent', {}, ['/home/me/.fast-agent']],
      ['linux', 'fast-agent', { FAST_AGENT_HOME: '/fa' }, ['/fa']],
      ['linux', 'nova', {}, ['/home/me/.nova']],
    ]
    for (const [platform, harness, env, expected] of cases) {
      const planned = await plan(facts(platform, harness, { env }))
      expect([harness, env, planned.known, paths(planned)]).toEqual([harness, env, true, expected])
    }
  })

  it('takes VT Code’s folders on each system but its desktop app’s, never ~/.local/bin', async () => {
    const linux = await plan(facts('linux', 'vtcode', { env: { XDG_CACHE_HOME: '/cache' } }), {
      '/home/me/.vtcode/desktop/preferences.json': { kind: 'file' },
    })
    expect(paths(linux)).toEqual([
      '/home/me/.config/vtcode',
      '/home/me/.local/share/vtcode',
      '/home/me/.local/state/vtcode',
      '/cache/vtcode',
      '/home/me/.vtcode except desktop',
    ])
    expect(linux.kept).toEqual([
      { path: '/home/me/.vtcode/desktop', reason: 'shared', with: 'vtcode-desktop' },
    ])
    const mac = await plan(facts('darwin', 'vtcode'))
    expect(paths(mac).slice(0, 2)).toEqual([
      '/Users/me/Library/Application Support/com.vinhnx.vtcode',
      '/Users/me/Library/Caches/com.vinhnx.vtcode',
    ])
    const win = await plan(
      facts('win32', 'vtcode', { env: { APPDATA: 'D:\\Roaming', VTCODE_CONFIG: 'E:\\vt' } }),
    )
    expect(paths(win).slice(0, 2)).toEqual(['D:\\Roaming\\vinhnx\\vtcode', 'E:\\vt'])
    expect(win.steps[0]?.prune).toEqual(['D:\\Roaming\\vinhnx'])
  })

  it('keeps what other programs share inside an agent’s own folder', async () => {
    const stakpak = await plan(facts('linux', 'stakpak'), {
      '/home/me/.stakpak/plugins/warden': { kind: 'file' },
    })
    expect(paths(stakpak)).toEqual(['/home/me/.stakpak except plugins'])
    expect(stakpak.kept).toEqual([
      { path: '/home/me/.stakpak/plugins', reason: 'shared', with: 'stakpak-tab' },
    ])
    const omp = await plan(facts('darwin', 'omp'), {
      '/Users/me/.omp/wt/feature/file.ts': { kind: 'file' },
    })
    expect(paths(omp)).toEqual(['/Users/me/.omp except wt,gui'])
    expect(omp.kept).toEqual([{ path: '/Users/me/.omp/wt', reason: 'work' }])
    // Its agent folder's variable is Pi's too, and its root's names a folder anywhere in home.
    const moved: Record<string, string>[] = [
      { PI_CODING_AGENT_DIR: '/home/me/.pi/agent' },
      { PI_CONFIG_DIR: 'x' },
    ]
    for (const env of moved) {
      expect((await plan(facts('linux', 'omp', { env }))).known).toBe(false)
    }
    const poolside = await plan(facts('linux', 'poolside'), {
      '/home/me/.config/poolside/assistant.json': { kind: 'file' },
    })
    expect(paths(poolside)).toEqual([
      '/home/me/.config/poolside/settings.yaml',
      '/home/me/.config/poolside/credentials.json',
      '/home/me/.config/poolside/pool.json',
      '/home/me/.local/state/poolside',
      '/home/me/.local/share/poolside',
    ])
    expect(poolside.kept).toEqual([
      {
        path: '/home/me/.config/poolside/assistant.json',
        reason: 'shared',
        with: 'poolside-assistant',
      },
    ])
    const minion = await plan(facts('linux', 'minion'), {
      '/home/me/.minion/config.yaml': { kind: 'file' },
    })
    expect(paths(minion)).toEqual([
      '/home/me/.minion/minion-code.json',
      '/home/me/.minion/credentials.json',
      '/home/me/.minion/sessions',
      '/home/me/.minion/runtime',
      '/home/me/.minion-code',
      '/home/me/minion-code-acp-debug.log',
    ])
    expect(minion.kept).toEqual([
      { path: '/home/me/.minion/config.yaml', reason: 'shared', with: 'minionx' },
    ])
    // MINION_ROOT is minionx's own variable, so a folder it names stays.
    const rooted = await plan(facts('linux', 'minion', { env: { MINION_ROOT: '/rt' } }))
    expect(paths(rooted)).not.toContain('/rt')
    expect(paths(rooted)).not.toContain('/home/me/.minion/runtime')
    const amp = await plan(facts('win32', 'amp', { env: { APPDATA: 'D:\\Roaming' } }), {
      'C:\\Users\\me\\.config\\amp\\settings.json': { kind: 'file' },
    })
    expect(paths(amp)).toEqual(['D:\\Roaming\\amp-acp', 'C:\\Users\\me\\.local\\state\\amp-acp'])
    expect(amp.kept).toEqual([
      { path: 'C:\\Users\\me\\.config\\amp', reason: 'shared', with: 'amp' },
    ])
    const harn = await plan(facts('darwin', 'harn'), {
      '/Users/me/.harn/bin/harn': { kind: 'file' },
    })
    expect(paths(harn)).toEqual([
      '/Users/me/Library/Caches/harn',
      '/Users/me/Library/Caches/.harn-sandbox',
    ])
    expect(harn.kept).toEqual([{ path: '/Users/me/.harn', reason: 'shared', with: 'harn' }])
  })

  it('never plans a folder another program shares, and says who shares it', async () => {
    const cases: [keyof typeof HOMES, HarnessId, Record<string, string>, string, RemovalSharer][] =
      [
        ['linux', 'gemini', {}, '/home/me/.gemini', 'gemini'],
        ['linux', 'gemini', { GEMINI_CLI_HOME: '/g' }, '/g/.gemini', 'gemini'],
        ['darwin', 'qwen', { QWEN_HOME: '~/q' }, '/Users/me/q', 'qwen-apps'],
        ['linux', 'grok', {}, '/home/me/.grok', 'grok-cli'],
        ['linux', 'grok', { GROK_HOME: '/x/grok' }, '/x/grok', 'grok-cli'],
        ['win32', 'droid', {}, 'C:\\Users\\me\\.factory', 'factory-app'],
        ['linux', 'auggie', {}, '/home/me/.augment', 'augment'],
        ['linux', 'qoder', { QODER_CONFIG_DIR: '/q' }, '/q', 'qoder-ide'],
        ['linux', 'qoder-cn', {}, '/home/me/.qoder-cn', 'qoder-cn-ide'],
        ['linux', 'minimax', {}, '/home/me/.minimax', 'minimax-desktop'],
        ['linux', 'minimax', { MINIMAX_DATA_DIR: '/m' }, '/m', 'minimax-desktop'],
        ['win32', 'kimi', {}, 'C:\\Users\\me\\.kimi-code', 'kimi-apps'],
        ['linux', 'kimi', { KIMI_CODE_HOME: '/k' }, '/k', 'kimi-apps'],
        ['darwin', 'goose', {}, '/Users/me/.config/goose', 'goose-desktop'],
        [
          'win32',
          'goose',
          { APPDATA: 'D:\\Roaming' },
          'D:\\Roaming\\Block\\goose',
          'goose-desktop',
        ],
        ['linux', 'goose', { GOOSE_PATH_ROOT: '/gr' }, '/gr/config', 'goose-desktop'],
        ['linux', 'copilot', { COPILOT_HOME: '/cp' }, '/cp', 'copilot'],
        ['linux', 'junie', {}, '/home/me/.junie', 'junie-ide'],
        ['linux', 'cortex-code', {}, '/home/me/.snowflake/cortex', 'coco-desktop'],
        ['linux', 'cortex-code', { SNOWFLAKE_HOME: '/sf' }, '/sf/cortex', 'coco-desktop'],
        ['linux', 'crow-cli', {}, '/home/me/.agents/crow', 'crow'],
        ['linux', 'mistral-vibe', { VIBE_HOME: '/v' }, '/v', 'vibe-apps'],
        ['linux', 'autohand', {}, '/home/me/.autohand', 'autohand-squad'],
        ['linux', 'dirac', { DIRAC_DIR: '/d' }, '/d', 'dirac'],
        ['linux', 'bob', {}, '/home/me/.bob', 'bob-ide'],
        ['win32', 'kimchi', {}, 'C:\\Users\\me\\.config\\kimchi', 'kimchi'],
        ['linux', 'corust-agent', {}, '/home/me/.corust-agent', 'corust'],
        ['win32', 'devin', {}, 'C:\\Users\\me\\AppData\\Roaming\\devin', 'devin-desktop'],
        ['linux', 'devin', {}, '/home/me/.config/devin', 'devin-desktop'],
        ['linux', 'kilo', {}, '/home/me/.local/share/kilo', 'kilo-apps'],
        ['linux', 'hermes', {}, '/home/me/.hermes', 'hermes-desktop'],
        ['win32', 'hermes', {}, 'C:\\Users\\me\\AppData\\Local\\hermes', 'hermes-desktop'],
        ['linux', 'nova', {}, '/home/me/.compass', 'compass-sass'],
      ]
    for (const [platform, harness, env, shared, sharer] of cases) {
      const planned = await plan(facts(platform, harness, { env }), {
        [pathsOf(platform).join(shared, 'x')]: { kind: 'file' },
      })
      expect([harness, env, planned.known]).toEqual([harness, env, true])
      expect(planned.kept).toContainEqual({ path: shared, reason: 'shared', with: sharer })
      for (const step of planned.steps) {
        expect([harness, step.path, within(step.path, shared, platform)]).toEqual([
          harness,
          step.path,
          false,
        ])
      }
      expect(planned.roots.filter((root) => within(root, shared, platform))).toEqual([])
    }
  })

  it('knows the agents that keep nothing of their own', async () => {
    for (const harness of ['agoragentic', 'deepagents'] as const) {
      const planned = await plan(facts('linux', harness), {
        '/home/me/.deepagents/config.toml': { kind: 'file' },
      })
      expect(planned).toEqual({ known: true, steps: [], kept: [], notes: [], roots: [] })
    }
  })
})

describe('planData with the vendor’s own commands', () => {
  const linuxCli = (name: string): AgentCli => ({
    program: `/home/me/.local/bin/${name}`,
    args: [],
  })
  const command = (planned: Awaited<ReturnType<typeof planData>>) =>
    planned.steps
      .filter((step) => step.kind === 'command')
      .map((step) => [step.path, step.run?.program, ...(step.run?.args ?? [])])

  it('runs Devin’s, Kilo’s and Hermes’s own uninstall and says what else they take', async () => {
    const devin = await plan(facts('linux', 'devin', { cli: linuxCli('devin') }))
    expect(command(devin)).toEqual([
      [
        'devin uninstall --clean --force',
        '/home/me/.local/bin/devin',
        'uninstall',
        '--clean',
        '--force',
      ],
    ])
    expect(devin.steps).toHaveLength(1)
    expect(devin.notes).toEqual(['devin-uninstall'])
    expect(devin.roots).toEqual([])
    const kilo = await plan(facts('linux', 'kilo', { cli: linuxCli('kilo') }))
    expect(command(kilo)).toEqual([
      ['kilo uninstall --force', '/home/me/.local/bin/kilo', 'uninstall', '--force'],
    ])
    expect(kilo.notes).toEqual(['kilo-uninstall'])
    const hermes = await plan(facts('linux', 'hermes', { cli: linuxCli('hermes') }))
    expect(command(hermes)).toEqual([
      [
        'hermes uninstall --data --yes',
        '/home/me/.local/bin/hermes',
        'uninstall',
        '--data',
        '--yes',
      ],
    ])
    expect(hermes.steps[0]?.measure).toBe('/home/me/.hermes')
    expect(hermes.notes).toEqual(['hermes-uninstall'])
  })

  it('never runs Hermes’s uninstall over a folder the IBC relayer named Hermes keeps', async () => {
    for (const name of ['keys/wallet.json', 'config.toml']) {
      const planned = await plan(facts('linux', 'hermes', { cli: linuxCli('hermes') }), {
        [`/home/me/.hermes/${name}`]: { kind: 'file' },
      })
      expect(planned.steps).toEqual([])
      expect(planned.kept).toEqual([
        { path: '/home/me/.hermes', reason: 'shared', with: 'hermes-relayer' },
      ])
    }
  })

  it('runs Nova’s uninstall from Kite’s install only over ~/.nova, never ~/.compass', async () => {
    const cli: AgentCli = { program: '/usr/bin/node', args: ['/kite/nova/cli.js'] }
    const planned = await plan(facts('linux', 'nova', { cli }), {
      '/home/me/.nova/config.json': { kind: 'file' },
    })
    expect(command(planned)).toEqual([
      ['nova uninstall --force', '/usr/bin/node', '/kite/nova/cli.js', 'uninstall', '--force'],
    ])
    expect(planned.notes).toEqual(['nova-uninstall'])
    // ~/.compass is the active folder only without ~/.nova, and the Compass gem shares it.
    const compass = await plan(facts('linux', 'nova', { cli }), {
      '/home/me/.compass/extensions/x': { kind: 'file' },
    })
    expect(compass.steps).toEqual([])
    // Without its program, its own folder goes and its keychain entries stay.
    const alone = await plan(facts('linux', 'nova'), { '/home/me/.nova/x': { kind: 'file' } })
    expect(paths(alone)).toEqual(['/home/me/.nova'])
    expect(alone.notes).toEqual(['keychain-left'])
  })

  it('runs CodeWhale’s uninstall only for its receipted install, else takes its folder', async () => {
    const cli = linuxCli('codewhale')
    const receipted = await plan(facts('linux', 'codewhale', { cli }), {
      '/home/me/.local/bin/.codewhale-install.sha256': { kind: 'file' },
    })
    expect(command(receipted)).toEqual([
      [
        'codewhale uninstall --yes --purge-data',
        '/home/me/.local/bin/codewhale',
        'uninstall',
        '--yes',
        '--purge-data',
      ],
    ])
    expect(receipted.steps).toHaveLength(1)
    expect(receipted.notes).toEqual(['codewhale-uninstall'])
    const npm = await plan(facts('linux', 'codewhale', { cli }))
    expect(paths(npm)).toEqual(['/home/me/.codewhale', '/home/me/.deepseek/snapshots'])
  })

  it('signs Cursor’s CLI out and takes only its own files from the editor’s folder', async () => {
    const planned = await plan(facts('darwin', 'cursor', { cli: linuxCli('cursor-agent') }), {
      '/Users/me/.cursor/cli-config.json.bad': { kind: 'file' },
      '/Users/me/.cursor/mcp.json': { kind: 'file' },
    })
    expect(paths(planned)).toEqual([
      'cursor-agent logout',
      '/Users/me/.cursor/cli-config.json',
      '/Users/me/.cursor/chats',
      '/Users/me/.cursor/acp-sessions',
      '/Users/me/.cursor/statsig-cache.json',
      '/Users/me/.cursor/grok-switch.json',
      '/Users/me/.cursor/cli-config.json.bad',
    ])
    expect(planned.notes).toEqual(['cursor-editor'])
    expect(planned.roots).not.toContain('/Users/me/.cursor')
    // A moved folder may still be the editor's own ~/.cursor, so the same files only.
    const moved = await plan(facts('linux', 'cursor', { env: { CURSOR_CONFIG_DIR: '/c' } }))
    expect(paths(moved)[0]).toBe('/c/cli-config.json')
    expect(moved.notes).toEqual(['cursor-editor', 'keychain-left'])
  })

  it('stops Stakpak’s background service first when it installed one', async () => {
    const planned = await plan(facts('linux', 'stakpak', { cli: linuxCli('stakpak') }), {
      '/home/me/.config/systemd/user/stakpak-autopilot.service': { kind: 'file' },
    })
    expect(paths(planned)).toEqual([
      'stakpak autopilot down --uninstall',
      '/home/me/.stakpak except plugins',
    ])
  })

  it('runs no vendor command whose words cmd.exe would rewrite', async () => {
    const cli: AgentCli = { program: 'C:\\npm\\kilo.cmd', args: [] }
    const safe = await plan(facts('win32', 'kilo', { cli }))
    expect(command(safe)).toEqual([
      ['kilo uninstall --force', 'C:\\npm\\kilo.cmd', 'uninstall', '--force'],
    ])
    const unsafe = await plan(
      facts('win32', 'nova', { cli: { program: 'C:\\node\\node.cmd', args: ['C:\\%x%\\cli.js'] } }),
      { 'C:\\Users\\me\\.nova\\x': { kind: 'file' } },
    )
    expect(command(unsafe)).toEqual([])
    expect(paths(unsafe)).toEqual(['C:\\Users\\me\\.nova'])
  })
})

describe('prepareRemoval', () => {
  it('runs the vendor’s own data command before anything removes its program', async () => {
    const home = '/home/me'
    const kiteRoot = '/home/me/.huli/harnesses'
    const files = fakeRemovalFiles('linux', {
      [`${kiteRoot}/kilo/1.0.0/kilo`]: { kind: 'file' },
      [`${home}/.local/share/kilo/kilo.db`]: { kind: 'file' },
    })
    const removal: RemovalFacts = {
      program: {
        harness: 'kilo',
        launch: { kind: 'binary', command: 'kilo', args: ['acp'] },
        platform: 'linux',
        home,
        env: {},
        kiteRoot,
        program: `${kiteRoot}/kilo/1.0.0/kilo`,
        launcher: null,
        tools: { npm: null, brew: null, winget: null, uv: null },
        others: [],
      },
      data: facts('linux', 'kilo', { cli: { program: `${kiteRoot}/kilo/1.0.0/kilo`, args: [] } }),
      protect: [home, kiteRoot],
      otherFolders: [],
    }
    const prepared = await prepareRemoval(removal, {
      files,
      secrets: { has: async () => false, remove: async () => {} },
      size: async () => 1,
      log: () => {},
    })
    expect(prepared.steps.map(({ step }) => `${step.part} ${step.kind} ${step.path}`)).toEqual([
      'data command kilo uninstall --force',
      `program folder ${kiteRoot}/kilo`,
    ])
    // It runs the agent's own program with the vendor's words, and its output is reported.
    const ran: string[][] = []
    const command = prepared.preview.data.steps[0]!
    const result = await runRemoval(prepared, [command.id], {
      files,
      secrets: { has: async () => false, remove: async () => {} },
      trash: null,
      run: async (program, args) => {
        ran.push([program, ...args])
        return { error: null, output: 'Removed ~/.local/share/kilo\n' }
      },
      progress: () => {},
      log: () => {},
    })
    expect(ran).toEqual([[`${kiteRoot}/kilo/1.0.0/kilo`, 'uninstall', '--force']])
    expect(result.done).toEqual([{ ...command, output: 'Removed ~/.local/share/kilo' }])
  })
})

describe('removalRefusal', () => {
  const guard = (platform: Platform, over: Partial<RemovalGuard> = {}): RemovalGuard => ({
    platform,
    roots: platform === 'win32' ? ['C:\\Users\\me\\.claude'] : ['/home/me/.claude'],
    protect:
      platform === 'win32' ? ['C:\\Users\\me', 'C:\\Users\\me\\.huli\\harnesses'] : ['/home/me'],
    others: [],
    ...over,
  })

  it('lets what is inside the agent’s folders go, the folder itself included', () => {
    expect(removalRefusal('/home/me/.claude', guard('linux'))).toBeNull()
    expect(removalRefusal('/home/me/.claude/projects/x.jsonl', guard('linux'))).toBeNull()
    expect(removalRefusal('C:\\USERS\\ME\\.Claude\\x', guard('win32'))).toBeNull()
  })

  it('refuses what lies outside, a root, the home folder and what holds what must stay', () => {
    const linux = guard('linux')
    expect(removalRefusal('/home/me/.claude-other', linux)).toMatch(/outside/)
    expect(removalRefusal('/home/me/.claude/../.ssh', linux)).toMatch(/outside/)
    expect(removalRefusal('relative/.claude', linux)).toMatch(/absolute/)
    expect(removalRefusal('/home/me/.claude/a\nb', linux)).toMatch(/plain/)
    // A variable pointed at the home folder or a drive makes such a root; it still never goes.
    for (const root of ['/home/me', '/home', '/']) {
      expect(removalRefusal(root, guard('linux', { roots: [root] }))).not.toBeNull()
    }
    for (const root of ['C:\\', 'C:\\Users', 'C:\\Users\\me', 'C:\\Users\\me\\.huli']) {
      expect(removalRefusal(root, guard('win32', { roots: [root] }))).not.toBeNull()
    }
  })

  it('refuses another agent’s folder and anything that holds it', () => {
    const others = ['/home/me/.claude/agents-of-mine']
    expect(removalRefusal('/home/me/.claude', guard('linux', { others }))).toMatch(/another/)
    expect(removalRefusal('/home/me/.claude/agents-of-mine', guard('linux', { others }))).toMatch(
      /another/,
    )
    expect(removalRefusal('/home/me/.claude/cache', guard('linux', { others }))).toBeNull()
  })
})
