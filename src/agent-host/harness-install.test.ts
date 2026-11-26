// Huli: a harness's install and update checks as the harness pages see them: a first install that
// fails leaves the harness installable, its failure a task to retry, and the user's check reads a
// program updated outside Kite again; an uninstall answers once Kite's install is moved aside.
// Installs are fakes that write to a temp folder.

import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { InstallOptions, InstalledAdapter } from './adapter-install'
import { AgentManager, type AgentManagerDeps } from './agents'
import { PI } from './agents/pi'
import type { AgentDefinition } from './catalog'
import { Diagnostics } from './diagnostics'
import { deletesSettled, TRASH_PREFIX, type DiscardDeps } from './discard'
import { parseBundled } from './harness-versions'
import { CliVersions } from './installed-cli'
import { parseRegistry } from './registry'
import { TextRing } from './ring'
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
    workflow: DEFAULT_SETTINGS.workflow,
    lightModel: { mode: 'small' },
    defaultAgent: null,
    computerUse: DEFAULT_SETTINGS.computerUse,
    agentNetwork: DEFAULT_SETTINGS.agentNetwork,
    downloadService: false,
    claudeTestEntrypoint: null,
    claudeRuns: {},
    promptSuggestions: true,
    continueAfterLimit: true,
    agentPasswords: false,
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

describe("a first install of a vendor's own package", () => {
  it('takes the newest version in its range, so no update is on offer once it is done', async () => {
    const root = await tempFolder('kite-fresh-install-')
    // Outside the Registry, as DeepSeek Harness: Kite bundles a version and npm has newer ones.
    const vendor: AgentDefinition = {
      ...GEMINI,
      launch: {
        ...GEMINI.launch,
        fromVendor: true,
        updates: '~1.0.0',
      } as AgentDefinition['launch'],
    }
    const installed: string[] = []
    const { agents, status } = await manager(root, vendor, hostSettings({}), {
      bundled: parseBundled({ registry: { agents: [] }, kettu: { gemini: { version: '1.0.0' } } }),
      // No check ran before, as on a computer's first start.
      fetchLatest: async () => ({ adapterVersion: '1.0.5', cliVersion: null }),
      install: async (options: InstallOptions) => {
        installed.push(options.version)
        return writeInstall(root, options.version)
      },
    })
    await agents.detectAll()
    expect(status()).toMatchObject({ state: 'available', package: { installed: false } })

    await agents.install('gemini')
    expect(installed).toEqual(['1.0.5'])
    expect(status()).toMatchObject({
      state: 'available',
      task: null,
      update: null,
      package: { installed: true, version: '1.0.5' },
    })
  })
})

describe("the user's update check", () => {
  it('reads again the version of a program updated outside Kite', async () => {
    const root = await tempFolder('kite-outside-update-')
    const program = path.join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi')
    await writeFile(program, '')
    await chmod(program, 0o755)
    let version = '0.90.0'
    // The program's file keeps its size and time across versions, as an npm launcher does.
    const cliVersions = new CliVersions({
      platform: process.platform === 'win32' ? 'win32' : process.platform,
      stat: async () => ({ size: 10, mtimeMs: 1 }),
      run: async () => ({
        code: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        output: new TextRing(1024),
        stdout: `${version}\n`,
      }),
    })
    const { agents, status } = await manager(
      root,
      PI,
      hostSettings({ pi: { enabled: true, binaryPath: program } }),
      {
        cliVersions,
        fetchLatest: async () => ({ adapterVersion: '0.91.0', cliVersion: null }),
      },
    )
    const cliVersion = () => status().version

    await agents.checkUpdates()
    expect(cliVersion()).toBe('0.90.0')

    version = '0.91.0'
    await agents.checkUpdates()
    expect(cliVersion()).toBe('0.91.0')
  })
})

describe('an update check that fails in part', () => {
  it('rejects, so it never reads as all up to date', async () => {
    const root = await tempFolder('kite-partial-check-')
    const program = path.join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi')
    await writeFile(program, '')
    await chmod(program, 0o755)
    const { agents } = await manager(
      root,
      PI,
      hostSettings({ pi: { enabled: true, binaryPath: program } }),
      {
        probeCli: async () => ({ version: '0.90.0' }),
        fetchLatest: async () => ({ adapterVersion: '0.90.0', cliVersion: null }),
        fetchRegistry: async () => {
          throw new Error('The ACP Registry could not be reached.')
        },
      },
    )
    await expect(agents.checkUpdates()).rejects.toThrow(
      /1 of 2 update checks failed\. The ACP Registry could not be reached\./,
    )
  })
})

