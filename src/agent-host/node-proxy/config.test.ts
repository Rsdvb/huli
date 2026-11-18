import { describe, expect, it } from 'vitest'
import {
  agentGroup,
  DEFAULT_GROUP,
  HOP_USER,
  hopName,
  INTERFACE_PROXY,
  interfaceConfig,
  mihomoConfig,
  providerName,
} from './config'

const SECRET = 'f'.repeat(48)
const HOP_PASSWORD = 'a'.repeat(48)

function config(subscriptions = 2, agents = ['claude-code', 'codex~work']) {
  return mihomoConfig({
    controllerPort: 41234,
    secret: SECRET,
    networkInterface: '以太网 2',
    subscriptions: Array.from({ length: subscriptions }, (_, i) => ({
      id: `${i}`.repeat(12),
      name: `Sub ${i}`,
    })),
    agents: agents.map((agentId, i) => ({
      agentId: agentId as never,
      port: 30000 + i,
      hopPort: 32000 + i,
    })),
    hopPassword: HOP_PASSWORD,
    loopbackInterface: 'Loopback Pseudo-Interface 1',
  })
}

type Group = { name: string; type: string; proxies: string[]; use?: string[] } & Record<
  string,
  unknown
>

describe('mihomoConfig', () => {
  it('serves its API on 127.0.0.1 only, with the secret, to no web page', () => {
    const c = config()
    expect(c['external-controller']).toBe('127.0.0.1:41234')
    expect(c.secret).toBe(SECRET)
    expect(c['external-controller-cors']).toEqual({
      'allow-origins': [],
      'allow-private-network': false,
    })
  })

  it('takes nothing from the network but the agents and starts no listener of its own', () => {
    const c = config()
    expect(c['allow-lan']).toBe(false)
    expect(c['bind-address']).toBe('127.0.0.1')
    for (const key of ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port', 'tun']) {
      expect(c).not.toHaveProperty(key)
    }
    expect(c.dns).not.toHaveProperty('listen')
    expect(c['geo-auto-update']).toBe(false)
    expect(c.profile).toEqual({ 'store-selected': false, 'store-fake-ip': false })
  })

  it('gives each agent a listener on 127.0.0.1 bound to its own group', () => {
    const listeners = config().listeners as Record<string, unknown>[]
    expect(listeners).toEqual([
      expect.objectContaining({
        type: 'mixed',
        listen: '127.0.0.1',
        port: 30000,
        proxy: agentGroup('claude-code'),
      }),
      expect.objectContaining({
        type: 'mixed',
        listen: '127.0.0.1',
        port: 30001,
        proxy: agentGroup('codex~work' as never),
      }),
    ])
  })

  it('starts every group on REJECT, falls back to REJECT, and never names DIRECT', () => {
    for (const c of [config(), config(0), config(0, [])]) {
      const groups = c['proxy-groups'] as Group[]
      expect(groups[0]!.name).toBe(DEFAULT_GROUP)
      for (const group of groups) {
        expect(group.type).toBe('select')
        expect(group.proxies[0]).toBe('REJECT')
        expect(group['empty-fallback']).toBe('REJECT')
        expect(JSON.stringify(group)).not.toContain('DIRECT')
      }
      expect(c.rules).toEqual(['MATCH,REJECT'])
      const listeners = c.listeners as Record<string, unknown>[]
      expect(JSON.stringify(listeners)).not.toContain('DIRECT')
    }
  })

  it('lets an agent pick the default group or any subscription’s node', () => {
    const groups = config()['proxy-groups'] as Group[]
    const providers = [providerName('000000000000'), providerName('111111111111')]
    expect(groups[0]!.use).toEqual(providers)
    expect(groups[1]).toMatchObject({
      name: agentGroup('claude-code'),
      proxies: ['REJECT', DEFAULT_GROUP, hopName('claude-code')],
      use: providers,
    })
    // No subscription: the groups hold REJECT alone, never an empty list.
    for (const group of config(0)['proxy-groups'] as Group[])
      expect(group).not.toHaveProperty('use')
  })

  it('dials every node out on the interface, with names kept apart by subscription', () => {
    const providers = config()['proxy-providers'] as Record<string, Record<string, unknown>>
    expect(Object.keys(providers)).toEqual([
      providerName('000000000000'),
      providerName('111111111111'),
    ])
    const first = providers[providerName('000000000000')]!
    expect(first.override).toEqual({
      'interface-name': '以太网 2',
      'additional-prefix': 'Sub 0 | ',
    })
    expect(first.path).toBe('./providers/000000000000.yaml')
    expect(config()['interface-name']).toBe('以太网 2')
  })

  it('reads each subscription from the file Kite wrote, and downloads nothing itself', () => {
    const c = config()
    const providers = c['proxy-providers'] as Record<string, Record<string, unknown>>
    for (const provider of Object.values(providers)) {
      expect(provider.type).toBe('file')
      for (const key of ['url', 'proxy', 'interval', 'header', 'dialer-proxy']) {
        expect(provider).not.toHaveProperty(key)
      }
      expect(provider['health-check']).toMatchObject({ enable: true, lazy: true })
    }
    // Nothing anywhere names DIRECT, the subscriptions' old way out.
    for (const each of [c, config(0), config(0, [])]) {
      expect(JSON.stringify(each)).not.toContain('DIRECT')
    }
  })

  it('gives each agent its own hop: SOCKS5 to 127.0.0.1 with the password, in its group alone', () => {
    const c = config()
    expect(c.proxies).toEqual([
      {
        name: hopName('claude-code'),
        type: 'socks5',
        server: '127.0.0.1',
        port: 32000,
        username: HOP_USER,
        password: HOP_PASSWORD,
        udp: false,
        'interface-name': 'Loopback Pseudo-Interface 1',
      },
      expect.objectContaining({ name: hopName('codex~work' as never), port: 32001 }),
    ])
    const groups = c['proxy-groups'] as Group[]
    // The default group and every other agent's group never reach this agent's interface.
    expect(groups[0]!.proxies).toEqual(['REJECT'])
    expect(groups[2]!.proxies).toEqual(['REJECT', DEFAULT_GROUP, hopName('codex~work' as never)])
  })

  it('resolves through DNS over HTTPS by address, bound to the interface', () => {
    const dns = config().dns as Record<string, unknown>
    expect(dns.enable).toBe(true)
    const bound = ['https://223.5.5.5/dns-query#以太网 2', 'https://1.12.12.12/dns-query#以太网 2']
    expect(dns.nameserver).toEqual(bound)
    expect(dns['proxy-server-nameserver']).toEqual(bound)
    expect(dns['direct-nameserver']).toEqual(bound)
    expect(dns).not.toHaveProperty('fallback')
  })
})

