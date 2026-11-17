// One session's thread as the phone shows it: the latest page from `sessions.open`, kept current
// by the host's patches while the screen watches it, with older pages read on demand. A gap in
// the patches, or a new connection, reads the snapshot again.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostEvent } from '@shared/agent-host'
import type { HostLink, LinkState } from '@shared/remote/link'
import {
  applyPatches,
  prependEntries,
  threadFromSnapshot,
  type OlderPage,
  type PatchBatch,
  type SessionSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'

export interface ThreadView {
  thread: ThreadState | null
  error: string | null
  hasOlder: boolean
  loadingOlder: boolean
  loadOlder(): void
  /** What waits for the user, which may lie on a page not read yet. */
  requests: ThreadEntry[]
  reloadRequests(): void
}

export function useThread(link: HostLink, sessionId: string, state: LinkState): ThreadView {
  const [thread, setThread] = useState<ThreadState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [older, setOlder] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [requests, setRequests] = useState<ThreadEntry[]>([])
  const seq = useRef(-1)
  const pending = useRef<PatchBatch[] | null>(null)
  const generation = useRef(0)
  const connected = state.kind === 'connected'

  const reloadRequests = useCallback(() => {
    void (link.request('sessions.requests', { sessionId }) as Promise<{ entries: ThreadEntry[] }>)
      .then((answer) => setRequests(answer.entries))
      .catch(() => {})
  }, [link, sessionId])

  const open = useCallback(async () => {
    const mine = ++generation.current
    pending.current = []
    try {
      await link.request('sessions.watch', { sessionId })
      const snapshot = (await link.request('sessions.open', { sessionId })) as SessionSnapshot
      if (mine !== generation.current) return
      let next = threadFromSnapshot(snapshot)
      seq.current = snapshot.seq
      for (const batch of pending.current ?? []) {
        if (batch.seq <= seq.current) continue
        next = applyPatches(next, batch.patches, { partial: true })
        seq.current = batch.seq
      }
      pending.current = null
      setThread(next)
      setOlder(snapshot.older)
      setError(null)
      void link.request('sessions.show', { sessionIds: [sessionId] }).catch(() => {})
      reloadRequests()
    } catch (failure) {
      if (mine === generation.current) setError((failure as { message?: string }).message ?? '打不开这个会话')
    }
  }, [link, sessionId, reloadRequests])

  useEffect(() => {
    const off = link.onHostEvent((raw) => {
      const event = raw as HostEvent
      if (event.type !== 'session.patches' || event.batch.sessionId !== sessionId) return
      const batch = event.batch
      if (pending.current) {
        pending.current.push(batch)
        return
      }
      if (batch.seq <= seq.current) return
      if ((batch.from ?? batch.seq) > seq.current + 1) {
        // Patches went missing, as across a dropped connection: read the snapshot again.
        void open()
        return
      }
      seq.current = batch.seq
      setThread((current) => (current ? applyPatches(current, batch.patches, { partial: true }) : current))
      if (batch.patches.some((p) => p.op === 'entry.add' || p.op === 'entry.update')) reloadRequests()
    })
    return off
  }, [link, sessionId, open, reloadRequests])

  useEffect(() => {
    if (!connected) return
    void open()
    return () => {
      generation.current++
      void link.request('sessions.unwatch', { sessionId }).catch(() => {})
      void link.request('sessions.show', { sessionIds: [] }).catch(() => {})
    }
  }, [connected, open, link, sessionId])

  const loadOlder = useCallback(() => {
    if (older === null || loadingOlder || !thread) return
    setLoadingOlder(true)
    void (link.request('sessions.page', { sessionId, before: older }) as Promise<OlderPage>)
      .then((page) => {
        setThread((current) => (current ? prependEntries(current, page.entries) : current))
        setOlder(page.older)
      })
      .catch(() => {})
      .finally(() => setLoadingOlder(false))
  }, [link, sessionId, older, loadingOlder, thread])

  return { thread, error, hasOlder: older !== null, loadingOlder, loadOlder, requests, reloadRequests }
}
