// Huli: the chat bridge's own port to the agent host, in the same process. The host serves it as
// a paired device's, so every request takes the same validation and refusals as a phone's, and
// what it sends or answers is marked as coming from that chat app. See tools/huli/README.md (Chat
// apps).

import type { DeviceResult, HostMethod, HostParams } from '@shared/agent-host'
import type { PortChannel } from '@shared/port-channel'
import { PortRequestError, type FromPort, type ToPort } from '@shared/port-rpc'

export interface HostClient {
  request<M extends HostMethod>(method: M, params: HostParams<M>): Promise<DeviceResult<M>>
  close(): void
}

/** How long a request may take before the bridge stops waiting, as a phone's would. */
const REQUEST_TIMEOUT_MS = 60_000

/**
 * A client whose port `serve` hands the host. Messages cross in a later microtask each way, as
 * over a real port, so neither side runs inside the other's call. Events are dropped: the bridge
 * hears what it needs from the host's attention instead.
 */
export function localHostClient(
  serve: (channel: PortChannel<FromPort<unknown>>) => void,
): HostClient {
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
  >()
  let hostListener: ((data: unknown) => void) | null = null
  const waiting: unknown[] = []
  const closeListeners: (() => void)[] = []
  let closed = false
  let counter = 0

  const fromHost = (message: Exclude<FromPort<unknown>, { type: 'event' }>): void => {
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    clearTimeout(call.timer)
    if (message.type === 'response') call.resolve(message.result)
    else call.reject(new PortRequestError(message.error))
  }

  const close = (): void => {
    if (closed) return
    closed = true
    for (const [, call] of pending) {
      clearTimeout(call.timer)
      call.reject(new PortRequestError({ code: 'unavailable', message: 'The bridge closed' }))
    }
    pending.clear()
    for (const listener of closeListeners) listener()
  }

  serve({
    send: (message) => {
      if (!closed && message.type !== 'event') queueMicrotask(() => fromHost(message))
    },
    onMessage: (listener) => {
      hostListener = listener
      for (const message of waiting.splice(0)) queueMicrotask(() => listener(message))
    },
    onClose: (listener) => closeListeners.push(listener),
    close,
  })

  return {
    request: (method, params) => {
      if (closed) {
        return Promise.reject(new PortRequestError({ code: 'unavailable', message: 'Closed' }))
      }
      const id = ++counter
      const message: ToPort = { type: 'request', id, method, params }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new PortRequestError({ code: 'timeout', message: `${method} took too long` }))
        }, REQUEST_TIMEOUT_MS)
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
        if (hostListener) {
          const listener = hostListener
          queueMicrotask(() => listener(message))
        } else waiting.push(message)
      })
    },
    close,
  }
}