describe('interfaceConfig', () => {
  function bound(networkInterface = 'Mihomo', agentId = 'claude-code') {
    return interfaceConfig({
      controllerPort: 41235,
      secret: SECRET,
      networkInterface,
      agentId: agentId as never,
      port: 32000,
      hopPassword: HOP_PASSWORD,
    })
  }

  it('takes the hop alone, on 127.0.0.1 with its password, its API on loopback alone', () => {
    const c = bound()
    expect(c['external-controller']).toBe('127.0.0.1:41235')
    expect(c.secret).toBe(SECRET)
    expect(c['allow-lan']).toBe(false)
    expect(c['bind-address']).toBe('127.0.0.1')
    for (const key of ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port', 'tun']) {
      expect(c).not.toHaveProperty(key)
    }
    expect(c['skip-auth-prefixes']).toEqual([])
    expect(c.listeners).toEqual([
      {
        name: 'kite-hop-claude-code',
        type: 'socks',
        listen: '127.0.0.1',
        port: 32000,
        udp: false,
        users: [{ username: HOP_USER, password: HOP_PASSWORD }],
        proxy: agentGroup('claude-code'),
      },
    ])
  })

  it('puts REJECT first and the interface-bound direct proxy alone beside it', () => {
    const c = bound()
    expect(c.proxies).toEqual([
      { name: INTERFACE_PROXY, type: 'direct', 'interface-name': 'Mihomo' },
    ])
    for (const group of c['proxy-groups'] as Group[]) {
      expect(group).toMatchObject({ type: 'select', 'empty-fallback': 'REJECT' })
      expect(group.proxies).toEqual(['REJECT', INTERFACE_PROXY])
      expect(group).not.toHaveProperty('use')
    }
    expect(c).not.toHaveProperty('proxy-providers')
    expect(c.rules).toEqual(['MATCH,REJECT'])
    // The global DIRECT, which dials on whatever route the system picks, is named nowhere.
    expect(JSON.stringify(c)).not.toContain('DIRECT')
    expect(c['interface-name']).toBe('Mihomo')
  })

  it('resolves names over plain DNS bound to the interface, so a TUN can hijack it', () => {
    for (const [name, fragment] of [
      ['Mihomo', 'Mihomo'],
      ['以太网 2', '%E4%BB%A5%E5%A4%AA%E7%BD%91%202'],
      ['vEthernet (WSL)', 'vEthernet%20(WSL)'],
    ]) {
      const dns = bound(name).dns as Record<string, unknown>
      const servers = [`udp://223.5.5.5#${fragment}`, `udp://119.29.29.29#${fragment}`]
      expect(dns).toMatchObject({ enable: true, 'respect-rules': false })
      expect(dns.nameserver).toEqual(servers)
      expect(dns['direct-nameserver']).toEqual(servers)
      expect(dns['proxy-server-nameserver']).toEqual(servers)
      expect(dns).not.toHaveProperty('fallback')
      expect(dns).not.toHaveProperty('listen')
      // Decoded as mihomo reads a URL's fragment, it names the interface whole.
      expect(decodeURIComponent(new URL(servers[0]!).hash.slice(1))).toBe(name)
    }
  })
})
