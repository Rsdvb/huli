import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_METHODS } from '@shared/agent-host'
import {
  DEFAULT_AGENT_NETWORK,
  NODE_NO_PROXY,
  type AgentNetworkSettings,
  type AgentNetworkStatus,
} from '@shared/agent-network'
import { createRedactor } from '@shared/log/redact'
import { forbiddenToDevices } from '@shared/remote/allow-list'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { hostSettings, validateSettingsPatch, mergeSettings } from '../../main/settings-schema'
import { applyNodeProxy, EnvironmentService } from '../shell-env'
import { createValidators } from '../validate'
import { bypassesProxy, fetchTrace, parseTrace, proxyHop, type ProxyHop } from './exit-ip'
import { networkStateFile, subscriptionSecrets, subscriptionsFile } from './files'
import { NodeProxy } from './service'

const TOKEN = '8f2c1d9a7b6e5f4a3c2b1d0e9f8a7b6c'
const URL_WITH_TOKEN = `https://sub.example.net/api/v1/client/subscribe?token=${TOKEN}&flag=meta`
const PATH_TOKEN_URL = `https://airport.example.org/link/${TOKEN}?clash=1`

const validators = createValidators('win32')

function rejects(run: () => unknown): void {
  expect(run).toThrow(expect.objectContaining({ code: 'invalid_params' }))
}

describe('the agent network requests', () => {
  it('are refused to every paired device', () => {
    const network = HOST_METHODS.filter((method) => method.startsWith('agentNetwork.'))
    expect(network.length).toBeGreaterThan(0)
    for (const method of network) expect(forbiddenToDevices(method, {})).toBe(true)
  })

  it('take only the known fields', () => {
    expect(
      validators['agentNetwork.addSubscription']({ name: '  My   airport ', url: URL_WITH_TOKEN }),
    ).toEqual({ name: 'My airport', url: URL_WITH_TOKEN })
    rejects(() =>
      validators['agentNetwork.addSubscription']({ name: 'A', url: URL_WITH_TOKEN, x: 1 }),
    )
    expect(validators['agentNetwork.refresh']({ id: null })).toEqual({ id: null })
    expect(validators['agentNetwork.refresh']({ id: 'abcdef012345' })).toEqual({
      id: 'abcdef012345',
    })
    expect(validators['agentNetwork.status'](undefined)).toBeUndefined()
    rejects(() => validators['agentNetwork.status']({ all: true }))
    expect(
      validators['agentNetwork.testLatency']({
        nodes: [{ subscription: 'abcdef012345', node: '香港 01' }],
      }),
    ).toEqual({ nodes: [{ subscription: 'abcdef012345', node: '香港 01' }] })
  })

  it('refuse addresses that are no http(s) subscription, and odd names and ids', () => {
    const add = validators['agentNetwork.addSubscription']
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com/sub',
      'https://',
      'not a url',
      `https://example.com/${'a'.repeat(5000)}`,
      42,
    ]) {
      rejects(() => add({ name: 'A', url }))
    }
    for (const name of ['', '   ', 'a|b', 'x'.repeat(41), 'nul\u0000here', 7]) {
      rejects(() => add({ name, url: URL_WITH_TOKEN }))
    }
    for (const id of ['../x', 'ABCDEF012345', 'abc', 1]) {
      rejects(() => validators['agentNetwork.removeSubscription']({ id }))
      rejects(() => validators['agentNetwork.renameSubscription']({ id, name: 'A' }))
    }
    rejects(() =>
      validators['agentNetwork.testLatency']({ nodes: [{ subscription: 'x', node: 'a' }] }),
    )
    rejects(() =>
      validators['agentNetwork.testLatency']({
        nodes: Array.from({ length: 501 }, () => ({ subscription: 'abcdef012345', node: 'a' })),
      }),
    )
  })

  it('check an exit only for an agent id', () => {
    const exitIp = validators['agentNetwork.exitIp']
    expect(exitIp({ agentId: 'codex' })).toEqual({ agentId: 'codex' })
    expect(exitIp({ agentId: 'codex', fresh: true })).toEqual({ agentId: 'codex', fresh: true })
    for (const params of [
      {},
      { agentId: '../codex' },
      { agentId: 7 },
      { agentId: 'codex', fresh: 'yes' },
      { agentId: 'codex', port: 7890 },
      { agentId: 'codex', url: 'http://evil.example' },
    ]) {
      rejects(() => exitIp(params))
    }
  })
})

