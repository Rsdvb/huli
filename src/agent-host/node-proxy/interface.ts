// The physical network interface of the default route: the one a node must dial out on so its
// traffic never enters a TUN that a proxy client or VPN set up. Read with the system's own tools,
// asynchronously, in the agent host.

import { execFile } from 'node:child_process'
import type { Platform } from '@shared/platform'

/** Names and descriptions of virtual adapters, whose route is never the physical one. */
const VIRTUAL =
  /wintun|\btun\b|tun\d|utun|\btap\b|tap-windows|meta|mihomo|clash|karing|sing-?box|tailscale|wireguard|\bwg\d*|zerotier|hyper-v|vethernet|vmware|virtualbox|vbox|loopback|docker|podman|\bbr-|veth|virbr|bridge|awdl|llw|ipsec|ppp|gif\d|stf\d|^lo\d*$|\bnordlynx|openvpn|anyconnect|cisco|fortinet|v2ray|xray|hiddify|nekoray|stash|surge|shadowrocket|loon|quantumult/i

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

const WINDOWS_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Get-NetRoute -AddressFamily IPv4 -DestinationPrefix 0.0.0.0/0 | ForEach-Object {',
  '  $a = Get-NetAdapter -InterfaceIndex $_.ifIndex',
  '  $i = Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily IPv4',
  '  if ($a) { [pscustomobject]@{ name = $a.Name; description = $a.InterfaceDescription;',
  '    status = [string]$a.Status; metric = [int]$_.RouteMetric + [int]$i.InterfaceMetric } }',
  '} | ConvertTo-Json -Compress',
].join('\n')

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

/** The interface of the default route that is no virtual adapter; null when none is found. */
export async function detectInterface(platform: Platform): Promise<string | null> {
  if (platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    const powershell = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const out = await run(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_SCRIPT,
    ])
    return pickInterface(parseWindowsRoutes(out))
  }
  if (platform === 'darwin') {
    return pickInterface(parseMacRoutes(await run('/usr/sbin/netstat', ['-rn', '-f', 'inet'])))
  }
  const ip = await run('/usr/sbin/ip', ['-4', 'route', 'show', 'default']).catch(() =>
    run('/sbin/ip', ['-4', 'route', 'show', 'default']),
  )
  return pickInterface(parseLinuxRoutes(ip))
}
