// Huli: the mini window (小窗), a small window over the others that follows one session: its status,
// its last reply's line and a box to reply in. Its page gets only what `src/preload/mini.ts`
// exposes, the agent host's methods below among them, and main takes from it only its own channels.

import type { HostMethod, HostParams, HostResult, AgentsApi } from './agent-host'
import type { KettuApi } from './ipc'

/** The agent host's methods the mini window's page may ask. */
export const MINI_HOST_METHODS = [
  'sessions.list',
  'sessions.snapshot',
  'sessions.queue',
] as const satisfies readonly HostMethod[]

export type MiniHostMethod = (typeof MINI_HOST_METHODS)[number]

/** The session the mini window follows, as main tells its page. */
export interface MiniTarget {
  sessionId: string
}

const SESSION_ID_MAX_CHARS = 256

export function isMiniSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SESSION_ID_MAX_CHARS &&
    !value.includes('\0')
  )
}

/** What the mini window's preload exposes as `window.kettu`. */
export interface MiniWindowApi {
  platform: KettuApi['platform']
  client: 'desktop'
  systemLocale: KettuApi['systemLocale']
  settings: Pick<KettuApi['settings'], 'get' | 'onChanged'>
  themes: Pick<KettuApi['themes'], 'get' | 'onChanged'>
  agents: Pick<AgentsApi, 'onEvent' | 'onConnection'> & {
    request<M extends MiniHostMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>>
  }
  mini: {
    /** The session to follow, now and whenever main changes it. */
    onTarget(listener: (target: MiniTarget) => void): () => void
    /** Brings the session up in Kite's main window. */
    showSession(): void
    close(): void
  }
}
