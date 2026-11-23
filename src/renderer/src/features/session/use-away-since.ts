import { useAwaySince } from '@renderer/stores/hosts'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'

/** `useAwaySince` of a session's host: undefined for no session (null) or one on this computer. */
export function useSessionAwaySince(sessionId: string | null): number | null | undefined {
  const hostId = useSessionsStore((s) => {
    const summary = sessionId === null ? undefined : s.byId[sessionId]
    return summary ? hostOfSession(summary) : null
  })
  return useAwaySince(hostId)
}
