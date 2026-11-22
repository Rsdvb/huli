// The TCP ports this host's user's programs listen on, for a device that forwards one to its own
// browser: on Linux from /proc, on macOS from lsof, on Windows from netstat. Read only when a
// device asks, never on a timer. Each program's folder is named when it is under one the device
// asked about, so a session's dev server shows first.

import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { MAX_LISTED_PORTS, SYSTEM_PORTS, type ListeningPort } from '@shared/port-forwards'

const run = promisify(execFile)

/** How long a listing program may take. */
const LIST_TIMEOUT_MS = 5_000
/** The most processes whose sockets Linux's listing reads. */
const MAX_PROCESSES = 4_000

/** A socket in LISTEN state from /proc/net/tcp or tcp6. */
export interface ProcListener {
  address: string
  port: number
  uid: number
  inode: number
}

/** An IPv4 address as /proc writes it: eight hex digits, the bytes in the machine's order. */
function procIPv4(hex: string): string {
  const bytes = [0, 2, 4, 6].map((at) => parseInt(hex.slice(at, at + 2), 16))
  return bytes.reverse().join('.')
}

/** An IPv6 address as /proc writes it: four words of eight hex digits, each little-endian. */
function procIPv6(hex: string): string {
  const groups: string[] = []
  for (let word = 0; word < 4; word++) {
    const part = hex.slice(word * 8, word * 8 + 8)
    const bytes = (part.match(/../g) ?? []).reverse().join('')
    groups.push(bytes.slice(0, 4), bytes.slice(4, 8))
  }
  const text = groups.map((group) => group.replace(/^0+(?=.)/, '').toLowerCase()).join(':')
  if (text === '0:0:0:0:0:0:0:0') return '::'
  if (text === '0:0:0:0:0:0:0:1') return '::1'
  return text.replace(/^0:0:0:0:0:ffff:/, '::ffff:')
}

/** The listening sockets of /proc/net/tcp or tcp6's text. */
export function parseProcNetTcp(text: string): ProcListener[] {
  const listeners: ProcListener[] = []
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || fields[3] !== '0A') continue
    const [hex, portHex] = fields[1]!.split(':')
    if (!hex || !portHex) continue
    const port = parseInt(portHex, 16)
    const uid = Number(fields[7])
    const inode = Number(fields[9])
    if (!Number.isInteger(port) || !Number.isInteger(uid) || !Number.isInteger(inode)) continue
    const address = hex.length === 8 ? procIPv4(hex) : hex.length === 32 ? procIPv6(hex) : null
    if (!address) continue
    listeners.push({ address, port, uid, inode })
  }
  return listeners
}

/** A listening socket lsof or netstat named, with the process that holds it. */
export interface ListedSocket {
  address: string
  port: number
  pid: number | null
  process: string | null
}

/** `127.0.0.1:3000`, `*:3000`, `[::1]:3000` or `[::]:3000`, as lsof and netstat write them. */
function splitAddress(text: string): { address: string; port: number } | null {
  const at = text.lastIndexOf(':')
  if (at < 0) return null
  const port = Number(text.slice(at + 1))
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536) return null
  let address = text.slice(0, at)
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  if (address === '*') address = '0.0.0.0'
  return { address, port }
}

/** The listening sockets of `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`'s output. */
export function parseLsof(text: string): ListedSocket[] {
  const sockets: ListedSocket[] = []
  let pid: number | null = null
  let command: string | null = null
  for (const line of text.split('\n')) {
    const kind = line[0]
    const value = line.slice(1).trim()
    if (kind === 'p') {
      pid = Number(value) || null
      command = null
    } else if (kind === 'c') command = value || null
    else if (kind === 'n') {
      const split = splitAddress(value.split('->')[0]!)
      if (split) sockets.push({ ...split, pid, process: command })
    }
  }
  return sockets
}

/** The listening sockets of `netstat -ano -p TCP` (and TCPv6)'s output, with their pids. */
export function parseNetstat(text: string): ListedSocket[] {
  const sockets: ListedSocket[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5 || !/^TCP/i.test(fields[0]!) || fields[3] !== 'LISTENING') continue
    const split = splitAddress(fields[1]!)
    const pid = Number(fields[4])
    if (split)
      sockets.push({ ...split, pid: Number.isInteger(pid) && pid > 0 ? pid : null, process: null })
  }
  return sockets
}

/** The image names of `tasklist /fo csv /nh`'s output, by pid. */
export function parseTasklist(text: string): Map<number, string> {
  const names = new Map<number, string>()
  for (const line of text.split('\n')) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim())
    if (match) names.set(Number(match[2]), match[1]!.replace(/\.exe$/i, ''))
  }
  return names
}

/** Whether `folder` is `inside` or a folder in it, compared as the platform does. */
export function isInside(folder: string, inside: string, platform = process.platform): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const norm = (value: string): string => {
    const resolved = paths.resolve(value)
    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved
  }
  const child = norm(folder)
  const parent = norm(inside)
  if (child === parent) return true
  const relative = paths.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !paths.isAbsolute(relative)
}

/** The first folder of `folders` that `cwd` is in, or null. */
function folderOf(cwd: string | null, folders: readonly string[]): string | null {
  if (!cwd) return null
  return folders.find((folder) => isInside(cwd, folder)) ?? null
}

