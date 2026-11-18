// The physical network interface of the default route: the one a node must dial out on so its
// traffic never enters a TUN that a proxy client or VPN set up; and every interface of the
// computer, which an agent may be bound to. Read with the system's own tools, asynchronously, in
// the agent host.

import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import type { NetworkInterfaceView } from '@shared/agent-network'
import type { Platform } from '@shared/platform'

/** Names and descriptions of virtual adapters, whose route is never the physical one. */
const VIRTUAL =
  /wintun|\btun\b|tun\d|utun|\btap\b|tap-windows|meta|mihomo|clash|karing|sing-?box|tailscale|wireguard|\bwg\d*|zerotier|hyper-v|vethernet|vmware|virtualbox|vbox|loopback|docker|podman|\bbr-|veth|virbr|bridge|awdl|llw|ipsec|ppp|gif\d|stf\d|^lo\d*$|\bnordlynx|openvpn|anyconnect|cisco|fortinet|v2ray|xray|hiddify|nekoray|stash|surge|shadowrocket|loon|quantumult/i

/** Names and descriptions of the adapters a proxy client's TUN or a VPN sets up. */
const TUNNEL =
  /wintun|\btun\b|tun\d|utun|\btap\b|tap-windows|tunnel|mihomo|clash|karing|sing-?box|tailscale|wireguard|\bwg\d*\b|zerotier|nordlynx|openvpn|anyconnect|ipsec|\bppp\d*\b|v2ray|xray|hiddify|nekoray|stash|surge/i

export interface RouteCandidate {
  name: string
  description?: string
  metric: number
}

/** The candidate with the lowest metric that is no virtual adapter; null when none is. */
export function pickInterface(candidates: readonly RouteCandidate[]): string | null {
  const physical = candidates.filter(
    (c) => c.name && !VIRTUAL.test(c.name) && !VIRTUAL.test(c.description ?? ''),
  )
  physical.sort((a, b) => a.metric - b.metric)
  return physical[0]?.name ?? null
}

/** `ip -4 route show default` lines: `default via 192.168.1.1 dev eth0 proto dhcp metric 100`. */
export function parseLinuxRoutes(text: string): RouteCandidate[] {
  return text.split('\n').flatMap((line) => {
    const dev = /\bdev\s+(\S+)/.exec(line)
    if (!line.trim().startsWith('default') || !dev) return []
    const metric = /\bmetric\s+(\d+)/.exec(line)
    return [{ name: dev[1]!, metric: metric ? Number(metric[1]) : 0 }]
  })
}

/**
 * `netstat -rn -f inet` rows of the default route, `default 192.168.1.1 UGScg en0`: the unscoped
 * ones first, then the interface-scoped ones (the I flag), each in the table's order.
 */
export function parseMacRoutes(text: string): RouteCandidate[] {
  const rows = text.split('\n').flatMap((line) => {
    const cols = line.trim().split(/\s+/)
    if (cols[0] !== 'default' || cols.length < 4) return []
    return [{ name: cols[3]!, scoped: cols[2]!.includes('I') }]
  })
  // While a TUN holds the unscoped default, the physical interface keeps only a scoped one.
  return [...rows.filter((r) => !r.scoped), ...rows.filter((r) => r.scoped)].map((r, metric) => ({
    name: r.name,
    metric,
  }))
}

/** The PowerShell rows: the adapter of each IPv4 default route, with the route's whole metric. */
export function parseWindowsRoutes(text: string): RouteCandidate[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim() || '[]')
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row: unknown) => {
    if (typeof row !== 'object' || row === null) return []
    const o = row as Record<string, unknown>
    if (typeof o.name !== 'string' || o.status !== 'Up') return []
    return [
      {
        name: o.name,
        description: typeof o.description === 'string' ? o.description : '',
        metric: typeof o.metric === 'number' ? o.metric : 0,
      },
    ]
  })
}

// PowerShell writes in the console's code page unless told otherwise, which garbles a name such
// as 以太网.
const UTF8_OUTPUT = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'

const WINDOWS_SCRIPT = [
  UTF8_OUTPUT,
  '$ErrorActionPreference = "SilentlyContinue"',
  'Get-NetRoute -AddressFamily IPv4 -DestinationPrefix 0.0.0.0/0 | ForEach-Object {',
  '  $a = Get-NetAdapter -InterfaceIndex $_.ifIndex',
  '  $i = Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily IPv4',
  '  if ($a) { [pscustomobject]@{ name = $a.Name; description = $a.InterfaceDescription;',
  '    status = [string]$a.Status; metric = [int]$_.RouteMetric + [int]$i.InterfaceMetric } }',
  '} | ConvertTo-Json -Compress',
].join('\n')

