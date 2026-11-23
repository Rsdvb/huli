import { useMemo } from 'react'
import type { FileDiffMetadata } from '@pierre/diffs'
import {
  placeFinding,
  shownFindings,
  type ReviewAction,
  type ReviewFinding,
  type ReviewRun,
} from '@shared/review'
import { relativePath } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { hostPath } from '@renderer/lib/host-paths'
import { openDiff } from '@renderer/stores/files'
import { useGitStore } from '@renderer/stores/git'
import {
  findingKey,
  setFindingFocus,
  setOpenFinding,
  setReviewBusy,
  setReviewFailed,
  useReviewStore,
} from '@renderer/stores/review'
import { useThreadsStore } from '@renderer/stores/threads'

// Huli: a session's review of its changes as the window shows it: its findings on the lines of
// the Files pane's diff, the jumps between them, and what the user does with them.

/** The session's latest review, from its thread. */
export function useReview(sessionId: string | null): ReviewRun | null {
  return useThreadsStore((s) =>
    sessionId === null ? null : (s.replicas[sessionId]?.state?.session.review ?? null),
  )
}

export function useReviewBusy(sessionId: string): boolean {
  return useReviewStore((s) => !!s.busy[sessionId])
}

export function useReviewFailed(sessionId: string): string | null {
  return useReviewStore((s) => s.failed[sessionId] ?? null)
}

/** Starts a review of the session's uncommitted changes; a failure shows by its button. */
export async function startReview(sessionId: string): Promise<void> {
  setReviewBusy(sessionId, true)
  setReviewFailed(sessionId, null)
  try {
    await host('sessions.reviewStart', { sessionId })
  } catch (error) {
    setReviewFailed(sessionId, errorMessage(error))
  } finally {
    setReviewBusy(sessionId, false)
  }
}

export function stopReview(sessionId: string): void {
  void host('sessions.reviewStop', { sessionId }).catch(() => {})
}

/** Puts findings aside, takes them back, or sends them to the session's agent to fix. */
export async function actOnFindings(
  sessionId: string,
  review: ReviewRun,
  findings: readonly ReviewFinding[],
  action: ReviewAction,
): Promise<void> {
  if (findings.length === 0) return
  setReviewFailed(sessionId, null)
  try {
    await host('sessions.reviewAct', {
      sessionId,
      reviewId: review.id,
      findingIds: findings.map((finding) => finding.id),
      action,
    })
  } catch (error) {
    setReviewFailed(sessionId, errorMessage(error))
  }
}

/**
 * The findings shown on diffs, in reading order: by file, then by line; the dismissed ones too
 * with `dismissed`.
 */
export function orderedFindings(review: ReviewRun | null, dismissed = false): ReviewFinding[] {
  return (dismissed ? [...(review?.findings ?? [])] : shownFindings(review)).sort(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.start - b.start,
  )
}

/**
 * Opens the finding's file in the Files pane's diff of `projectPath`, the session's folder, and
 * asks it to scroll to the finding and open it.
 */
export function showFinding(sessionId: string, projectPath: string, finding: ReviewFinding): void {
  const root = useGitStore.getState().status[projectPath]?.repo?.root ?? null
  const absolute = `${hostPath(projectPath).replace(/[\\/]+$/, '')}/${finding.path}`
  const tracked = root === null ? finding.path : relativePath(absolute, root).replace(/\\/g, '/')
  setFindingFocus({ sessionId, findingId: finding.id })
  openDiff(projectPath, {
    path: tracked === absolute ? finding.path : tracked,
    oldPath: null,
    ref: null,
    projectFile: finding.path,
  })
}

/** Whether the session's dismissed findings show too. */
export function useShowDismissed(sessionId: string | null): boolean {
  return useReviewStore((s) => sessionId !== null && !!s.dismissed[sessionId])
}

export function useFindingOpen(sessionId: string, reviewId: string, findingId: string): boolean {
  return useReviewStore((s) => s.open[sessionId] === findingKey(reviewId, findingId))
}

/** The session's open finding's id in `reviewId`, or null. */
export function useOpenFinding(sessionId: string, reviewId: string | null): string | null {
  return useReviewStore((s) => {
    const key = s.open[sessionId]
    if (!key || reviewId === null || !key.startsWith(`${reviewId}\0`)) return null
    return key.slice(reviewId.length + 1)
  })
}

/** Opens the finding and closes the session's other one, or closes it when it is open. */
export function toggleFinding(sessionId: string, reviewId: string, findingId: string): void {
  const key = findingKey(reviewId, findingId)
  setOpenFinding(sessionId, useReviewStore.getState().open[sessionId] === key ? null : key)
}

export function openFinding(sessionId: string, reviewId: string, findingId: string): void {
  setOpenFinding(sessionId, findingKey(reviewId, findingId))
}

export function closeFinding(sessionId: string): void {
  setOpenFinding(sessionId, null)
}

/** Where a finding of the file a diff shows goes: on its line, or listed above the diff. */
export type FindingSpot =
  | { kind: 'line'; finding: ReviewFinding; line: number; end: number; moved: boolean }
  | { kind: 'outside'; finding: ReviewFinding; line: number }
  | { kind: 'outdated'; finding: ReviewFinding }

/**
 * The review's findings on `path`, placed on the file as the diff's new side has it: on a line
 * the diff shows, on a line it folds away, or outdated where the line is gone.
 */
export function useFindingSpots(
  review: ReviewRun | null,
  path: string,
  newText: string,
  fileDiff: FileDiffMetadata,
  dismissed: boolean,
): FindingSpot[] {
  return useMemo(() => {
    const findings = orderedFindings(review, dismissed).filter((finding) => finding.path === path)
    if (findings.length === 0) return []
    const lines = newText.split(/\r?\n/)
    const shown = (line: number): boolean =>
      fileDiff.hunks.some(
        (hunk) => line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
      )
    return findings.map((finding): FindingSpot => {
      const place = placeFinding(finding, lines)
      if (place === null) return { kind: 'outdated', finding }
      if (!shown(place.start)) return { kind: 'outside', finding, line: place.start }
      return { kind: 'line', finding, line: place.start, end: place.end, moved: place.moved }
    })
  }, [review, path, newText, fileDiff, dismissed])
}
