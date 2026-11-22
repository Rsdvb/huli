// Forwarding a dev server's port on another host, such as one added over SSH, to this computer,
// so the session's browser opens it. The host lists the ports its user's programs listen on; a
// forward is a listener on this computer's loopback whose connections go to the host over the
// encrypted channel the host's session already runs on, never a new SSH process.

/** A port a program listens on, on the host. */
export interface ListeningPort {
  port: number
  /** The address it listens on, as the host wrote it: 127.0.0.1, ::1, 0.0.0.0, :: or another. */
  address: string
  pid: number | null
  /** The program's name, such as `node` or `vite`; null when the host could not tell. */
  process: string | null
  /** The folder of the ones asked about that its program runs in; null for none of them. */
  folder: string | null
}

/** What `ports.list` answers: the ports, or null when the host cannot list them. */
export interface PortList {
  ports: ListeningPort[] | null
}

/** A port of the host forwarded to this computer. */
export interface PortForward {
  hostId: string
  /** The session whose browser or terminal it is for; null for the host page's own. */
  sessionId: string | null
  /** The port on the host. */
  port: number
  /** The port on this computer's 127.0.0.1 that reaches it. */
  localPort: number
  /** What listens there, when the list named it. */
  process: string | null
  /** Made on its own, for an address a terminal of the session printed. */
  auto: boolean
  at: number
}

/** Why a forward did not start. */
export type ForwardFailure =
  /** The host's session is not open. */
  | 'offline'
  /** Kite on the host is older than port forwarding. */
  | 'unsupported'
  /** The host has as many forwards for this computer as it keeps. */
  | 'full'
  /** No port on this computer could listen. */
  | 'failed'

export type ForwardResult =
  { ok: true; forward: PortForward } | { ok: false; reason: ForwardFailure }

/** The most ports one listing names, and folders it is asked about. */
export const MAX_LISTED_PORTS = 200
export const MAX_PORT_FOLDERS = 200
export const MAX_FOLDER_CHARS = 4096
/** The most forwards this computer keeps to one host. */
export const MAX_HOST_FORWARDS = 32
/** Ports at or below this are the system's; a dev server listens above it. */
export const SYSTEM_PORTS = 1024

const MAX_PROCESS_CHARS = 128
const MAX_ADDRESS_CHARS = 64

export const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65_536

const isPid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 2 ** 32

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A host's answer to `ports.list`, checked and cut to size; null when it is none. */
export function parsePortList(value: unknown): PortList | null {
  if (!isRecord(value)) return null
  if (value.ports === null) return { ports: null }
  if (!Array.isArray(value.ports)) return null
  const ports: ListeningPort[] = []
  const seen = new Set<number>()
  for (const item of value.ports) {
    if (ports.length >= MAX_LISTED_PORTS) break
    if (!isRecord(item) || !isPort(item.port) || seen.has(item.port)) continue
    if (typeof item.address !== 'string' || item.address.length > MAX_ADDRESS_CHARS) continue
    seen.add(item.port)
    ports.push({
      port: item.port,
      address: item.address,
      pid: isPid(item.pid) ? item.pid : null,
      process:
        typeof item.process === 'string' && item.process.length > 0
          ? item.process.slice(0, MAX_PROCESS_CHARS)
          : null,
      folder:
        typeof item.folder === 'string' && item.folder.length <= MAX_FOLDER_CHARS
          ? item.folder
          : null,
    })
  }
  return { ports }
}

/** The folders a listing is asked about, as a window or device names them; null when not so. */
export function parsePortFolders(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PORT_FOLDERS) return null
  const folders: string[] = []
  for (const folder of value) {
    if (typeof folder !== 'string' || folder.length === 0 || folder.length > MAX_FOLDER_CHARS) {
      return null
    }
    if (folder.includes('\0')) return null
    if (!folders.includes(folder)) folders.push(folder)
  }
  return folders
}

