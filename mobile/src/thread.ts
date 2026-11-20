// One session's thread as the phone shows it: the latest page from `sessions.open`, kept current
// by the host's patches while the screen watches it, with older pages read on demand. A gap in
// the patches, or a new connection, reads the snapshot again.
//
// The thread lives in a store, not in the screen's state: the screen selects what it needs (its
// session, the turn's phase, what waits) and only the conversation list follows every patch.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HostEvent } from '@shared/agent-host'
import type { HostLink, LinkState } from '@shared/remote/link'
import {
  applyPatches,
  prependEntries,
  shareEntries,
  threadFromSnapshot,
  type OlderPage,
  type PatchBatch,
  type PlanEntry,
  type SessionSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import { readThread, recentThread, writeThread } from './cache'
import { useComputerId } from './host'
import { hostErrorText } from './hostErrors'
import { createStore, useSelector, type Store } from './select'

export interface ThreadView {
  /** The thread, null until there is one; read it with `useThreadSelector`. */
  store: Store<ThreadState | null>
  /** The thread is the cache's copy from an earlier visit; the computer has not sent it yet. */
  cached: boolean
  /** The cache was looked in, whether or not it held the thread. */
  cacheRead: boolean
  /** Why the computer's copy could not be read; the cache's, if any, still shows. */
  error: string | null
  /** Reads the computer's copy again now, as it does by itself a while after a failure. */
  retry(): void
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
/**
 * How often at most patches reach the screen while they stream in: a reply's tokens come in many
 * small batches, and each one applied alone would copy the thread and redraw the conversation.
 */
const APPLY_EVERY = 50
/**
 * How long the requests' read waits, so a stream of batches that may change them reads them once
 * rather than once a batch.
 */
const REQUESTS_AFTER = 250
/** How long after a failed read it is tried again, doubling with each failure up to the most. */
const RETRY_FIRST = 2000
const RETRY_MOST = 30_000

/** Whether two answers of what waits hold the same entries, so the screen keeps its own. */
function sameEntries(a: readonly ThreadEntry[], b: readonly ThreadEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => JSON.stringify(e) === JSON.stringify(b[i]))
}

export function useThread(link: HostLink, sessionId: string, state: LinkState): ThreadView {
  const computer = useComputerId()
  // A copy still in memory shows on the first frame; the file's, a moment later.
  const [first] = useState(() => {
    const copy = computer ? recentThread(computer, sessionId) : null
    return copy
      ? threadFromSnapshot({ session: copy.session, entries: copy.entries, seq: -1 })
      : null
  })
  const store = useMemo(() => createStore<ThreadState | null>(first), [first])
  const setThread = store.set
  const [cached, setCached] = useState(first !== null)
  const [cacheRead, setCacheRead] = useState(first !== null || !computer)
  const cachedRef = useRef(first !== null)
  const [error, setError] = useState<string | null>(null)
  const [older, setOlder] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [requests, setRequests] = useState<ThreadEntry[]>([])
  const [plan, setPlan] = useState<PlanEntry | null>(null)
  const seq = useRef(-1)
  const pending = useRef<PatchBatch[] | null>(null)
  const generation = useRef(0)
  const live = useRef(false)
  /** Batches taken in but not yet applied, and the timer that applies them together. */
  const queued = useRef<PatchBatch[]>([])
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const appliedAt = useRef(0)
  // After a failed read, until it is tried again: patches meanwhile go unread, as the next read
  // has them, rather than each starting a read of its own.
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const failures = useRef(0)
  const openRef = useRef<() => Promise<void>>(async () => {})
  const connected = state.kind === 'connected'

  // Until the computer sends the thread, the cache's copy from an earlier visit shows, read-only.
  // The copy in memory is already shown, and the file holds no more than it.
  useEffect(() => {
    if (!computer || first) return
    let current = true
    void readThread(computer, sessionId)
      .then((copy) => {
        if (!current || !copy || live.current) return
        cachedRef.current = true
        setCached(true)
        setThread(threadFromSnapshot({ session: copy.session, entries: copy.entries, seq: -1 }))
      })
      .catch(() => {})
      .finally(() => {
        if (current) setCacheRead(true)
      })
    return () => {
      current = false
    }
  }, [computer, sessionId, first])

  // The thread the computer sent goes to the cache now and then, and when the screen closes.
  const latest = useRef<ThreadState | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!computer) return
    const save = () => {
      const thread = store.get()
      if (cachedRef.current || !thread) return
      latest.current = thread
      if (saveTimer.current) return
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        if (latest.current) void writeThread(computer, latest.current)
      }, SAVE_EVERY)
    }
    save()
    return store.subscribe(save)
  }, [computer, store])
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = null
      if (computer && latest.current) void writeThread(computer, latest.current)
    },
    [computer],
  )

  const requestsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reloadRequests = useCallback(() => {
    if (requestsTimer.current) return
    requestsTimer.current = setTimeout(() => {
      requestsTimer.current = null
      void (link.request('sessions.requests', { sessionId }) as Promise<{ entries: ThreadEntry[] }>)
        .then((answer) =>
          setRequests((was) => (sameEntries(was, answer.entries) ? was : answer.entries)),
        )
        .catch(() => {})
    }, REQUESTS_AFTER)
  }, [link, sessionId])
  useEffect(
    () => () => {
      if (requestsTimer.current) clearTimeout(requestsTimer.current)
      requestsTimer.current = null
    },
    [link, sessionId],
  )

  const applyQueued = useCallback(() => {
    applyTimer.current = null
    appliedAt.current = Date.now()
    const batches = queued.current
    if (batches.length === 0) return
    queued.current = []
    const patches = batches.length === 1 ? batches[0]!.patches : batches.flatMap((b) => b.patches)
    setThread((current) => (current ? applyPatches(current, patches, { partial: true }) : current))
    if (patches.some((p) => p.op === 'entry.add' || p.op === 'entry.update')) reloadRequests()
  }, [reloadRequests, setThread])

  // Whatever waits to be applied belongs to the thread as it was; a new snapshot replaces it.
  const dropQueued = () => {
    queued.current = []
    if (applyTimer.current) clearTimeout(applyTimer.current)
    applyTimer.current = null
  }

  const open = useCallback(async () => {
    const mine = ++generation.current
    if (retryTimer.current) clearTimeout(retryTimer.current)
    retryTimer.current = null
    dropQueued()
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
      cachedRef.current = false
      setCached(false)
      // The entries the screen shows already keep their objects, so only what changed redraws.
      setThread((current) => shareEntries(current, next))
      setOlder(snapshot.older)
      setPlan(snapshot.plan ?? null)
      setError(null)
      failures.current = 0
      void link.request('sessions.show', { sessionIds: [sessionId] }).catch(() => {})
      reloadRequests()
    } catch (failure) {
      if (mine !== generation.current) return
      // What came in while it was read is not kept: the next read has it.
      pending.current = null
      setError(hostErrorText(failure, '打不开这个会话。'))
      const wait = Math.min(RETRY_MOST, RETRY_FIRST * 2 ** failures.current)
      failures.current++
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null
        void openRef.current()
      }, wait)
    }
  }, [link, sessionId, reloadRequests])
  openRef.current = open

  useEffect(() => {
    const off = link.onHostEvent((raw) => {
      const event = raw as HostEvent
      if (event.type !== 'session.patches' || event.batch.sessionId !== sessionId) return
      if (retryTimer.current) return
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
      queued.current.push(batch)
      if (applyTimer.current) return
      // The first batch after a pause shows at once; the rest wait for the next slot.
      const wait = Math.max(0, appliedAt.current + APPLY_EVERY - Date.now())
      applyTimer.current = setTimeout(applyQueued, wait)
    })
    return () => {
      off()
      // A new link or session reads its snapshot afresh, which has these.
      dropQueued()
    }
  }, [link, sessionId, open, applyQueued])

  useEffect(() => {
    if (!connected) return
    failures.current = 0
    void open()
    return () => {
      generation.current++
      if (retryTimer.current) clearTimeout(retryTimer.current)
      retryTimer.current = null
      void link.request('sessions.unwatch', { sessionId }).catch(() => {})
      void link.request('sessions.show', { sessionIds: [] }).catch(() => {})
    }
  }, [connected, open, link, sessionId])

  const loadOlder = useCallback(() => {
    if (older === null || loadingOlder || !store.get()) return
    setLoadingOlder(true)
    void (link.request('sessions.page', { sessionId, before: older }) as Promise<OlderPage>)
      .then((page) => {
        setThread((current) => (current ? prependEntries(current, page.entries) : current))
        setOlder(page.older)
      })
      .catch(() => {})
      .finally(() => setLoadingOlder(false))
  }, [link, sessionId, older, loadingOlder, store, setThread])

  const retry = useCallback(() => {
    failures.current = 0
    void openRef.current()
  }, [])

  return {
    store,
    cached,
    cacheRead,
    error,
    retry,
    hasOlder: older !== null && !cached,
    loadingOlder,
    loadOlder,
    requests,
    reloadRequests,
    plan,
  }
}

/** Part of a session's thread: redraws only when it changes by `equal`. */
export function useThreadSelector<S>(
  view: Pick<ThreadView, 'store'>,
  select: (thread: ThreadState | null) => S,
  equal?: (a: S, b: S) => boolean,
): S {
  return useSelector(view.store, select, equal)
}
