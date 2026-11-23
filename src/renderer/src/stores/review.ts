import { create } from 'zustand'

// Huli: what the window keeps of a session's review beside the review itself, which its thread
// carries: the request in flight and its last failure, the finding a jump asked for, and the one
// finding whose detail is open.

interface ReviewStore {
  /** Sessions whose review request is in flight. */
  busy: Record<string, true>
  /** The last failure of a session's review request, until the next one. */
  failed: Record<string, string>
  /** The finding a jump asked for: its diff scrolls to it and opens it once shown. */
  focus: { sessionId: string; findingId: string } | null
  /** The open finding of each session, as `reviewId\0findingId`. */
  open: Record<string, string>
  /** Sessions whose dismissed findings show too. */
  dismissed: Record<string, true>
}

export const useReviewStore = create<ReviewStore>()(() => ({
  busy: {},
  failed: {},
  focus: null,
  open: {},
  dismissed: {},
}))

export const findingKey = (reviewId: string, findingId: string): string =>
  `${reviewId}\0${findingId}`

export function toggleDismissed(sessionId: string): void {
  useReviewStore.setState((s) => {
    const next = { ...s.dismissed }
    if (next[sessionId]) delete next[sessionId]
    else next[sessionId] = true
    return { dismissed: next }
  })
}

export function setReviewBusy(sessionId: string, busy: boolean): void {
  useReviewStore.setState((s) => {
    const next = { ...s.busy }
    if (busy) next[sessionId] = true
    else delete next[sessionId]
    return { busy: next }
  })
}

export function setReviewFailed(sessionId: string, message: string | null): void {
  useReviewStore.setState((s) => {
    if (message === null && !(sessionId in s.failed)) return s
    const next = { ...s.failed }
    if (message === null) delete next[sessionId]
    else next[sessionId] = message
    return { failed: next }
  })
}

/** Opens the finding, closing the session's other one, or closes it with `key` null. */
export function setOpenFinding(sessionId: string, key: string | null): void {
  useReviewStore.setState((s) => {
    if ((s.open[sessionId] ?? null) === key) return s
    const next = { ...s.open }
    if (key === null) delete next[sessionId]
    else next[sessionId] = key
    return { open: next }
  })
}

export function setFindingFocus(focus: ReviewStore['focus']): void {
  useReviewStore.setState({ focus })
}
