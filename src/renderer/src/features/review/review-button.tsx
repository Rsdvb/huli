import { useMemo } from 'react'
import { InspectCodeIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { openFindings } from '@shared/review'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { PaneIcon, PanelButton } from '@renderer/features/shell/panel-button'
import {
  orderedFindings,
  showFinding,
  startReview,
  useReview,
  useReviewBusy,
  useReviewFailed,
} from './review'

/** Whether the session's review is being asked for or runs. */
function useReviewing(sessionId: string): boolean {
  const busy = useReviewBusy(sessionId)
  const running = useReview(sessionId)?.status === 'running'
  return busy || running
}

/**
 * The changes card's Review changes: starts a review of the session's uncommitted changes; once
 * it found problems, their count, which opens the first in the Files pane's diff.
 */
export function ReviewButton({
  sessionId,
  projectPath,
}: {
  sessionId: string
  projectPath: string
}) {
  const { t } = useTranslation('files')
  const review = useReview(sessionId)
  const reviewing = useReviewing(sessionId)
  const failed = useReviewFailed(sessionId)
  const open = useMemo(
    () => orderedFindings(review).filter((finding) => finding.state === 'open'),
    [review],
  )
  if (!reviewing && review?.status === 'done' && open.length > 0) {
    const worst = openFindings(review)[0]!.severity
    const label = t('review.count', { count: open.length })
    return (
      <Button
        variant="outline"
        className="ks-btn kp-review-count"
        data-severity={worst}
        aria-label={label}
        title={t('review.countTitle')}
        onClick={() => showFinding(sessionId, projectPath, open[0]!)}
      >
        <Icon icon={InspectCodeIcon} size={14} />
        <span className="ks-btn__label">{label}</span>
      </Button>
    )
  }
  const label = reviewing ? t('review.running') : t('review.start')
  return (
    <Button
      variant="outline"
      className="ks-btn"
      aria-label={label}
      title={failed ?? t('review.startTitle')}
      data-failed={failed ? '' : undefined}
      disabled={reviewing}
      onClick={() => void startReview(sessionId)}
    >
      {reviewing ? <Spinner className="size-3.5" /> : <Icon icon={InspectCodeIcon} size={14} />}
      <span className="ks-btn__label">{label}</span>
    </Button>
  )
}

/** The diff bar's Review changes, an icon button. */
export function PaneReviewButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('files')
  const reviewing = useReviewing(sessionId)
  const failed = useReviewFailed(sessionId)
  return (
    <PanelButton
      label={reviewing ? t('review.running') : (failed ?? t('review.startTitle'))}
      unavailable={reviewing}
      onClick={() => void startReview(sessionId)}
    >
      {reviewing ? <Spinner className="size-3.5" /> : <PaneIcon icon={InspectCodeIcon} />}
    </PanelButton>
  )
}
