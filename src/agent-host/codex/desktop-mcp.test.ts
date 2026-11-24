// Huli: which MCP servers are the Codex desktop app's, and the thread configuration that starts
// them turned off.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activeVersion,
  declaredServers,
  desktopCommand,
  desktopConfig,
  desktopServers,
  readPluginServers,
} from './desktop-mcp'

const STORE =
  'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.9664.0_x64__2p2nqsd0c76g0\\app\\resources\\cua_node\\bin'
const APP_VARS = [
  'BROWSER_USE_ACCESS_EXECUTOR_ID',
  'BROWSER_USE_ACCESS_PIPE_PATH',
  'CODEX_WINDOWS_REGISTERED_CORE',
]

describe('the rule for the Codex desktop app’s servers', () => {
  it('takes a command inside the app’s install folder, on Windows and on macOS', () => {
    expect(desktopCommand({ command: `${STORE}\\node_repl.exe`, args: [] })).toBe(
      `${STORE}\\node_repl.exe`,
    )
    expect(desktopCommand({ command: STORE.toLowerCase() + '\\node.exe' })).not.toBeNull()
    expect(
      desktopCommand({ command: '/Applications/Codex.app/Contents/Resources/cua_node/bin/node' }),
    ).not.toBeNull()
    expect(
      desktopCommand({ command: '/Users/me/Applications/Codex.app/Contents/MacOS/node_repl' }),
    ).not.toBeNull()
  })

  it('takes a server that needs what only the app sets, as names or as entries', () => {
    expect(desktopCommand({ command: 'node', env_vars: ['HOME', APP_VARS[0]] })).toBe('node')
    expect(desktopCommand({ command: 'node', env_vars: [{ name: APP_VARS[2] }] })).toBe('node')
  })

  it('leaves out every other server, and one already off', () => {
    for (const declaration of [
      { command: 'npx', args: ['-y', '@playwright/mcp'] },
      { command: 'C:\\Program Files\\WindowsApps\\Other.App_1.0\\x.exe' },
      { command: 'C:\\Users\\me\\OpenAI.Codex_backup\\node.exe' },
      { command: '/Applications/MyCodex.app/Contents/Resources/node' },
      { command: 'cmd.exe', env_vars: ['CODEX_APP_TOOLS_PIPE_PATH', 'BROWSER_USE_ACCESS'] },
      { url: 'https://example.com/mcp', env_vars: APP_VARS },
      { command: `${STORE}\\node_repl.exe`, enabled: false },
      { command: '', env_vars: APP_VARS },
      null,
      'node',
    ]) {
      expect(desktopCommand(declaration)).toBeNull()
    }
  })
})

describe('the app’s servers a thread would start', () => {
  const nodeRepl = { command: `${STORE}\\node_repl.exe`, env_vars: APP_VARS, enabled: true }
  const cuaRepl = { command: `${STORE}\\node.exe`, args: ['cua-repl.mjs'], env_vars: APP_VARS }

  it('reads the configuration’s own and those of each enabled plugin', async () => {
    const asked: string[] = []
    const servers = await desktopServers(
      {
        mcp_servers: { node_repl: nodeRepl, files: { command: 'files-mcp' } },
        plugins: {
          'unified-computer-use@openai-bundled': { enabled: true },
          'codex-app-tools@openai-bundled': { enabled: true },
          'old@openai-bundled': { enabled: false },
          'turned@openai-bundled': { enabled: true, mcp_servers: { turned: { enabled: false } } },
        },
      },
      async (id) => {
        asked.push(id)
        if (id === 'unified-computer-use@openai-bundled') return { cua_repl: cuaRepl }
        if (id === 'turned@openai-bundled') return { turned: cuaRepl }
        if (id === 'codex-app-tools@openai-bundled') {
          return { codex_app: { command: 'cmd.exe', env_vars: ['CODEX_APP_TOOLS_PIPE_PATH'] } }
        }
        throw new Error('not installed')
      },
    )
    expect(servers).toEqual([
      { name: 'cua_repl', plugin: 'unified-computer-use@openai-bundled', command: cuaRepl.command },
      { name: 'node_repl', plugin: null, command: nodeRepl.command },
    ])
    expect(asked).not.toContain('old@openai-bundled')
  })

  it('leaves a plugin’s server out where the configuration has one of that name', async () => {
    const servers = await desktopServers(
      { mcp_servers: { cua_repl: { command: 'mine' } }, plugins: { 'p@m': { enabled: true } } },
      async () => ({ cua_repl: cuaRepl }),
    )
    expect(servers).toEqual([])
  })

  it('reads nothing of an empty or odd configuration', async () => {
    expect(await desktopServers({}, async () => ({}))).toEqual([])
    expect(
      await desktopServers({ mcp_servers: [nodeRepl], plugins: 'x' }, async () => ({})),
    ).toEqual([])
  })
})

