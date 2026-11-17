// The phone's relay of a page's capability messages, as the web client's (src/renderer/src/web/
// runtime-relay.ts): each goes to the computer through a frame the remote host opens for this
// connection (`artifacts.openFrame`), and the computer checks it as it checks any device's. The
// relay reads only a message's kind, capability and id, to route answers, and never acts on one.
//
// `files` and `sample` read what lies outside the artifact, so the desktop gives them only to a page
// loaded under the strict policy, without the CDNs (src/remote-host/server.ts, `frame.lax`). The
// phone cannot tell whether a version is strict (`artifacts.content` is the remote host's alone),
// and loads every page with the CDNs, so it answers those two itself, as a lax frame is answered,
// and the viewer says the page needs the computer.

import type { HostEvent } from '@shared/agent-host'
import {
  errorAnswer,
  isCapabilityKind,
  isRuntimeAnswer,
  messageHeader,
  RUNTIME_VERSION,
  type RuntimeAnswer,
} from '@shared/artifact-capabilities'
import type { HostLink } from '@shared/remote/link'

const FRAME_PATH = /^\/frame\/[A-Za-z0-9_-]{43}\/$/
const DESKTOP_ONLY = new Set(['files', 'sample'])

let relays = 0

export class RuntimeRelay {
  private readonly relay = ++relays
  private readonly streams = new Set<string>()
  private frame: Promise<string> | null = null
  private closed = false
  private readonly offEvents: () => void

  constructor(
    private readonly link: HostLink,
    private readonly artifactId: string,
    private readonly post: (answer: RuntimeAnswer) => void,
    private readonly desktopOnly: () => void,
  ) {
    this.offEvents = link.onHostEvent((value) => {
      const event = value as HostEvent
      if (event.type !== 'artifacts.runtime' || !this.streams.has(event.stream)) return
      if (isRuntimeAnswer(event.answer)) this.answer(event.answer)
    })
  }

  /** A capability message the page posted; anything else is not the relay's. */
  handle(message: unknown): void {
    if (this.closed) return
    const { kind, cap } = (message ?? {}) as { kind?: unknown; cap?: unknown }
    if (!isCapabilityKind(kind)) return
    const header = messageHeader(message)
    if (typeof cap === 'string' && DESKTOP_ONLY.has(cap)) {
      this.desktopOnly()
      if (kind === 'use') this.answer({ ...header, ok: true, value: null })
      else if (kind !== 'cancel') {
        this.answer(
          errorAnswer(header, 'not_allowed', 'Open the artifact on the computer to use this.'),
        )
      }
      return
    }
    if (kind === 'cancel') {
      const stream = `${this.relay}:${header.id}`
      if (this.streams.delete(stream)) void this.send(message, stream)
      return
    }
    if (kind !== 'stream') {
      void this.send(message).then((answer) => this.answer(answer))
      return
    }
    const stream = `${this.relay}:${header.id}`
    this.streams.add(stream)
    void this.send(message, stream).then((last) => {
      if (this.streams.delete(stream)) this.answer(last)
    })
  }

  close(): void {
    if (this.closed) return
    for (const stream of this.streams) {
      const id = stream.slice(stream.indexOf(':') + 1)
      void this.send({ v: RUNTIME_VERSION, id, kind: 'cancel' }, stream, true)
    }
    this.streams.clear()
    this.closed = true
    this.offEvents()
    const frame = this.frame
    this.frame = null
    void frame?.then((path) => this.link.request('artifacts.closeFrame', { path })).catch(() => {})
  }

  private answer(answer: RuntimeAnswer): void {
    if (!this.closed) this.post(answer)
  }

  private open(): Promise<string> {
    if (!this.frame) {
      const frame = this.link
        .request('artifacts.openFrame', { id: this.artifactId })
        .then((result) => {
          const path = (result as { path?: unknown } | null)?.path
          if (typeof path !== 'string' || !FRAME_PATH.test(path)) {
            throw new Error('The computer named no frame')
          }
          return path
        })
      frame.catch(() => {
        if (this.frame === frame) this.frame = null
      })
      this.frame = frame
    }
    return this.frame
  }

  private async send(
    message: unknown,
    stream?: string,
    closing = false,
    again = false,
  ): Promise<RuntimeAnswer> {
    const failed = errorAnswer(messageHeader(message), 'failed', 'The computer did not answer.')
    if (this.closed && !closing) return failed
    try {
      const frame = this.open()
      const path = await frame
      const answer = await this.link.request('artifacts.frameRuntime', {
        path,
        message,
        ...(stream === undefined ? {} : { stream }),
      })
      if (!isRuntimeAnswer(answer)) return failed
      return answer
    } catch (error) {
      // The computer closes a connection's oldest frames as it opens more: open this one again.
      if (!again && (error as { code?: unknown } | null)?.code === 'not_found') {
        this.frame = null
        return this.send(message, stream, closing, true)
      }
      return failed
    }
  }
}