export interface ListOptions {
  /** The folders whose programs show first. */
  folders: readonly string[]
  /** Processes whose ports never show, as Kite's own. */
  skipPids: ReadonlySet<number>
}

/**
 * The ports above SYSTEM_PORTS this host's user's programs listen on, one entry a port: the
 * loopback's or every interface's first. Null when this platform's listing failed.
 */
export async function listListeningPorts(options: ListOptions): Promise<ListeningPort[] | null> {
  try {
    const listed =
      process.platform === 'linux'
        ? await linuxPorts(options)
        : process.platform === 'win32'
          ? await windowsPorts()
          : await lsofPorts(options)
    return onePerPort(
      listed.filter((entry) => entry.port > SYSTEM_PORTS && !options.skipPids.has(entry.pid ?? -1)),
    ).slice(0, MAX_LISTED_PORTS)
  } catch {
    return null
  }
}

/** One entry a port, the one a forward to the loopback reaches. */
function onePerPort(ports: readonly ListeningPort[]): ListeningPort[] {
  const rank = (address: string): number =>
    address === '127.0.0.1' || address === '::1'
      ? 0
      : address === '0.0.0.0' || address === '::'
        ? 1
        : 2
  const byPort = new Map<number, ListeningPort>()
  for (const entry of ports) {
    const known = byPort.get(entry.port)
    if (!known || rank(entry.address) < rank(known.address)) {
      byPort.set(entry.port, { ...entry, process: entry.process ?? known?.process ?? null })
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}

async function linuxPorts({ folders }: ListOptions): Promise<ListeningPort[]> {
  const uid = process.getuid?.() ?? -1
  const tables = await Promise.all(
    ['/proc/net/tcp', '/proc/net/tcp6'].map((file) => readFile(file, 'utf8').catch(() => '')),
  )
  const listeners = tables.flatMap(parseProcNetTcp).filter((entry) => entry.uid === uid)
  if (listeners.length === 0) return []
  // Which process holds each socket: the user's processes' descriptors name it by inode.
  const wanted = new Map(listeners.map((entry) => [entry.inode, entry]))
  const owners = new Map<number, number>()
  const pids = (await readdir('/proc').catch(() => [] as string[]))
    .filter((name) => /^\d+$/.test(name))
    .slice(0, MAX_PROCESSES)
  await Promise.all(
    pids.map(async (pid) => {
      const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])
      for (const fd of fds) {
        if (owners.size === wanted.size) return
        const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')
        const match = /^socket:\[(\d+)\]$/.exec(link)
        if (match && wanted.has(Number(match[1]))) owners.set(Number(match[1]), Number(pid))
      }
    }),
  )
  return Promise.all(
    listeners.map(async (entry): Promise<ListeningPort> => {
      const pid = owners.get(entry.inode) ?? null
      const [name, cwd] = pid
        ? await Promise.all([
            readFile(`/proc/${pid}/comm`, 'utf8').then(
              (text) => text.trim() || null,
              () => null,
            ),
            readlink(`/proc/${pid}/cwd`).catch(() => null),
          ])
        : [null, null]
      return {
        port: entry.port,
        address: entry.address,
        pid,
        process: name,
        folder: folderOf(cwd, folders),
      }
    }),
  )
}

async function lsofPorts({ folders }: ListOptions): Promise<ListeningPort[]> {
  const user = String(process.getuid?.() ?? '')
  const args = ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn', ...(user ? ['-a', '-u', user] : [])]
  const { stdout } = await run('lsof', args, { timeout: LIST_TIMEOUT_MS, maxBuffer: 4 << 20 })
  const sockets = parseLsof(stdout)
  const pids = [...new Set(sockets.flatMap((entry) => (entry.pid ? [entry.pid] : [])))]
  const cwds = new Map<number, string>()
  if (pids.length > 0 && folders.length > 0) {
    // lsof exits 1 when some process went meanwhile, with the rest still written.
    const output = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], {
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 4 << 20,
    }).then(
      (result) => result.stdout,
      (error: { stdout?: string }) => error.stdout ?? '',
    )
    let pid = 0
    for (const line of output.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1))
      else if (line[0] === 'n' && pid) cwds.set(pid, line.slice(1))
    }
  }
  return sockets.map((entry) => ({
    port: entry.port,
    address: entry.address,
    pid: entry.pid,
    process: entry.process,
    folder: folderOf(entry.pid ? (cwds.get(entry.pid) ?? null) : null, folders),
  }))
}

async function windowsPorts(): Promise<ListeningPort[]> {
  const options = { timeout: LIST_TIMEOUT_MS, maxBuffer: 4 << 20, windowsHide: true }
  const [v4, v6, tasks] = await Promise.all([
    run('netstat', ['-ano', '-p', 'TCP'], options).then((r) => r.stdout),
    run('netstat', ['-ano', '-p', 'TCPv6'], options).then(
      (r) => r.stdout,
      () => '',
    ),
    run('tasklist', ['/fo', 'csv', '/nh'], options).then(
      (r) => r.stdout,
      () => '',
    ),
  ])
  const names = parseTasklist(tasks)
  return [...parseNetstat(v4), ...parseNetstat(v6)].map((entry) => ({
    port: entry.port,
    address: entry.address,
    pid: entry.pid,
    process: entry.pid ? (names.get(entry.pid) ?? null) : null,
    // Windows names no process's folder short of reading its memory.
    folder: null,
  }))
}
