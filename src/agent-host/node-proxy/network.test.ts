import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_METHODS } from '@shared/agent-host'
import {
  DEFAULT_AGENT_NETWORK,
  NODE_NO_PROXY,
  type AgentNetworkSettings,
  type AgentNetworkStatus,
} from '@shared/agent-network'
import { createRedactor } from '@shared/log/redact'
import { forbiddenToDevices } from '@shared/remote/allow-list'
import { isHostAdminMethod, splitSettingsPatch } from '@shared/remote/host-admin'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import {
  hostSettings,
  mergeSettings,
  validateSettingsPatch,
  withAgentNetworkChoice,
  withDefaultNode,
} from '../../main/settings-schema'
import { applyNodeProxy, EnvironmentService } from '../shell-env'
import { createValidators } from '../validate'
import { bypassesProxy, fetchTrace, parseTrace, proxyHop, type ProxyHop } from './exit-ip'
import type { Downloaded } from './download'
import {
  networkStateFile,
  parseNetworkStateFile,
  providerFile,
  subscriptionSecrets,
  subscriptionsFile,
} from './files'
import {
  InterfaceWatch,
  type InterfaceChange,
  parseLinuxLinks,
  parseLinuxRoutes,
  parseMacInterfaces,
  parseMacRoutes,
  parseWindowsAdapters,
  pickInterface,
} from './interface'
import { NodeProxy } from './service'

const TOKEN = '8f2c1d9a7b6e5f4a3c2b1d0e9f8a7b6c'
const URL_WITH_TOKEN = `https://sub.example.net/api/v1/client/subscribe?token=${TOKEN}&flag=meta`
const PATH_TOKEN_URL = `https://airport.example.org/link/${TOKEN}?clash=1`
const NODES_YAML =
  'proxies:\n  - { name: JP 01, type: ss, server: 192.0.2.1, port: 1, password: p }\n'
const NODE_LINKS = 'trojan://p@192.0.2.2:443#US\nss://YWVzLTEyOC1nY206eA@192.0.2.1:8388#JP'
const USERINFO = 'upload=10; download=20; total=1000; expire=1767225600'

function served(body: string, userinfo: string | null = USERINFO): Downloaded {
  return { body: Buffer.from(body), userinfo }
}

const validators = createValidators('win32')

const INTERFACES = [
  { name: 'Meta', description: 'Meta Tunnel', up: true, tunnel: true },
  { name: 'eth0', description: 'Realtek PCIe GbE', up: true, tunnel: false },
  { name: 'wlan0', description: null, up: false, tunnel: false },
]

function rejects(run: () => unknown): void {
  expect(run).toThrow(expect.objectContaining({ code: 'invalid_params' }))
}

/** The agent network's requests a paired device may make: they carry no subscription's address. */
const DEVICE_SAFE = ['agentNetwork.deviceStatus', 'agentNetwork.deviceLatency']