/**
 * The ports in a listing worth showing first: those of programs in the folders asked about, then
 * the rest, each by port. Ports at or below SYSTEM_PORTS are left out.
 */
export function devPorts(ports: readonly ListeningPort[]): ListeningPort[] {
  return ports
    .filter((entry) => entry.port > SYSTEM_PORTS)
    .sort((a, b) => Number(b.folder !== null) - Number(a.folder !== null) || a.port - b.port)
}

/** The port of an address on its own computer's loopback, as a terminal prints a dev server's. */
export function loopbackPort(url: string): number | null {
  const parsed = URL.parse(url)
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null
  const name = parsed.hostname.toLowerCase()
  if (name !== 'localhost' && name !== '127.0.0.1' && name !== '0.0.0.0' && name !== '[::1]') {
    return null
  }
  const port = parsed.port === '' ? null : Number(parsed.port)
  return port !== null && isPort(port) ? port : null
}

/** `url`, an address on the host's loopback, at the forward's port on this computer. */
export function forwardedAddress(url: string, localPort: number): string | null {
  const parsed = URL.parse(url)
  if (!parsed || loopbackPort(url) === null) return null
  // The forward listens on 127.0.0.1, which localhost reaches as a browser resolves it.
  parsed.hostname = 'localhost'
  parsed.port = String(localPort)
  return parsed.href
}

const keyOf = (hostId: string, sessionId: string | null, port: number): string =>
  `${hostId}\n${sessionId ?? ''}\n${port}`

/**
 * The forwards this computer keeps, one for each host, session (or none) and port. A session's
 * forward goes with the session, and every forward to a host goes with its session.
 */
export class ForwardBook {
  private readonly items = new Map<string, PortForward>()

  list(): PortForward[] {
    return [...this.items.values()].sort((a, b) => a.at - b.at || a.port - b.port)
  }

  get(hostId: string, sessionId: string | null, port: number): PortForward | null {
    return this.items.get(keyOf(hostId, sessionId, port)) ?? null
  }

  /** A forward of the port to any session of the host, the host page's first. */
  anyFor(hostId: string, port: number): PortForward | null {
    let found: PortForward | null = null
    for (const item of this.items.values()) {
      if (item.hostId !== hostId || item.port !== port) continue
      if (item.sessionId === null) return item
      found ??= item
    }
    return found
  }

  /** Whether the host has room for another forward. */
  hasRoom(hostId: string): boolean {
    let count = 0
    for (const item of this.items.values()) if (item.hostId === hostId) count++
    return count < MAX_HOST_FORWARDS
  }

  /** Keeps `forward`, in place of one of the same host, session and port. */
  add(forward: PortForward): void {
    this.items.set(keyOf(forward.hostId, forward.sessionId, forward.port), forward)
  }

  remove(hostId: string, sessionId: string | null, port: number): PortForward | null {
    const key = keyOf(hostId, sessionId, port)
    const item = this.items.get(key) ?? null
    this.items.delete(key)
    return item
  }

  /** The host's session ended: its forwards go, and are answered. */
  removeHost(hostId: string): PortForward[] {
    return this.removeWhere((item) => item.hostId === hostId)
  }

  /** The session is gone, from this host or from every host. */
  removeSession(sessionId: string, hostId?: string): PortForward[] {
    return this.removeWhere(
      (item) => item.sessionId === sessionId && (hostId === undefined || item.hostId === hostId),
    )
  }

  /** The forwards of sessions no longer in `live`; the host pages' stay. */
  keepSessions(live: ReadonlySet<string>): PortForward[] {
    return this.removeWhere((item) => item.sessionId !== null && !live.has(item.sessionId))
  }

  private removeWhere(test: (item: PortForward) => boolean): PortForward[] {
    const removed: PortForward[] = []
    for (const [key, item] of [...this.items]) {
      if (!test(item)) continue
      this.items.delete(key)
      removed.push(item)
    }
    return removed
  }
}