const WINDOWS_ADAPTERS = [
  UTF8_OUTPUT,
  '$ErrorActionPreference = "SilentlyContinue"',
  '@(Get-NetAdapter | ForEach-Object { [pscustomobject]@{ name = $_.Name;',
  '  description = $_.InterfaceDescription; status = [string]$_.Status } }) |',
  '  ConvertTo-Json -Compress',
].join('\n')

function isTunnel(name: string, description: string | null): boolean {
  return TUNNEL.test(name) || TUNNEL.test(description ?? '')
}

/** Each name once, connected ones first, then by name. */
function byName(list: NetworkInterfaceView[]): NetworkInterfaceView[] {
  const seen = new Set<string>()
  const once = list.filter((item) => {
    if (item.name === '' || seen.has(item.name)) return false
    seen.add(item.name)
    return true
  })
  // By code point, the same on every computer whatever its locale.
  return once.sort(
    (a, b) => Number(b.up) - Number(a.up) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
}

/** `Get-NetAdapter` rows as JSON: Up is connected; Disconnected, Disabled and the rest are not. */
export function parseWindowsAdapters(text: string): NetworkInterfaceView[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim() || '[]')
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return byName(
    rows.flatMap((row: unknown) => {
      if (typeof row !== 'object' || row === null) return []
      const o = row as Record<string, unknown>
      if (typeof o.name !== 'string') return []
      const description =
        typeof o.description === 'string' && o.description !== '' ? o.description : null
      const up = o.status === 'Up'
      return [{ name: o.name, description, up, tunnel: isTunnel(o.name, description) }]
    }),
  )
}

/**
 * `ifconfig` blocks, `en0: flags=8863<UP,BROADCAST,...,RUNNING,...> mtu 1500` and an optional
 * `status: inactive`, with `networksetup -listallhardwareports`, which names the hardware ports.
 */
export function parseMacInterfaces(ifconfig: string, ports = ''): NetworkInterfaceView[] {
  const names = new Map<string, string>()
  let port: string | null = null
  for (const line of ports.split('\n')) {
    const hardware = /^Hardware Port:\s*(.+)$/.exec(line.trim())
    const device = /^Device:\s*(\S+)$/.exec(line.trim())
    if (hardware) port = hardware[1]!
    else if (device && port) names.set(device[1]!, port)
  }
  const blocks: { name: string; flags: string[]; inactive: boolean }[] = []
  for (const line of ifconfig.split('\n')) {
    const head = /^([^\s:]+):\s+flags=\d+<([^>]*)>/.exec(line)
    if (head) blocks.push({ name: head[1]!, flags: head[2]!.split(','), inactive: false })
    else if (blocks.length > 0 && /^\s+status:\s*inactive/.test(line)) {
      blocks[blocks.length - 1]!.inactive = true
    }
  }
  return byName(
    blocks
      .filter((b) => !b.flags.includes('LOOPBACK') && !/^(gif|stf)\d/.test(b.name))
      .map((b) => {
        const description = names.get(b.name) ?? null
        return {
          name: b.name,
          description,
          up: b.flags.includes('UP') && b.flags.includes('RUNNING') && !b.inactive,
          tunnel: isTunnel(b.name, description),
        }
      }),
  )
}

/** `ip -o link show` lines, `3: tun0: <POINTOPOINT,UP,LOWER_UP> mtu 1500 ... link/none`. */
export function parseLinuxLinks(text: string): NetworkInterfaceView[] {
  return byName(
    text.split('\n').flatMap((line) => {
      const m = /^\d+:\s+([^:@\s]+)(?:@\S+)?:\s+<([^>]*)>/.exec(line)
      if (!m) return []
      const flags = m[2]!.split(',')
      if (flags.includes('LOOPBACK')) return []
      const name = m[1]!
      return [
        {
          name,
          description: null,
          up: flags.includes('UP') && flags.includes('LOWER_UP'),
          tunnel: isTunnel(name, null) || /\blink\/none\b/.test(line),
        },
      ]
    }),
  )
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

function powershell(script: string): Promise<string> {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return run(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ])
}

