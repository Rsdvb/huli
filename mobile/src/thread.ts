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
  type PlanEntry,
  type SessionSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import { readThread, writeThread } from './cache'
import { useHost } from './host'

export interface ThreadView {
  thread: ThreadState | null
  /** The thread is the cache's copy from an earlier visit; the computer has not sent it yet. */
  cached: boolean
  error: string | null
  hasOlder: boolean
  loadingOlder: boolean
  loadOlder(): void
  /** What waits for the user, which may lie on a page not read yet. */
  requests: ThreadEntry[]
  reloadRequests(): void
  /** The latest plan when it lies on a page not read yet, for the plan above the composer. */
  plan: PlanEntry | null
}

/** How often at most a watched thread is written to the cache while it changes. */
const SAVE_EVERY = 5000

export function useThread(link: HostLink, sessionId: string, state: LinkState): ThreadView {
  const computer = useHost().host?.id ?? null
  const [thread, setThread] = useState<ThreadState | null>(null)
  const [cached, setCached] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [older, setOlder] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [requests, setRequests] = useState<ThreadEntry[]>([])
  const [plan, setPlan] = useState<PlanEntry | null>(null)
  const seq = useRef(-1)
  const pending = useRef<PatchBatch[] | null>(null)
  const generation = useRef(0)
  const live = useRef(false)
  const connected = state.kind === 'connected'

  // Until the computer sends the thread, the cache's copy from an earlier visit shows, read-only.
  useEffect(() => {
    if (!computer) return
    let current = true
    void readThread(computer, sessionId).then((copy) => {
      if (!current || !copy || live.current) return
      setThread(threadFromSnapshot({ session: copy.session, entries: copy.entries, seq: -1 }))
      setCached(true)
    })
    return () => {
      current = false
    }
  }, [computer, sessionId])

  // The thread the computer sent goes to the cache now and then, and when the screen closes.
  const latest = useRef<ThreadState | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!computer || cached || !thread) return
    latest.current = thread
    if (saveTimer.current) return
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      if (latest.current) void writeThread(computer, latest.current)
    }, SAVE_EVERY)
  }, [computer, cached, thread])
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = null
      if (computer && latest.current) void writeThread(computer, latest.current)
    },
    [computer],
  )

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
      live.current = true
      setThread(next)
      setCached(false)
      setOlder(snapshot.older)
      setPlan(snapshot.plan ?? null)
      setError(null)
      void link.request('sessions.show', { sessionIds: [sessionId] }).catch(() => {})
      reloadRequests()
    } catch (failure) {
      if (mine === generation.current)
        setError((failure as { message?: string }).message ?? '打不开这个会话')
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
      // A patch applies to the computer's thread only, never to the cache's copy.
      if (!live.current) return
      setThread((current) =>
        current ? applyPatches(current, batch.patches, { partial: true }) : current,
      )
      if (batch.patches.some((p) => p.op === 'entry.add' || p.op === 'entry.update'))
        reloadRequests()
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

  return {
    thread,
    cached,
    error,
    hasOlder: older !== null && !cached,
    loadingOlder,
    loadOlder,
    requests,
    reloadRequests,
    plan,
  }
}
