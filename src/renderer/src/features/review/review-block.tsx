import { useMemo } from 'react'
import { InspectCodeIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { parseReviewAnswer } from '@shared/review'
import { Button } from '@renderer/components/ui/button'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { useSessionFolder } from '@renderer/lib/session-folder'
import { orderedFindings, showFinding, useReview } from './review'

/**
 * A reply's kite-review block, the findings Kite asked for in JSON, as one line: how many it
 * lists, and Show, which opens the session's first finding on its line. The JSON is for Kite,
 * which checks it before anything shows.
 */
export function ReviewBlock({ sessionId, code }: { sessionId: string; code: string }) {
  const { t } = useTranslation('files')
  const review = useReview(sessionId)
  const folder = useSessionFolder(sessionId)
  const first = useMemo(() => orderedFindings(review)[0], [review])
  // The findings that pass Kite's checks, as the review keeps them; null until the JSON is whole.
  const count = useMemo(
    () =>
      folder === null ? null : (parseReviewAnswer(code.trim(), folder)?.findings.length ?? null),
    [code, folder],
  )
  return (
    <div className="kp-review-block">
      <PaneIcon icon={InspectCodeIcon} size={14} />
      <span className="kp-review-block__text">
        {count === null
          ? t('review.blockPending')
          : count === 0
            ? t('review.clean')
            : t('review.blockFound', { count })}
      </span>
      {review?.status === 'done' && first && folder && (
        <Button variant="outline" size="xs" onClick={() => showFinding(sessionId, folder, first)}>
          {t('review.show')}
        </Button>
      )}
    </div>
  )
}