/** The interface of the default route that is no virtual adapter; null when none is found. */
export async function detectInterface(platform: Platform): Promise<string | null> {
  if (platform === 'win32') {
    return pickInterface(parseWindowsRoutes(await powershell(WINDOWS_SCRIPT)))
  }
  if (platform === 'darwin') {
    return pickInterface(parseMacRoutes(await run('/usr/sbin/netstat', ['-rn', '-f', 'inet'])))
  }
  const ip = await run('/usr/sbin/ip', ['-4', 'route', 'show', 'default']).catch(() =>
    run('/sbin/ip', ['-4', 'route', 'show', 'default']),
  )
  return pickInterface(parseLinuxRoutes(ip))
}

/** Every network interface of the computer but loopback, connected ones first. */
export async function listInterfaces(platform: Platform): Promise<NetworkInterfaceView[]> {
  if (platform === 'win32') return parseWindowsAdapters(await powershell(WINDOWS_ADAPTERS))
  if (platform === 'darwin') {
    const [ifconfig, ports] = await Promise.all([
      run('/sbin/ifconfig', []),
      run('/usr/sbin/networksetup', ['-listallhardwareports']).catch(() => ''),
    ])
    return parseMacInterfaces(ifconfig, ports)
  }
  const links = await run('/usr/sbin/ip', ['-o', 'link', 'show']).catch(() =>
    run('/sbin/ip', ['-o', 'link', 'show']),
  )
  return parseLinuxLinks(links)
}

/**
 * The interfaces that can carry traffic now, cheaply, without a child process: Node's list holds
 * an interface only while it is up and has an address (libuv skips the rest), named as mihomo
 * names it: the adapter's friendly name on Windows, the device on macOS and Linux.
 */
export function presentInterfaces(): string[] {
  return Object.keys(networkInterfaces())
}

/** The loopback interface's name, which mihomo can always look up. */
export function loopbackInterface(platform: Platform): string {
  try {
    for (const [name, addresses] of Object.entries(networkInterfaces())) {
      if (addresses?.some((a) => a.internal && a.address === '127.0.0.1')) return name
    }
  } catch {
    // The usual name below.
  }
  if (platform === 'win32') return 'Loopback Pseudo-Interface 1'
  return platform === 'darwin' ? 'lo0' : 'lo'
}

export interface InterfaceChange {
  /** Watched interfaces that went away or down since the last read. */
  gone: string[]
  /** Watched interfaces that came back. */
  back: string[]
}

export interface InterfaceWatchOptions {
  /** The names of the interfaces up now; throws when it cannot tell. */
  read: () => Iterable<string>
  intervalMs: number
  changed: (change: InterfaceChange) => void
}

/**
 * Watches the interfaces agents are bound to with a cheap read every few seconds, only while
 * there are some, and reports each that goes or comes back once, against what the last read that
 * worked saw of it. While the read fails it knows nothing, and the host falls back on the
 * system's full list.
 */
export class InterfaceWatch {
  /** Each watched interface as last read: up or not. */
  private seen = new Map<string, boolean>()
  private failed = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: InterfaceWatchOptions) {}

  /** Watches these interfaces from now on, a new one read at once; none stops the reads. */
  watch(names: Iterable<string>): void {
    const next = new Set(names)
    for (const name of this.seen.keys()) if (!next.has(name)) this.seen.delete(name)
    if (next.size === 0) {
      this.stop()
      return
    }
    const added = [...next].filter((name) => !this.seen.has(name))
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.options.intervalMs)
      this.timer.unref?.()
    }
    if (added.length > 0) this.read(added)
  }

  /** Whether the interface was up at the last read; null when that read failed or none was made. */
  usable(name: string): boolean | null {
    return this.failed ? null : (this.seen.get(name) ?? null)
  }

  /** Reads now and reports what changed among the watched interfaces. */
  poll(): void {
    const change: InterfaceChange = { gone: [], back: [] }
    const present = this.present()
    if (!present) return
    for (const [name, was] of this.seen) {
      const up = present.has(name)
      if (up === was) continue
      this.seen.set(name, up)
      ;(up ? change.back : change.gone).push(name)
    }
    if (change.gone.length > 0 || change.back.length > 0) this.options.changed(change)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.seen.clear()
    this.failed = false
  }

  /** Learns the state of newly watched interfaces, which is no change. */
  private read(names: string[]): void {
    const present = this.present()
    for (const name of names) this.seen.set(name, present?.has(name) ?? true)
  }

  private present(): Set<string> | null {
    try {
      const present = new Set(this.options.read())
      this.failed = false
      return present
    } catch {
      this.failed = true
      return null
    }
  }
}
