import { describe, expect, it } from 'vitest'
import { agentGroup, DEFAULT_GROUP, mihomoConfig, providerName } from './config'

const SECRET = 'f'.repeat(48)

function config(subscriptions = 2, agents = ['claude-code', 'codex~work']) {
  return mihomoConfig({
    controllerPort: 41234,
    secret: SECRET,
    networkInterface: '以太网 2',
    subscriptions: Array.from({ length: subscriptions }, (_, i) => ({
      id: `${i}`.repeat(12),
      name: `Sub ${i}`,
      url: `https://example.com/api/v1/client/subscribe?token=secret${i}`,
    })),
    agents: agents.map((agentId, i) => ({ agentId: agentId as never, port: 30000 + i })),
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
      proxies: ['REJECT', DEFAULT_GROUP],
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
    expect(first.proxy).toBe('DIRECT')
    expect(config()['interface-name']).toBe('以太网 2')
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
