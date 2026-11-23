import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import type { ReviewRun } from '@shared/review'
import type { RenderCount } from '@renderer/features/diff-notes/notes'
import { useReviewStore } from '@renderer/stores/review'
import { FindingCard, FindingDetail } from './finding-card'
import { FindingsContext } from './findings-context'
import { closeFinding, openFinding, useOpenFinding, type FindingSpot } from './review'

/** A finding on its line of the diff, drawn from the review the context holds now. */
export function AnnotatedFinding({ id }: { id: string }) {
  const findings = useContext(FindingsContext)
  const spot = findings?.spots.get(id)
  if (!findings?.review || !spot) return null
  return <FindingCard sessionId={findings.sessionId} review={findings.review} spot={spot} />
}

/** The findings listed above the diff: those whose lines it folds away, and outdated ones. */
export function FindingsAbove({
  sessionId,
  review,
  spots,
}: {
  sessionId: string
  review: ReviewRun | null
  spots: FindingSpot[]
}) {
  if (!review || spots.length === 0) return null
  return (
    <div className="kp-findings-above">
      {spots.map((spot) => (
        <FindingCard
          key={spot.finding.id}
          sessionId={sessionId}
          review={review}
          spot={spot}
          inline
        />
      ))}
    </div>
  )
}

function cardOf(box: HTMLElement | null, findingId: string): HTMLElement | null {
  return box?.querySelector<HTMLElement>(`[data-finding="${CSS.escape(findingId)}"]`) ?? null
}

/**
 * The open finding's detail, for one on a line of the diff: on a layer over the scrolled diff
 * right under its card, laid out on its own, so opening and closing it lays out nothing of the
 * diff's rows. Esc closes it.
 */
export function FindingDetailLayer({
  sessionId,
  review,
  spots,
  scroller,
  renders,
}: {
  sessionId: string
  review: ReviewRun | null
  spots: FindingSpot[]
  scroller: RefObject<HTMLDivElement | null>
  renders: RenderCount
}) {
  const openId = useOpenFinding(sessionId, review?.id ?? null)
  const spot = spots.find((item) => item.kind === 'line' && item.finding.id === openId)
  const rendered = useSyncExternalStore(renders.subscribe, () => renders.count)
  const panel = useRef<HTMLDivElement>(null)

  // Placed after the diff is laid out, which is what the card's box comes from; hidden while its
  // card has no box yet.
  useLayoutEffect(() => {
    const box = scroller.current
    const element = panel.current
    if (!box || !element || !spot) return
    const card = cardOf(box, spot.finding.id)
    if (!card || card.getClientRects().length === 0) {
      delete element.dataset.placed
      return
    }
    const at = card.getBoundingClientRect()
    const origin = box.getBoundingClientRect()
    element.style.top = `${Math.round(at.bottom - origin.top + box.scrollTop - 4)}px`
    element.style.left = `${Math.round(at.left - origin.left)}px`
    element.dataset.placed = ''
  }, [spot, scroller, rendered])

  if (!review || !spot) return <div className="kp-findings-layer" />
  return (
    <div className="kp-findings-layer">
      <div
        ref={panel}
        role="dialog"
        aria-label={spot.finding.title}
        className="kp-finding-panel"
        data-severity={spot.finding.severity}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
          // Handled here, so the session does not also take Esc as a request to stop.
          event.preventDefault()
          event.stopPropagation()
          closeFinding(sessionId)
          cardOf(scroller.current, spot.finding.id)
            ?.querySelector<HTMLElement>('.kp-finding__head')
            ?.focus({ preventScroll: true })
        }}
      >
        <FindingDetail sessionId={sessionId} review={review} finding={spot.finding} />
      </div>
    </div>
  )
}

/**
 * Scrolls to the finding a jump asked for and opens it, once the diff has drawn its row: again
 * after each of the diff's renders until it is there.
 */
export function FindingFocus({
  sessionId,
  review,
  spots,
  scroller,
  renders,
}: {
  sessionId: string
  review: ReviewRun | null
  spots: FindingSpot[]
  scroller: RefObject<HTMLDivElement | null>
  renders: RenderCount
}) {
  const focus = useReviewStore((s) => (s.focus?.sessionId === sessionId ? s.focus : null))
  const rendered = useSyncExternalStore(renders.subscribe, () => renders.count)
  const done = useRef<object | null>(null)
  useEffect(() => {
    if (!focus || !review || done.current === focus) return
    const spot = spots.find((item) => item.finding.id === focus.findingId)
    if (!spot) return
    openFinding(sessionId, review.id, spot.finding.id)
    const card = cardOf(scroller.current, spot.finding.id)
    // A card the diff has not slotted yet has no box to scroll to.
    if (!card || card.getClientRects().length === 0) return
    card.scrollIntoView({ block: 'center' })
    card.querySelector<HTMLElement>('.kp-finding__head')?.focus({ preventScroll: true })
    done.current = focus
  }, [focus, review, spots, scroller, sessionId, rendered])
  return null
}
