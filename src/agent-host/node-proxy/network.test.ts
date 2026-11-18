import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

  async function proxy(settings: AgentNetworkSettings) {
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

  it('leaves every agent on the system network while off', async () => {
    const { service } = await proxy(DEFAULT_AGENT_NETWORK)
    service.start()
    expect(service.portFor('claude-code' as AgentId)).toBeNull()
    expect(service.status().state).toBe('off')
    await service.shutdown()
  })
})
