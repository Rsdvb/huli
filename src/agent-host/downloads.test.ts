// Huli: Kite's own downloads (a harness's release archive, the ACP Registry's listing and the
// harness manifest) go through the proxy Advanced › Proxy or the environment names, and one that
// receives nothing gives up within its stall time instead of its whole time limit. The proxy here
// takes each CONNECT and then sends nothing, so no request leaves the computer.

import { readdir } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import { AgentManager } from './agents'
import { HARN } from './agents/harn'
import { installArchive } from './archive-install'
import { archiveKey } from './binary-install'
import { Diagnostics } from './diagnostics'
import { fetchManifest } from './harness-manifest'
import { parseBundled } from './harness-versions'
import { routeFor } from './node-proxy/download'
import { httpTransport, StalledError } from './node-runtime/transport'
import { fetchRegistry } from './registry'
import { EnvironmentService } from './shell-env'
import { tempFolder } from './testing/temp'

const ARCHIVE = 'https://downloads.example/harn/v1.0.0/harn.zip'

/** A proxy that opens every tunnel asked for and never sends a byte through it. */
async function stallingProxy(): Promise<{ url: string; asked: string[] }> {
  const asked: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let head = ''
    socket.on('data', (chunk: Buffer) => {
      if (head.includes('\r\n\r\n')) return
      head += chunk.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      asked.push(head.split('\r\n')[0]!)
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The proxy has no port')
  return { url: `http://127.0.0.1:${address.port}`, asked }
}

/** Kite's own requests with Advanced › Proxy naming `proxy`. */
function through(proxy: string) {
  return httpTransport(() => routeFor({ http: proxy, https: proxy, all: null, noProxy: null }))
}

describe("Kite's own downloads through a proxy that stalls", () => {
  it('give up once nothing arrives for the stall time', async () => {
    const proxy = await stallingProxy()
    const started = Date.now()
    await expect(
      through(proxy.url).text('https://files.example/list.json', {
        signal: AbortSignal.timeout(10_000),
        maxBytes: 1024,
        stallMs: 200,
      }),
    ).rejects.toBeInstanceOf(StalledError)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(proxy.asked).toEqual(['CONNECT files.example:443 HTTP/1.1'])
  })

  it('stop an archive install at the stall, long before its time limit, and leave nothing', async () => {
    const proxy = await stallingProxy()
    const root = await tempFolder('kite-stall-')
    const started = Date.now()
    await expect(
      installArchive({
        root,
        agentId: 'harn',
        version: '1.0.0',
        url: ARCHIVE,
        cmd: './harn',
        bare: true,
        platform: process.platform,
        timeoutMs: 60_000,
        stallMs: 200,
        transport: through(proxy.url),
      }),
    ).rejects.toThrow(/stalled: nothing arrived for 0\.2 s/)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(proxy.asked).toEqual(['CONNECT downloads.example:443 HTTP/1.1'])
    expect(await readdir(path.join(root, 'harn'))).toEqual([])
  })

  it("read the Registry's listing and the manifest through it, within their time limits", async () => {
    const proxy = await stallingProxy()
    const transport = through(proxy.url)
    await expect(fetchRegistry({ timeoutMs: 200, transport })).rejects.toThrow(
      /did not answer within 0\.2 s/,
    )
    await expect(fetchManifest({ timeoutMs: 200, transport })).rejects.toThrow(
      /did not answer within 200 ms/,
    )
    expect(proxy.asked).toEqual([
      'CONNECT cdn.agentclientprotocol.com:443 HTTP/1.1',
      'CONNECT download.kettu.sh:443 HTTP/1.1',
    ])
  })
})

describe("the agent manager's downloads", () => {
  it('take Advanced › Proxy for the listing, the manifest and an archive install', async () => {
    const proxy = await stallingProxy()
    const root = await tempFolder('kite-downloads-')
    const platform = process.platform === 'win32' ? 'win32' : process.platform
    const nodeRuntime = { command: process.execPath, env: {} }
    const settings: HostSettings = {
      locale: 'en',
      initialSetupDone: true,
      agents: { harn: { enabled: true } },
      addedAgents: [],
      disabledAgents: [],
      proxy: { mode: 'custom', url: proxy.url, noProxy: '' },
      git: DEFAULT_SETTINGS.git,
      mcp: DEFAULT_SETTINGS.mcp,
      marketplace: DEFAULT_SETTINGS.marketplace,
      startModes: DEFAULT_SETTINGS.startModes,
      idleSessions: DEFAULT_SETTINGS.idleSessions,
      usage: { fromComputer: false },
      sessionTitles: true,
      workflow: DEFAULT_SETTINGS.workflow,
      startedSessions: DEFAULT_SETTINGS.startedSessions,
      lightModel: { mode: 'small' },
      defaultAgent: null,
      computerUse: DEFAULT_SETTINGS.computerUse,
      agentNetwork: DEFAULT_SETTINGS.agentNetwork,
      downloadService: true,
      claudeTestEntrypoint: null,
      claudeRuns: {},
      promptSuggestions: true,
      continueAfterLimit: true,
      agentPasswords: false,
    }
    const env = new EnvironmentService({
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
      probe: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
    })
    env.setProxy(settings.proxy)
    const binary = { [archiveKey(platform, process.arch)]: { archive: ARCHIVE, cmd: './harn' } }
    const agents = new AgentManager({
      catalog: [HARN],
      platform,
      nodeRuntime,
      appVersion: '0.0.0-test',
      env,
      diagnostics: new Diagnostics(),
      launcher: {
        launch: () => {
          throw new Error('the test starts nothing')
        },
      },
      settings: () => settings,
      reportsDir: path.join(root, 'reports'),
      adaptersDir: root,
      bundled: parseBundled({
        registry: { agents: [{ id: 'harn', version: '1.0.0', distribution: { binary } }] },
      }),
      timings: { updateViewMs: 200, installMs: 300 },
      status: () => {},
      processes: () => {},
      authCommands: () => {},
    })

    await expect(agents.checkUpdates()).rejects.toThrow(/did not answer within 0\.2 s/)
    await expect(agents.install('harn', 'archive')).rejects.toThrow(
      /did not finish downloading within 0\.3 s/,
    )
    expect([...proxy.asked].sort()).toEqual([
      'CONNECT cdn.agentclientprotocol.com:443 HTTP/1.1',
      'CONNECT download.kettu.sh:443 HTTP/1.1',
      'CONNECT downloads.example:443 HTTP/1.1',
    ])
  })
})
