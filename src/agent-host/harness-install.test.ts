// Huli: a harness's install as the harness pages see it: a first install that fails leaves the
// harness installable, its failure a task to retry. Installs are fakes that write to a temp folder.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { InstallOptions, InstalledAdapter } from './adapter-install'
import { AgentManager, type AgentManagerDeps } from './agents'
import type { AgentDefinition } from './catalog'
import { Diagnostics } from './diagnostics'
import { parseBundled } from './harness-versions'
import { parseRegistry } from './registry'
import { EnvironmentService } from './shell-env'
import { tempFolder } from './testing/temp'

const PACKAGE = '@google/gemini-cli'

/** A package harness Kite installs into its own folder on first use. */
const GEMINI: AgentDefinition = {
  id: 'gemini',
  name: 'Gemini CLI',
  registryId: 'gemini',
  launch: { kind: 'package', package: PACKAGE, args: ['--acp'] },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}

/** A complete npm install of the package, as Kettu records one, written straight to disk. */
async function writeInstall(root: string, version: string): Promise<InstalledAdapter> {
  const dir = path.join(root, 'gemini', version)
  const packageDir = path.join(dir, 'node_modules', PACKAGE)
  await mkdir(packageDir, { recursive: true })
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ bin: 'cli.js' }))
  await writeFile(path.join(packageDir, 'cli.js'), '')
  const installedAt = Date.now()
  const record = { package: PACKAGE, version, node: null, npm: null, installedAt }
  await writeFile(path.join(dir, 'installed.json'), JSON.stringify(record))
  return { version, dir, entry: path.join(packageDir, 'cli.js'), installedAt }
}

function hostSettings(agents: HostSettings['agents']): HostSettings {
  return {
    locale: 'en',
    initialSetupDone: true,
    agents,
    addedAgents: [],
    disabledAgents: [],
    proxy: DEFAULT_SETTINGS.proxy,
    git: DEFAULT_SETTINGS.git,
    mcp: DEFAULT_SETTINGS.mcp,
    marketplace: DEFAULT_SETTINGS.marketplace,
    startModes: DEFAULT_SETTINGS.startModes,
    idleSessions: DEFAULT_SETTINGS.idleSessions,
    usage: { fromComputer: false },
    sessionTitles: true,
    lightModel: { mode: 'small' },
    defaultAgent: null,
    computerUse: DEFAULT_SETTINGS.computerUse,
    agentNetwork: DEFAULT_SETTINGS.agentNetwork,
    downloadService: false,
    claudeTestEntrypoint: null,
    claudeRuns: {},
    promptSuggestions: true,
  }
}

async function manager(
  root: string,
  def: AgentDefinition,
  settings: HostSettings,
  deps: Partial<AgentManagerDeps>,
) {
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const nodeRuntime = { command: process.execPath, env: {} }
  const agents = new AgentManager({
    catalog: [def],
    platform,
    nodeRuntime,
    appVersion: '0.0.0-test',
    env: new EnvironmentService({
      platform,
      nodeRuntime,
      baseEnv: { PATH: '' },
      resolve: async ({ baseEnv }) => ({
        env: baseEnv,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      }),
      probe: async () => ({ nodeVersion: '24.0.0', npmPath: '/kite/npm', nodePath: '/kite/node' }),
    }),
    diagnostics: new Diagnostics(),
    launcher: {
      launch: () => {
        throw new Error('the test starts nothing')
      },
    },
    settings: () => settings,
    reportsDir: path.join(root, 'reports'),
    adaptersDir: root,
    bundled: parseBundled({ registry: { agents: [] } }),
    fetchRegistry: async () => parseRegistry({ agents: [] })!,
    fetchLatest: async () => {
      throw new Error('offline')
    },
    status: () => {},
    processes: () => {},
    authCommands: () => {},
    ...deps,
  })
  return { agents, status: (): AgentStatus => agents.status(def.id) }
}

describe('a first install of a harness that fails', () => {
  it('leaves the harness installable, says why as a failed install, and installs on retry', async () => {
    const root = await tempFolder('kite-first-install-')
    let fail = true
    const { agents, status } = await manager(
      root,
      GEMINI,
      // Only the harness, as one installed from Settings › Harness before any agent uses it.
      hostSettings({}),
      {
        bundled: parseBundled({
          registry: {
            agents: [
              { id: 'gemini', version: '1.0.0', distribution: { npx: { package: PACKAGE } } },
            ],
          },
        }),
        install: async (options: InstallOptions) => {
          options.onOutput?.('npm error code ECONNRESET\n')
          if (fail) throw new Error('npm error network')
          return writeInstall(root, options.version)
        },
      },
    )
    await agents.detectAll()
    expect(status()).toMatchObject({ state: 'available', package: { installed: false } })

    await expect(agents.install('gemini')).rejects.toThrow(/npm error network/)
    expect(status()).toMatchObject({
      state: 'available',
      detail: null,
      package: { installed: false },
      task: { kind: 'install', state: 'failed', error: expect.stringMatching(/network/) },
    })
    expect(status().task?.progress.join('\n')).toMatch(/ECONNRESET/)
    // Detection does not hold it as a failure, as a `failed` state did until a restart.
    await agents.redetect()
    expect(status().state).toBe('available')

    fail = false
    await agents.install('gemini')
    expect(status()).toMatchObject({ state: 'available', task: null, package: { installed: true } })
  })
})