describe('the exit check', () => {
  it('reads the address and country of a trace page', () => {
    const page = 'fl=123f\nh=www.cloudflare.com\nip=203.0.113.7\nts=1.2\nloc=JP\ntls=TLSv1.3\n'
    expect(parseTrace(page)).toEqual({ ip: '203.0.113.7', country: 'JP' })
    expect(parseTrace('ip=2001:db8::1\r\nloc=us\r\n')).toEqual({
      ip: '2001:db8::1',
      country: 'US',
    })
    expect(parseTrace('ip=198.51.100.2\nloc=XX')).toEqual({ ip: '198.51.100.2', country: null })
    expect(parseTrace('ip=198.51.100.2\nloc=T1')).toEqual({ ip: '198.51.100.2', country: null })
    expect(parseTrace('ip=198.51.100.2')).toEqual({ ip: '198.51.100.2', country: null })
    // Only the first ip line counts, and it must be an address.
    expect(parseTrace('ip=198.51.100.2\nip=192.0.2.1')).toEqual({
      ip: '198.51.100.2',
      country: null,
    })
    for (const page of ['', '<html>blocked</html>', 'ip=not-an-ip\nloc=JP', 'ip=<script>']) {
      expect(parseTrace(page)).toBeNull()
    }
  })

  it('speaks only to HTTP proxies, with their credentials', () => {
    expect(proxyHop(null)).toBeNull()
    expect(proxyHop('  ')).toBeNull()
    expect(proxyHop('http://127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890, auth: null })
    expect(proxyHop('corp:3128')).toEqual({ host: 'corp', port: 3128, auth: null })
    expect(proxyHop('http://u%40x:p%3Aw@[::1]:8080')).toEqual({
      host: '::1',
      port: 8080,
      auth: 'u@x:p:w',
    })
    for (const value of ['socks5://127.0.0.1:7891', 'https://proxy:443', 'http://']) {
      expect(proxyHop(value)).toBe('unsupported')
    }
    expect(bypassesProxy('localhost,.cloudflare.com')).toBe(true)
    expect(bypassesProxy('*')).toBe(true)
    expect(bypassesProxy('cloudflare.com:443')).toBe(true)
    expect(bypassesProxy('localhost,127.0.0.1,example.com')).toBe(false)
    expect(bypassesProxy('flare.com')).toBe(false)
  })

  it('fails when the listener refuses the tunnel, as mihomo does for REJECT', async () => {
    const proxy = createServer()
    proxy.on('connect', (_request, socket) => {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const { port } = proxy.address() as AddressInfo
    try {
      await expect(fetchTrace({ host: '127.0.0.1', port, auth: null }, 3_000)).rejects.toThrow(
        /502/,
      )
    } finally {
      proxy.close()
    }
  })
})

describe('applyNodeProxy', () => {
  const inherited = {
    PATH: '/usr/bin',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    ALL_PROXY: 'socks5://127.0.0.1:7891',
    all_proxy: 'socks5://127.0.0.1:7891',
    no_proxy: '*',
  }

  it('names only the agent’s listener, with loopback, LAN and Tailscale going around it', () => {
    const env = applyNodeProxy(inherited, 31337, 'linux')
    const url = 'http://127.0.0.1:31337'
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
      expect(env[name]).toBe(url)
      expect(env[name.toLowerCase()]).toBe(url)
    }
    const noProxy = env.NO_PROXY!.split(',')
    expect(env.no_proxy).toBe(env.NO_PROXY)
    expect(noProxy).toEqual([...NODE_NO_PROXY])
    for (const range of [
      'localhost',
      '127.0.0.0/8',
      '::1',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '100.64.0.0/10',
      '.ts.net',
    ]) {
      expect(noProxy).toContain(range)
    }
    expect(noProxy).not.toContain('*')
    expect(JSON.stringify(env)).not.toContain('7890')
    expect(JSON.stringify(env)).not.toContain('7891')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('sets only the upper-case names on Windows, whatever case they came in', () => {
    const env = applyNodeProxy(inherited, 31337, 'win32')
    expect(Object.keys(env).filter((key) => /proxy/i.test(key))).toEqual([
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
    ])
  })
})

describe('EnvironmentService with nodes', () => {
  it('gives an agent on a node its listener, and the rest the proxy setting', () => {
    const service = new EnvironmentService({
      platform: 'linux',
      nodeRuntime: { command: 'node', env: {} },
      baseEnv: { PATH: '/usr/bin' },
    })
    service.setProxy({ mode: 'custom', url: 'http://corp:8080', noProxy: '' })
    service.setNodeRoutes((agentId) => (agentId === 'codex' ? 30001 : null))
    expect(service.agentEnv('codex' as AgentId).HTTPS_PROXY).toBe('http://127.0.0.1:30001')
    expect(service.agentEnv('claude-code' as AgentId).HTTPS_PROXY).toBe('http://corp:8080')
    // Git and commands are Kite's own: never through a node.
    expect(service.agentEnv().HTTPS_PROXY).toBe('http://corp:8080')
  })
})

describe('subscription addresses in the logs', () => {
  it('are masked whole and in parts, without masking ordinary words', () => {
    for (const url of [URL_WITH_TOKEN, PATH_TOKEN_URL]) {
      const secrets = subscriptionSecrets(url)
      const redact = createRedactor({ secrets: () => secrets })
      const line = `[Provider] kite-sub-abc pull error: Get "${url}": EOF; token ${TOKEN} again`
      const masked = redact(line)
      expect(masked).not.toContain(TOKEN)
      expect(masked).not.toContain(url)
      expect(redact('subscribe to the client')).toBe('subscribe to the client')
    }
  })
})

describe('the agent network settings', () => {
  it('hold no subscription address', () => {
    expect(() =>
      validateSettingsPatch({ agentNetwork: { subscriptions: [{ url: URL_WITH_TOKEN }] } }),
    ).toThrow()
    expect(() => validateSettingsPatch({ agentNetwork: { defaultNode: URL_WITH_TOKEN } })).toThrow()
    expect(() =>
      validateSettingsPatch({
        agentNetwork: { defaultNode: { subscription: 'abcdef012345', node: 'a', url: 'x' } },
      }),
    ).toThrow()
    expect(() => validateSettingsPatch({ agentNetwork: { agents: { codex: 'direct' } } })).toThrow()
    expect(() => validateSettingsPatch({ agentNetwork: { interface: 'en0#proxy' } })).toThrow()
    const patch = validateSettingsPatch({
      agentNetwork: {
        enabled: true,
        defaultNode: { subscription: 'abcdef012345', node: '香港 01' },
        agents: { codex: 'system', 'claude-code': { subscription: 'abcdef012345', node: 'JP' } },
        interface: 'Wi-Fi',
      },
    })
    const settings = mergeSettings(structuredClone(DEFAULT_SETTINGS), patch)
    expect(hostSettings(settings, 'en').agentNetwork).toEqual(settings.agentNetwork)
  })
})

describe('NodeProxy', () => {
  const folders: string[] = []
  afterEach(async () => {
    await Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true })))
    folders.length = 0
  })

  async function proxy(
    settings: AgentNetworkSettings,
    extra: Partial<ConstructorParameters<typeof NodeProxy>[0]> = {},
  ) {
    const dir = await mkdtemp(path.join(tmpdir(), 'kite-network-'))
    folders.push(dir)
    const events: AgentNetworkStatus[] = []
    const log: string[] = []
    const service = new NodeProxy({
      userDataPath: dir,
      platform: 'linux',
      mihomoPath: null,
      log: (_, message) => log.push(message),
      subscriptions: subscriptionsFile(dir, () => {}),
      state: networkStateFile(dir, () => {}),
      settings: () => settings,
      agentIds: () => ['claude-code', 'codex'] as AgentId[],
      changed: (status) => events.push(status),
      routesChanged: () => {},
      detect: async () => 'eth0',
      ...extra,
    })
    await service.load()
    return { dir, service, events, log }
  }

  it('keeps the address in its own file and shows only its host', async () => {
    const { dir, service, events } = await proxy({ ...DEFAULT_AGENT_NETWORK, enabled: true })
    service.start()
    await service.addSubscription('Airport', URL_WITH_TOKEN)
    await service.addSubscription('Other', PATH_TOKEN_URL)
    const status = service.status()
    expect(status.subscriptions.map((s) => s.host)).toEqual([
      'sub.example.net',
      'airport.example.org',
    ])
    for (const shown of [status, ...events]) {
      expect(JSON.stringify(shown)).not.toContain(TOKEN)
      expect(JSON.stringify(shown)).not.toContain('/api/v1')
    }
    const stored = await readFile(path.join(dir, 'agent-network', 'subscriptions.json'), 'utf8')
    expect(stored).toContain(TOKEN)
    const state = await readFile(path.join(dir, 'state', 'agent-network.json'), 'utf8').catch(
      () => '',
    )
    expect(state).not.toContain(TOKEN)
    await service.shutdown()
  })

  it('fails closed without mihomo: agents on a node still get only their listener', async () => {
    const { service } = await proxy({
      ...DEFAULT_AGENT_NETWORK,
      enabled: true,
      agents: { codex: 'system' } as AgentNetworkSettings['agents'],
    })
    service.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const status = service.status()
    expect(status).toMatchObject({ available: false, state: 'error', problem: 'missing' })
    expect(service.portFor('claude-code' as AgentId)).toEqual(expect.any(Number))
    expect(service.portFor('codex' as AgentId)).toBeNull()
    await service.shutdown()
  })

  it('checks an agent on a node only through its listener, and fails closed', async () => {
    const hops: (ProxyHop | null)[] = []
    const { service } = await proxy(
      { ...DEFAULT_AGENT_NETWORK, enabled: true, agents: { codex: 'system' } },
      {
        systemProxy: () => ({ proxy: 'http://corp:8080', noProxy: null }),
        trace: async (hop) => {
          hops.push(hop)
          if (hop?.host === '127.0.0.1') throw new Error('connect ECONNREFUSED')
          return 'ip=198.51.100.9\nloc=DE\n'
        },
      },
    )
    service.start()
    const listener = service.portFor('claude-code' as AgentId)
    const onNode = await service.exitIp('claude-code' as AgentId)
    expect(hops[0]).toEqual({ host: '127.0.0.1', port: listener, auth: null })
    expect(onNode).toMatchObject({ via: 'node', ip: null, country: null, failure: 'unreachable' })
    const onSystem = await service.exitIp('codex' as AgentId)
    expect(hops[1]).toEqual({ host: 'corp', port: 8080, auth: null })
    expect(onSystem).toMatchObject({ via: 'system', ip: '198.51.100.9', country: 'DE' })
    // A recent check stands; a fresh one goes out again.
    await service.exitIp('codex' as AgentId)
    expect(hops).toHaveLength(2)
    await service.exitIp('codex' as AgentId, true)
    expect(hops).toHaveLength(3)
    await expect(service.exitIp('nobody' as AgentId)).rejects.toThrow()
    await service.shutdown()
  })

  it('reports a system proxy it cannot speak instead of going around it', async () => {
    let traced = false
    const { service } = await proxy(DEFAULT_AGENT_NETWORK, {
      systemProxy: () => ({ proxy: 'socks5://127.0.0.1:7891', noProxy: null }),
      trace: async () => {
        traced = true
        return 'ip=198.51.100.9'
      },
    })
    expect(await service.exitIp('codex' as AgentId)).toMatchObject({
      via: 'system',
      ip: null,
      failure: 'unsupported',
    })
    expect(traced).toBe(false)
    await service.shutdown()
  })

  it('leaves every agent on the system network while off', async () => {
    const { service } = await proxy(DEFAULT_AGENT_NETWORK)
    service.start()
    expect(service.portFor('claude-code' as AgentId)).toBeNull()
    expect(service.status().state).toBe('off')
    await service.shutdown()
  })
})