describe('uninstalling a harness', () => {
  const BUNDLED = parseBundled({
    registry: {
      agents: [{ id: 'gemini', version: '1.0.0', distribution: { npx: { package: PACKAGE } } }],
    },
  })

  /**
   * A disk whose deletes wait for `release`, as Windows deleting a package's tens of thousands of
   * files under a virus scan does, and whose renames are counted and can be held or refused.
   */
  function slowDisk() {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const renames: string[] = []
    const disk = {
      renames,
      release,
      /** Set to fail each rename as Windows does while a process holds a file inside. */
      held: false,
      /** Set to keep the next rename waiting until it resolves. */
      gate: null as Promise<void> | null,
      deps: {
        rename: async (from: string, to: string) => {
          renames.push(from)
          if (disk.gate) await disk.gate
          if (disk.held) {
            throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
          }
          await rename(from, to)
        },
        remove: async (dir: string) => {
          await released
          await rm(dir, { recursive: true, force: true })
        },
        wait: async () => {},
      } satisfies DiscardDeps,
    }
    return disk
  }

  async function installed(disk: ReturnType<typeof slowDisk>) {
    const root = await tempFolder('kite-uninstall-')
    await writeInstall(root, '1.0.0')
    const made = await manager(root, GEMINI, hostSettings({}), {
      bundled: BUNDLED,
      discard: disk.deps,
    })
    await made.agents.detectAll()
    expect(made.status().package).toMatchObject({ installed: true })
    const names = async () => (await readdir(root)).filter((name) => name !== 'reports').sort()
    return { root, names, ...made }
  }

  it('answers once the install is moved aside, and deletes its files after', async () => {
    const disk = slowDisk()
    const { agents, names, status } = await installed(disk)

    await expect(agents.uninstall('gemini')).resolves.toEqual({ command: null, error: null })
    // Its files are still to delete, under a name no install or start reads.
    const left = await names()
    expect(left).toHaveLength(1)
    expect(left[0]!.startsWith(TRASH_PREFIX)).toBe(true)
    expect(status().package).toMatchObject({ installed: false })

    disk.release()
    await deletesSettled()
    expect(await names()).toEqual([])
  })

  it("gives a second request while the first runs the first one's answer", async () => {
    const disk = slowDisk()
    const { agents, names } = await installed(disk)

    const [first, second] = await Promise.all([
      agents.uninstall('gemini'),
      agents.uninstall('gemini'),
    ])
    expect(second).toEqual(first)
    expect(disk.renames).toHaveLength(1)

    disk.release()
    await deletesSettled()
    expect(await names()).toEqual([])
  })

  it('refuses an install or update while the uninstall runs', async () => {
    const disk = slowDisk()
    const { agents } = await installed(disk)
    let open!: () => void
    disk.gate = new Promise<void>((resolve) => (open = resolve))

    const run = agents.uninstall('gemini')
    await expect.poll(() => disk.renames.length).toBe(1)
    await expect(agents.install('gemini')).rejects.toMatchObject({ code: 'busy' })
    await expect(agents.update('gemini')).rejects.toMatchObject({ code: 'busy' })
    await expect(agents.reinstall('gemini')).rejects.toMatchObject({ code: 'busy' })

    open()
    await run
    disk.release()
    await deletesSettled()
  })

  it('says what holds a file in use and keeps the install, then uninstalls once it is let go', async () => {
    const disk = slowDisk()
    const { root, agents, names } = await installed(disk)
    disk.held = true

    const error = await agents.uninstall('gemini').catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'busy' })
    expect((error as Error).message).toContain(path.join(root, 'gemini'))
    // Tried again once the harness's processes were stopped.
    expect(disk.renames.length).toBeGreaterThan(1)
    expect(await names()).toEqual(['gemini'])

    disk.held = false
    await expect(agents.uninstall('gemini')).resolves.toEqual({ command: null, error: null })
    disk.release()
    await deletesSettled()
    expect(await names()).toEqual([])
  })

  it('deletes at the next start what a quit left moved aside, and no install', async () => {
    const disk = slowDisk()
    disk.release()
    const { root, agents, names } = await installed(disk)
    await mkdir(path.join(root, `${TRASH_PREFIX}left`, '1.0.0', 'node_modules'), {
      recursive: true,
    })

    await agents.sweepTrash()
    expect(await names()).toEqual(['gemini'])
  })
})