describe('the agent network requests', () => {
  it('are refused to every paired device, but for the device-safe ones', () => {
    for (const method of [
      'agentNetwork.status',
      'agentNetwork.addSubscription',
      'agentNetwork.importSubscription',
      'agentNetwork.reimportSubscription',
      'agentNetwork.renameSubscription',
      'agentNetwork.removeSubscription',
      'agentNetwork.refresh',
      'agentNetwork.nodes',
      'agentNetwork.testLatency',
      'agentNetwork.exitIp',
      'agentNetwork.interfaces',
    ]) {
      expect(HOST_METHODS).toContain(method)
      expect(forbiddenToDevices(method, {})).toBe(true)
    }
    // A method added later is the windows' alone unless it is listed here on purpose.
    const network = HOST_METHODS.filter((method) => method.startsWith('agentNetwork.'))
    for (const method of network) {
      expect(forbiddenToDevices(method, {})).toBe(!DEVICE_SAFE.includes(method))
    }
    for (const method of DEVICE_SAFE) expect(HOST_METHODS).toContain(method)
  })

  it('let a device pick nodes only through the two narrow admin calls', () => {
    expect(isHostAdminMethod('settings.setDefaultNode')).toBe(true)
    expect(isHostAdminMethod('settings.setAgentNetwork')).toBe(true)
    // The generic settings call still treats the whole section as the computer's own.
    expect(splitSettingsPatch({ agentNetwork: { enabled: true } }).host).toBeNull()
    expect(
      splitSettingsPatch({
        agentNetwork: { defaultNode: { subscription: 'abcdef012345', node: 'JP' } },
      }).host,
    ).toBeNull()

    const ref = { subscription: 'abcdef012345', node: '香港 01' }
    const settings = structuredClone(DEFAULT_SETTINGS)
    expect(withDefaultNode(settings, ref).agentNetwork.defaultNode).toEqual(ref)
    expect(withDefaultNode(settings, null).agentNetwork.defaultNode).toBeNull()
    const chosen = withAgentNetworkChoice(
      withAgentNetworkChoice(settings, 'codex', 'system'),
      'claude-code',
      ref,
    )
    expect(chosen.agentNetwork.agents).toEqual({ codex: 'system', 'claude-code': ref })
    expect(withAgentNetworkChoice(chosen, 'codex', null).agentNetwork.agents).toEqual({
      'claude-code': ref,
    })
    // Only a node reference goes in: no address, no extra field, nothing else switched.
    for (const node of [
      URL_WITH_TOKEN,
      { ...ref, url: URL_WITH_TOKEN },
      { subscription: '../x', node: 'a' },
      { subscription: 'abcdef012345', node: '' },
      'system',
    ]) {
      expect(() => withDefaultNode(settings, node)).toThrow()
    }
    for (const [agentId, choice] of [
      ['codex', 'direct'],
      ['codex', { ...ref, url: URL_WITH_TOKEN }],
      ['codex', URL_WITH_TOKEN],
      ['../codex', 'system'],
      [7, 'system'],
    ] as const) {
      expect(() => withAgentNetworkChoice(settings, agentId, choice)).toThrow()
    }
    expect(withDefaultNode(settings, ref).agentNetwork.enabled).toBe(settings.agentNetwork.enabled)
  })

  it('let a device bind an agent to one interface, by a bounded name alone', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    for (const name of [
      'Mihomo',
      '以太网 2',
      'vEthernet (WSL (Hyper-V firewall))',
      'utun4',
      'Wi-Fi',
    ]) {
      const chosen = withAgentNetworkChoice(settings, 'codex', { interface: name })
      expect(chosen.agentNetwork.agents).toEqual({ codex: { interface: name } })
    }
    for (const choice of [
      { interface: '' },
      { interface: ' Mihomo' },
      { interface: 'x'.repeat(129) },
      { interface: 'Mihomo#proxy' },
      { interface: 'a&b' },
      { interface: 'a=b' },
      { interface: 'Mi\u0000homo' },
      { interface: 7 },
      { interface: 'Mihomo', node: 'JP' },
      { interface: 'Mihomo', subscription: 'abcdef012345', node: 'JP' },
      { name: 'Mihomo' },
    ]) {
      expect(() => withAgentNetworkChoice(settings, 'codex', choice)).toThrow()
    }
    expect(() =>
      validateSettingsPatch({ agentNetwork: { agents: { codex: { interface: 'a&b' } } } }),
    ).toThrow()
    const patch = validateSettingsPatch({
      agentNetwork: { agents: { codex: { interface: 'Mihomo' }, 'claude-code': 'system' } },
    })
    expect(patch.agentNetwork?.agents).toEqual({
      codex: { interface: 'Mihomo' },
      'claude-code': 'system',
    })
  })

  it('take a file’s text to import only as text of at most 10 MiB, never echoed back', () => {
    const add = validators['agentNetwork.importSubscription']
    expect(add({ name: ' Mine ', content: NODES_YAML })).toEqual({
      name: 'Mine',
      content: NODES_YAML,
    })
    expect(
      validators['agentNetwork.reimportSubscription']({ id: 'abcdef012345', content: NODE_LINKS }),
    ).toEqual({ id: 'abcdef012345', content: NODE_LINKS })
    for (const content of [
      undefined,
      42,
      { text: NODES_YAML },
      'x'.repeat(10 * 1024 * 1024 + 1),
      `${NODES_YAML}\u0000`,
    ]) {
      rejects(() => add({ name: 'A', content }))
    }
    rejects(() => add({ name: 'A', content: NODES_YAML, url: URL_WITH_TOKEN }))
    rejects(() => add({ name: 'a|b', content: NODES_YAML }))
    rejects(() => validators['agentNetwork.reimportSubscription']({ id: '../x', content: 'a' }))
    try {
      add({ name: 'A', content: `${TOKEN}\u0000` })
    } catch (error) {
      expect((error as Error).message).not.toContain(TOKEN)
    }
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

  it('sends the request through the tunnel, never around it', async () => {
    const proxy = createServer()
    let hello: number | null = null
    proxy.on('connect', (_request, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.once('data', (data: Buffer) => {
        // A TLS handshake record: the trace request started inside the tunnel.
        hello = data[0] ?? null
        socket.destroy()
      })
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const { port } = proxy.address() as AddressInfo
    try {
      await expect(fetchTrace({ host: '127.0.0.1', port, auth: null }, 3_000)).rejects.toThrow()
      expect(hello).toBe(0x16)
    } finally {
      proxy.close()
    }
  })
})

describe('the physical interface', () => {
  it('is the Mac’s scoped Wi-Fi route while a TUN holds the default', () => {
    const netstat = [
      'Destination        Gateway            Flags               Netif Expire',
      'default            link#34            UCSg                utun8',
      'default            192.168.1.1        UGScIg                en0',
      'default            link#33            UCSIg               utun4',
      '10.20.0.1          10.20.0.1          UH                  utun8',
    ].join('\n')
    expect(pickInterface(parseMacRoutes(netstat))).toBe('en0')
  })

  it('prefers the Mac’s unscoped physical route to a scoped one', () => {
    const netstat = [
      'default            192.168.1.1        UGScg                 en0',
      'default            192.168.2.1        UGScIg                en7',
    ].join('\n')
    expect(pickInterface(parseMacRoutes(netstat))).toBe('en0')
  })

  it('is the lowest-metric Linux route that is no TUN, Tailscale or bridge', () => {
    const ip = [
      'default dev tun0 scope link',
      'default via 100.100.100.100 dev tailscale0 metric 5',
      'default via 172.17.0.1 dev docker0 metric 10',
      'default via 192.168.1.1 dev wlp3s0 proto dhcp metric 600',
      'default via 172.27.48.1 dev eth0 proto kernel onlink',
    ].join('\n')
    expect(pickInterface(parseLinuxRoutes(ip))).toBe('eth0')
  })

  it('is none when only a TUN has a default route', () => {
    expect(pickInterface(parseMacRoutes('default  link#34  UCSg  utun8'))).toBeNull()
    expect(pickInterface(parseLinuxRoutes('default dev Meta scope link'))).toBeNull()
  })
})

describe('the computer’s interfaces', () => {
  it('lists Windows adapters with their state, TUNs marked, names as they are', () => {
    const json = JSON.stringify([
      { name: 'WLAN', description: 'Qualcomm Wi-Fi 7', status: 'Up' },
      { name: 'Mihomo', description: 'Meta Tunnel', status: 'Up' },
      { name: '以太网', description: 'Realtek PCIe 5GbE', status: 'Disconnected' },
      { name: 'Tailscale', description: 'Tailscale Tunnel', status: 'Disabled' },
    ])
    expect(parseWindowsAdapters(json)).toEqual([
      { name: 'Mihomo', description: 'Meta Tunnel', up: true, tunnel: true },
      { name: 'WLAN', description: 'Qualcomm Wi-Fi 7', up: true, tunnel: false },
      { name: 'Tailscale', description: 'Tailscale Tunnel', up: false, tunnel: true },
      { name: '以太网', description: 'Realtek PCIe 5GbE', up: false, tunnel: false },
    ])
    expect(parseWindowsAdapters(JSON.stringify({ name: 'WLAN', status: 'Up' }))).toEqual([
      { name: 'WLAN', description: null, up: true, tunnel: false },
    ])
    expect(parseWindowsAdapters('')).toEqual([])
  })

  it('lists a Mac’s interfaces but loopback, an inactive one as down', () => {
    const ifconfig = [
      'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384',
      'en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500',
      '\tstatus: active',
      'en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500',
      '\tstatus: inactive',
      'utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500',
      '\tinet 198.18.0.1 --> 198.18.0.1 netmask 0xffff0000',
    ].join('\n')
    const ports = 'Hardware Port: Wi-Fi\nDevice: en0\n\nHardware Port: Thunderbolt 1\nDevice: en1\n'
    expect(parseMacInterfaces(ifconfig, ports)).toEqual([
      { name: 'en0', description: 'Wi-Fi', up: true, tunnel: false },
      { name: 'utun4', description: null, up: true, tunnel: true },
      { name: 'en1', description: 'Thunderbolt 1', up: false, tunnel: false },
    ])
  })

  it('lists Linux links but loopback, up only with a carrier', () => {
    const ip = [
      '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN\\    link/loopback 00:00',
      '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP\\    link/ether 00:11',
      '3: wlan0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 state DOWN\\    link/ether 00:12',
      '4: Meta: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 9000 state UNKNOWN\\    link/none ',
      '5: veth1@if4: <BROADCAST,UP,LOWER_UP> mtu 1500 state UP\\    link/ether 00:13',
    ].join('\n')
    expect(parseLinuxLinks(ip)).toEqual([
      { name: 'Meta', description: null, up: true, tunnel: true },
      { name: 'eth0', description: null, up: true, tunnel: false },
      { name: 'veth1', description: null, up: true, tunnel: false },
      { name: 'wlan0', description: null, up: false, tunnel: false },
    ])
  })
})

describe('the watch on bound interfaces', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function watching(initial: string[]) {
    let present: string[] | null = initial
    let reads = 0
    const changes: InterfaceChange[] = []
    const watch = new InterfaceWatch({
      read: () => {
        reads++
        if (present === null) throw new Error('cannot read')
        return present
      },
      intervalMs: 2_500,
      changed: (change) => changes.push(change),
    })
    return {
      watch,
      changes,
      reads: () => reads,
      set: (names: string[] | null) => {
        present = names
      },
    }
  }

  it('reads nothing while no agent is bound, and at once when one is', () => {
    vi.useFakeTimers()
    const w = watching(['Mihomo', 'WLAN'])
    w.watch.watch([])
    vi.advanceTimersByTime(60_000)
    expect(w.reads()).toBe(0)
    expect(w.watch.usable('Mihomo')).toBeNull()
    w.watch.watch(['Mihomo', 'Gone'])
    expect(w.reads()).toBe(1)
    expect(w.watch.usable('Mihomo')).toBe(true)
    expect(w.watch.usable('Gone')).toBe(false)
    // A new binding is no change: the host picks its group as it starts it.
    expect(w.changes).toEqual([])
    w.watch.watch([])
    vi.advanceTimersByTime(60_000)
    expect(w.reads()).toBe(1)
    expect(w.watch.usable('Mihomo')).toBeNull()
  })

  it('reports an interface that goes within one interval, and once', () => {
    vi.useFakeTimers()
    const w = watching(['Mihomo', 'WLAN'])
    w.watch.watch(['Mihomo', 'WLAN'])
    w.set(['WLAN'])
    vi.advanceTimersByTime(2_500)
    expect(w.changes).toEqual([{ gone: ['Mihomo'], back: [] }])
    expect(w.watch.usable('Mihomo')).toBe(false)
    expect(w.watch.usable('WLAN')).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(w.changes).toHaveLength(1)
  })

  it('reports it back once it returns, and only interfaces it watches', () => {
    vi.useFakeTimers()
    const w = watching(['WLAN'])
    w.watch.watch(['Mihomo'])
    expect(w.watch.usable('Mihomo')).toBe(false)
    w.set(['WLAN', 'Mihomo', 'Other'])
    vi.advanceTimersByTime(2_500)
    expect(w.changes).toEqual([{ gone: [], back: ['Mihomo'] }])
    w.set(['Mihomo'])
    vi.advanceTimersByTime(2_500)
    expect(w.changes).toHaveLength(1)
    expect(w.watch.usable('Mihomo')).toBe(true)
  })

  it('knows nothing while the read fails, and reports what changed meanwhile once it works', () => {
    vi.useFakeTimers()
    const w = watching(['Mihomo'])
    w.watch.watch(['Mihomo'])
    w.set(null)
    vi.advanceTimersByTime(2_500)
    expect(w.watch.usable('Mihomo')).toBeNull()
    expect(w.changes).toEqual([])
    w.set([])
    vi.advanceTimersByTime(2_500)
    expect(w.changes).toEqual([{ gone: ['Mihomo'], back: [] }])
    expect(w.watch.usable('Mihomo')).toBe(false)
  })

  it('forgets an interface no agent is bound to any more', () => {
    vi.useFakeTimers()
    const w = watching(['Mihomo', 'WLAN'])
    w.watch.watch(['Mihomo', 'WLAN'])
    w.watch.watch(['WLAN'])
    w.set(['WLAN'])
    vi.advanceTimersByTime(2_500)
    expect(w.changes).toEqual([])
    expect(w.watch.usable('Mihomo')).toBeNull()
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
    // An agent bound to an interface gets its own listener just the same, and nothing else.
    service.setNodeRoutes((agentId) => (agentId === 'claude-code' ? 30002 : null))
    const bound = service.agentEnv('claude-code' as AgentId)
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
      expect(bound[name]).toBe('http://127.0.0.1:30002')
    }
    expect(JSON.stringify(bound)).not.toContain('corp:8080')
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

describe('the agent network state file', () => {
  it('keeps the interfaces’ mihomo processes to stop after a crash, and drops odd entries', () => {
    const record = { pid: 42, controllerPort: 40000, secret: 'a'.repeat(48) }
    const parsed = parseNetworkStateFile({
      ports: {},
      running: record,
      sides: [record, { pid: -1, controllerPort: 40001, secret: 'b'.repeat(48) }, 'x'],
      subscriptions: {},
    })
    expect(parsed).toMatchObject({ running: record, sides: [record] })
    expect(parseNetworkStateFile({ ports: {}, running: null })).toMatchObject({ sides: [] })
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
      listInterfaces: async () => INTERFACES,
      download: async () => served(NODES_YAML),
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
    expect(state).not.toContain('sub.example.net')
    // The nodes are mihomo's to read, in a file of their own; no address goes with them.
    const nodes = await readFile(providerFile(dir, status.subscriptions[0]!.id), 'utf8')
    expect(nodes).toBe(NODES_YAML)
    expect(status.subscriptions[0]).toMatchObject({
      source: 'url',
      nodes: 1,
      usage: { upload: 10, download: 20, total: 1000, expire: 1767225600000 },
      error: null,
    })
    await service.shutdown()
  })

  it('adds a link only once it downloaded nodes, and keeps the last ones when a refresh fails', async () => {
    let answer: () => Promise<Downloaded> = async () => served(NODES_YAML)
    const urls: string[] = []
    const { dir, service } = await proxy(DEFAULT_AGENT_NETWORK, {
      download: async (url) => {
        urls.push(url)
        return answer()
      },
    })
    answer = async () => {
      throw new Error(`getaddrinfo ENOTFOUND for ${URL_WITH_TOKEN}`)
    }
    const failedAdd = await service.addSubscription('Airport', URL_WITH_TOKEN).catch((e) => e)
    expect(failedAdd).toMatchObject({ code: 'unavailable' })
    expect((failedAdd as Error).message).not.toContain(TOKEN)
    answer = async () => served('<html>please log in</html>')
    await expect(service.addSubscription('Airport', URL_WITH_TOKEN)).rejects.toThrow(/no nodes/)
    expect(service.status().subscriptions).toEqual([])

    answer = async () => served(NODES_YAML)
    const { id } = await service.addSubscription('Airport', URL_WITH_TOKEN)
    expect(urls.every((url) => url === URL_WITH_TOKEN)).toBe(true)
    const before = service.status().subscriptions[0]!
    expect(before.updatedAt).toEqual(expect.any(Number))

    for (const failure of [
      async () => served('<html>please log in</html>'),
      async (): Promise<Downloaded> => {
        throw new Error(`The provider answered 403 at ${URL_WITH_TOKEN}`)
      },
    ]) {
      answer = failure
      await expect(service.refresh(id)).rejects.toMatchObject({ code: 'unavailable' })
      expect(await readFile(providerFile(dir, id), 'utf8')).toBe(NODES_YAML)
      const after = service.status().subscriptions[0]!
      expect(after).toMatchObject({ nodes: 1, updatedAt: before.updatedAt, usage: before.usage })
      expect(after.error).toEqual(expect.any(String))
      expect(after.failedAt).toEqual(expect.any(Number))
      expect(JSON.stringify(service.status())).not.toContain(TOKEN)
    }
    answer = async () => served(NODE_LINKS, null)
    await service.refresh(null)
    expect(service.status().subscriptions[0]).toMatchObject({ nodes: 2, error: null, usage: null })
    await service.shutdown()
  })

  it('imports a file, never downloads it, and takes it again only by import', async () => {
    let downloads = 0
    const { dir, service } = await proxy(DEFAULT_AGENT_NETWORK, {
      download: async () => {
        downloads++
        return served(NODES_YAML)
      },
    })
    const encoded = Buffer.from(NODE_LINKS).toString('base64url')
    const { id } = await service.importSubscription('Mine', encoded)
    expect(Buffer.from(await readFile(providerFile(dir, id), 'utf8'), 'base64').toString()).toBe(
      NODE_LINKS,
    )
    expect(service.status().subscriptions[0]).toMatchObject({
      source: 'file',
      host: null,
      nodes: 2,
      usage: null,
    })
    await expect(service.refresh(id)).rejects.toMatchObject({ code: 'conflict' })
    await service.refresh(null)
    expect(downloads).toBe(0)

    await service.reimportSubscription(id, NODES_YAML)
    expect(await readFile(providerFile(dir, id), 'utf8')).toBe(NODES_YAML)
    expect(service.status().subscriptions[0]!.nodes).toBe(1)
    await expect(service.reimportSubscription(id, 'proxies: []')).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(service.importSubscription('Other', '<html></html>')).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(service.importSubscription('mine', NODES_YAML)).rejects.toMatchObject({
      code: 'conflict',
    })
    const linked = await service.addSubscription('Linked', URL_WITH_TOKEN)
    await expect(service.reimportSubscription(linked.id, NODES_YAML)).rejects.toMatchObject({
      code: 'conflict',
    })

    // The state survives the host: when, how many, the traffic, and no address.
    await service.shutdown()
    const again = new NodeProxy({
      userDataPath: dir,
      platform: 'linux',
      mihomoPath: null,
      log: () => {},
      subscriptions: subscriptionsFile(dir, () => {}),
      state: networkStateFile(dir, () => {}),
      settings: () => DEFAULT_AGENT_NETWORK,
      agentIds: () => [],
      changed: () => {},
      routesChanged: () => {},
    })
    await again.load()
    expect(again.status().subscriptions.map((s) => [s.name, s.source, s.nodes])).toEqual([
      ['Mine', 'file', 1],
      ['Linked', 'url', 1],
    ])
    await again.removeSubscription(id)
    await expect(readFile(providerFile(dir, id), 'utf8')).rejects.toThrow()
    await again.shutdown()
  })

  it('shows a device names, counts, choices and exits, and never an address or token', async () => {
    const settings: AgentNetworkSettings = {
      ...DEFAULT_AGENT_NETWORK,
      enabled: true,
      agents: { codex: 'system' },
    }
    let failing = false
    const { service } = await proxy(settings, {
      systemProxy: () => ({ proxy: null, noProxy: null }),
      trace: async () => 'ip=198.51.100.9\nloc=DE\n',
      download: async (url) => {
        if (failing) throw new Error(`Could not reach sub host for ${url}`)
        return served(NODES_YAML)
      },
    })
    service.start()
    const first = await service.addSubscription('Airport', URL_WITH_TOKEN)
    const other = await service.addSubscription('Other', PATH_TOKEN_URL)
    await service.importSubscription('From file', NODE_LINKS)
    // A failed refresh leaves an error in the window's status, never in the device's.
    failing = true
    await expect(service.refresh(other.id)).rejects.toThrow()
    expect(service.status().subscriptions[1]!.error).toEqual(expect.any(String))
    settings.defaultNode = { subscription: first.id, node: 'JP 01' }
    settings.agents = { codex: 'system', 'claude-code': { subscription: first.id, node: 'US' } }
    await service.exitIp('codex' as AgentId)
    await service.exitIp('claude-code' as AgentId)

    const status = await service.deviceStatus()
    const json = JSON.stringify(status)
    for (const secret of [
      TOKEN,
      URL_WITH_TOKEN,
      PATH_TOKEN_URL,
      'sub.example.net',
      'airport.example.org',
      '/api/v1',
      'https://',
      'token=',
      'Could not reach',
      'trojan://',
    ]) {
      expect(json).not.toContain(secret)
    }
    expect(Object.keys(status).sort()).toEqual([
      'agents',
      'available',
      'defaultNode',
      'enabled',
      'exits',
      'interface',
      'interfaces',
      'nodes',
      'problem',
      'state',
      'subscriptions',
    ])
    for (const sub of status.subscriptions) {
      expect(Object.keys(sub).sort()).toEqual(['id', 'name', 'nodes', 'usage'])
    }
    // Names and states of the interfaces alone.
    expect(status.interfaces).toEqual([
      { name: 'Meta', up: true, tunnel: true },
      { name: 'eth0', up: true, tunnel: false },
      { name: 'wlan0', up: false, tunnel: false },
    ])
    expect(status.subscriptions.map((s) => s.name)).toEqual(['Airport', 'Other', 'From file'])
    expect(status.subscriptions[0]!.usage).toMatchObject({ total: 1000 })
    expect(status.defaultNode).toEqual({ subscription: first.id, node: 'JP 01' })
    expect(status.agents).toEqual([
      { agentId: 'claude-code', choice: { subscription: first.id, node: 'US' } },
      { agentId: 'codex', choice: 'system' },
    ])
    expect(status.exits.map((e) => [e.agentId, e.via, e.ip])).toEqual([
      ['claude-code', 'node', '198.51.100.9'],
      ['codex', 'system', '198.51.100.9'],
    ])
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

  it('sends an agent bound to an interface through its own listener alone, and fails closed', async () => {
    const hops: (ProxyHop | null)[] = []
    const settings: AgentNetworkSettings = {
      ...DEFAULT_AGENT_NETWORK,
      enabled: true,
      agents: { 'claude-code': { interface: 'Meta' }, codex: 'system' },
    }
    const { service } = await proxy(settings, {
      trace: async (hop) => {
        hops.push(hop)
        throw new Error('connect ECONNREFUSED')
      },
    })
    service.start()
    const listener = service.portFor('claude-code' as AgentId)
    expect(listener).toEqual(expect.any(Number))
    expect(service.portFor('codex' as AgentId)).toBeNull()
    const exit = await service.exitIp('claude-code' as AgentId)
    expect(hops).toEqual([{ host: '127.0.0.1', port: listener, auth: null }])
    expect(exit).toMatchObject({ via: 'interface', ip: null, failure: 'unreachable' })
    expect(service.status().agents).toEqual([
      { agentId: 'claude-code', port: listener, node: null, interface: 'Meta' },
    ])
    expect(await service.interfaces()).toEqual(INTERFACES)
    expect(service.status().interfaces).toEqual(INTERFACES)
    // Without mihomo it has no network at all, as an agent on a node has none.
    expect(service.status()).toMatchObject({ state: 'error', problem: 'missing' })
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