describe('the thread configuration that turns them off', () => {
  const servers = [
    { name: 'cua_repl', plugin: 'unified-computer-use@openai-bundled', command: 'C:\\a\\node.exe' },
    { name: 'node_repl', plugin: null, command: 'C:\\a\\node_repl.exe' },
  ]

  it('turns off each, keeping a configuration server’s command, and unloads the thread at once', () => {
    expect(desktopConfig(servers, new Set())).toEqual({
      mcp_servers: { node_repl: { command: 'C:\\a\\node_repl.exe', enabled: false } },
      plugins: {
        'unified-computer-use@openai-bundled': { mcp_servers: { cua_repl: { enabled: false } } },
      },
      thread_unload_delay_secs: 0,
    })
  })

  it('leaves alone those the user let start, and is nothing once none is left', () => {
    expect(desktopConfig(servers, new Set(['cua_repl']))).toEqual({
      mcp_servers: { node_repl: { command: 'C:\\a\\node_repl.exe', enabled: false } },
      thread_unload_delay_secs: 0,
    })
    expect(desktopConfig(servers, new Set(['cua_repl', 'node_repl']))).toBeNull()
    expect(desktopConfig([], new Set())).toBeNull()
  })
})

describe('a plugin’s servers as Codex installed it', () => {
  let home: string | null = null
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true })
    home = null
  })

  async function plugin(version: string, files: Record<string, unknown>): Promise<void> {
    const root = path.join(home!, 'plugins', 'cache', 'openai-bundled', 'computer', version)
    for (const [file, json] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), JSON.stringify(json))
    }
  }

  it('picks the version Codex runs: local, else the highest', () => {
    expect(activeVersion(['26.1111.71704', '26.1117.4957', '3.0.0'])).toBe('26.1117.4957')
    expect(activeVersion(['1.0.0', 'local'])).toBe('local')
    expect(activeVersion(['b', 'a', '..'])).toBe('b')
    expect(activeVersion([])).toBeNull()
  })

  it('takes the MCP file wrapped or plain', () => {
    expect(declaredServers({ mcpServers: { a: { command: 'x' } } })).toEqual({
      a: { command: 'x' },
    })
    expect(declaredServers({ a: { command: 'x' } })).toEqual({ a: { command: 'x' } })
    expect(declaredServers(null)).toEqual({})
  })

  it('reads the file the manifest names, inline servers, or `.mcp.json`', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kite-codex-home-'))
    const cache = new Map<string, Promise<Record<string, unknown>>>()
    await plugin('1.0.0', {
      '.codex-plugin/plugin.json': { name: 'computer' },
      '.mcp.json': { mcpServers: { old: { command: 'old' } } },
    })
    await plugin('2.0.0', {
      '.codex-plugin/plugin.json': { name: 'computer', mcpServers: './config/servers.json' },
      'config/servers.json': { cua_repl: { command: 'node' } },
    })
    expect(await readPluginServers(home, 'computer@openai-bundled', cache)).toEqual({
      cua_repl: { command: 'node' },
    })
    await plugin('3.0.0', {
      '.codex-plugin/plugin.json': { mcpServers: { mcpServers: { inline: { command: 'i' } } } },
    })
    expect(await readPluginServers(home, 'computer@openai-bundled', cache)).toEqual({
      inline: { command: 'i' },
    })
    await plugin('4.0.0', { '.mcp.json': { plain: { command: 'p' } } })
    expect(await readPluginServers(home, 'computer@openai-bundled', cache)).toEqual({
      plain: { command: 'p' },
    })
  })

  it('reads nothing outside the plugin’s folder, nor for an id Codex would not write', async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kite-codex-home-'))
    const cache = new Map<string, Promise<Record<string, unknown>>>()
    await writeFile(path.join(home, 'secret.json'), JSON.stringify({ s: { command: 'x' } }))
    await plugin('1.0.0', {
      '.codex-plugin/plugin.json': { mcpServers: '../../../../../secret.json' },
    })
    expect(await readPluginServers(home, 'computer@openai-bundled', cache)).toEqual({})
    for (const id of ['computer', '@openai-bundled', '../x@openai-bundled', 'computer@..']) {
      expect(await readPluginServers(home, id, cache)).toEqual({})
    }
    expect(await readPluginServers(home, 'missing@openai-bundled', cache)).toEqual({})
  })
})
