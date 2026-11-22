// Huli: the ports of other hosts forwarded to this computer, for a session's browser or a host's
// page. The host grants each port this computer asks for on its session, and lists its listening
// ports when asked; the remote host's link listens on this computer's loopback and carries every
// connection over that session's encrypted channel. A forward goes with its session, with the
// host's session, or when the user stops it. Nothing here runs until the user asks for a forward.

import {
  ForwardBook,
  devPorts,
  isPort,
  parsePortFolders,
  parsePortList,
  type ForwardResult,
  type PortForward,
  type PortListResult,
} from '@shared/port-forwards'
import { DEVICE_ID } from '@shared/remote/device'

/** The longest session id a forward names, as the IPC's session ids are. */
const MAX_SCOPE_CHARS = 256

export interface PortForwardsDeps {
  /** Main's own request to the host, answered; rejects with the host's error. */
  call(hostId: string, method: string, params: unknown): Promise<unknown>
  /** Main's own request to the host whose answer goes unread; false while it is not connected. */
  request(hostId: string, method: string, params: unknown): boolean
  /** A port on this computer's loopback reaching `port` on the host, `port` itself when free. */
  listen(hostId: string, scope: string, port: number): Promise<number | null>
  stopListening(hostId: string, scope: string, port: number): void
  changed(forwards: PortForward[]): void
  now?(): number
}

/** The IPC's arguments for a forward, checked; throws on what is none. */
export function forwardArgs(
  id: unknown,
  port: unknown,
  sessionId: unknown,
): { hostId: string; port: number; sessionId: string | null } {
  if (typeof id !== 'string' || !DEVICE_ID.test(id)) throw new Error('Not a host id')
  if (!isPort(port)) throw new Error('A port is a whole number from 1 to 65535')
  if (
    sessionId !== null &&
    (typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > MAX_SCOPE_CHARS ||
      sessionId.includes('\0'))
  ) {
    throw new Error('A forward is for a session id or for none')
  }
  return { hostId: id, port, sessionId }
}

/** The folders a listing asks about, checked; throws on what are none. */
export function folderArgs(value: unknown): string[] {
  const folders = parsePortFolders(value)
  if (!folders) throw new Error('The folders are a list of up to 200 paths')
  return folders
}

const codeOf = (error: unknown): string | null =>
  typeof error === 'object' &&
  error !== null &&
  typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null

/** Why a host refused, as the window words it. */
function failureOf(error: unknown): 'offline' | 'unsupported' | 'failed' {
  const code = codeOf(error)
  if (code === 'host_offline' || code === 'host_restarted') return 'offline'
  // A host older than port forwarding hands the call to its agent host, which knows it not.
  if (code === 'unknown_method') return 'unsupported'
  return 'failed'
}

export class PortForwards {
  private readonly book = new ForwardBook()
  /** Forwards being made, so a second ask for one waits for the first. */
  private readonly starting = new Map<string, Promise<ForwardResult>>()

  constructor(private readonly deps: PortForwardsDeps) {}

  list(): PortForward[] {
    return this.book.list()
  }

  /** The host's listening ports, its programs in `folders` first. */
  async ports(hostId: string, folders: string[]): Promise<PortListResult> {
    let answer: unknown
    try {
      answer = await this.deps.call(hostId, 'ports.list', { folders })
    } catch (error) {
      return { ok: false, reason: failureOf(error) }
    }
    const list = parsePortList(answer)
    if (!list?.ports) return { ok: false, reason: 'failed' }
    return { ok: true, ports: devPorts(list.ports) }
  }

  /** Forwards the host's `port` for the session, or for the host's page with none. */
  forward(
    hostId: string,
    port: number,
    sessionId: string | null,
    auto: boolean,
    process: string | null = null,
  ): Promise<ForwardResult> {
    // One listener a port of the host serves every session, and the host's page.
    const known = this.book.get(hostId, sessionId, port) ?? this.book.anyFor(hostId, port)
    if (known) return Promise.resolve({ ok: true, forward: known })
    const key = `${hostId}\n${sessionId ?? ''}\n${port}`
    const pending = this.starting.get(key)
    if (pending) return pending
    const start = this.start(hostId, port, sessionId, auto, process).finally(() =>
      this.starting.delete(key),
    )
    this.starting.set(key, start)
    return start
  }

  /** The user stopped a forward. */
  stop(hostId: string, port: number, sessionId: string | null): void {
    const removed = this.book.remove(hostId, sessionId, port)
    if (!removed) return
    this.release(removed)
    this.deps.changed(this.book.list())
  }

  /** The host's session ended, which closed its listeners and the host's grants. */
  hostEnded(hostId: string): void {
    if (this.book.removeHost(hostId).length > 0) this.deps.changed(this.book.list())
  }

  /** The session's page went, which closed its listeners on that host. */
  sessionClosed(hostId: string, sessionId: string): void {
    const removed = this.book.removeSession(sessionId, hostId)
    for (const item of removed) this.unforward(item)
    if (removed.length > 0) this.deps.changed(this.book.list())
  }

  /** The sessions the window still lists; the forwards of the others stop. */
  keepSessions(sessionIds: readonly string[]): void {
    const removed = this.book.keepSessions(new Set(sessionIds))
    for (const item of removed) this.release(item)
    if (removed.length > 0) this.deps.changed(this.book.list())
  }

  private async start(
    hostId: string,
    port: number,
    sessionId: string | null,
    auto: boolean,
    process: string | null,
  ): Promise<ForwardResult> {
    if (!this.book.hasRoom(hostId)) return { ok: false, reason: 'full' }
    const scope = sessionId ?? ''
    try {
      await this.deps.call(hostId, 'ports.forward', { scope, port })
    } catch (error) {
      const reason = failureOf(error)
      return { ok: false, reason: codeOf(error) === 'busy' ? 'full' : reason }
    }
    const localPort = await this.deps.listen(hostId, scope, port)
    if (localPort === null) {
      this.deps.request(hostId, 'ports.unforward', { scope, port })
      return { ok: false, reason: 'failed' }
    }
    const forward: PortForward = {
      hostId,
      sessionId,
      port,
      localPort,
      process,
      auto,
      at: this.deps.now?.() ?? Date.now(),
    }
    this.book.add(forward)
    this.deps.changed(this.book.list())
    return { ok: true, forward }
  }

  private release(item: PortForward): void {
    this.deps.stopListening(item.hostId, item.sessionId ?? '', item.port)
    this.unforward(item)
  }

  private unforward(item: PortForward): void {
    this.deps.request(item.hostId, 'ports.unforward', {
      scope: item.sessionId ?? '',
      port: item.port,
    })
  }
}
