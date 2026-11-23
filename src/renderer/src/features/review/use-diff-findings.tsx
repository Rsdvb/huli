import { useCallback, useMemo, type ReactNode } from 'react'
import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs'
import { AnnotatedFinding } from './diff-findings'
import { FindingsContext, type Findings } from './findings-context'
import { useFindingSpots, useReview, useShowDismissed, type FindingSpot } from './review'

const renderFinding = (id: string): ReactNode => <AnnotatedFinding id={id} />

/**
 * The session's findings on the file a diff shows: the annotations that put each under the last
 * of its lines the diff shows, drawing it from the context `provider` gives, and the findings
 * listed above the diff whose lines it folds away or that are outdated. The annotations keep
 * their identity while every finding keeps its line, so a finding dismissed or opened draws only
 * itself, not the diff.
 */
export function useDiffFindings(
  sessionId: string | null,
  path: string,
  newText: string,
  fileDiff: FileDiffMetadata,
): {
  annotations: DiffLineAnnotation<string>[] | undefined
  renderAnnotation: ((id: string) => ReactNode) | undefined
  spots: FindingSpot[]
  above: FindingSpot[]
  provide: (children: ReactNode) => ReactNode
} {
  const review = useReview(sessionId)
  const dismissed = useShowDismissed(sessionId)
  const spots = useFindingSpots(review, path, newText, fileDiff, dismissed)
  const byId = useMemo(() => new Map(spots.map((spot) => [spot.finding.id, spot])), [spots])
  const key = spots
    .map((spot) => (spot.kind === 'line' ? `${spot.finding.id}:${attachLine(spot, fileDiff)}` : ''))
    .join(',')
  const annotations = useMemo(
    () =>
      spots.flatMap((spot): DiffLineAnnotation<string>[] =>
        spot.kind === 'line'
          ? [
              {
                side: 'additions',
                lineNumber: attachLine(spot, fileDiff),
                metadata: spot.finding.id,
              },
            ]
          : [],
      ),
    // `key` says when a line changes; the spots change with every change of the review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, fileDiff],
  )
  const above = useMemo(() => spots.filter((spot) => spot.kind !== 'line'), [spots])
  const value = useMemo<Findings | null>(
    () => (sessionId === null ? null : { sessionId, review, spots: byId }),
    [sessionId, review, byId],
  )
  const provide = useCallback(
    (children: ReactNode) => (
      <FindingsContext.Provider value={value}>{children}</FindingsContext.Provider>
    ),
    [value],
  )
  return {
    annotations: annotations.length > 0 ? annotations : undefined,
    renderAnnotation: annotations.length > 0 ? renderFinding : undefined,
    spots,
    above,
    provide,
  }
}

/** The last of the finding's lines inside the hunk its first line is in. */
function attachLine(
  spot: Extract<FindingSpot, { kind: 'line' }>,
  fileDiff: FileDiffMetadata,
): number {
  const hunk = fileDiff.hunks.find(
    (h) => spot.line >= h.additionStart && spot.line < h.additionStart + h.additionCount,
  )
  if (!hunk) return spot.line
  return Math.min(spot.end, hunk.additionStart + hunk.additionCount - 1)
}
