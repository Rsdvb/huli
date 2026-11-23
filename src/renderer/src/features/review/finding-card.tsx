import { memo } from 'react'
import { ArrowDown01Icon, Undo02Icon, ViewOffIcon, Wrench01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ReviewFinding, ReviewRun } from '@shared/review'
import { Button } from '@renderer/components/ui/button'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { actOnFindings, toggleFinding, useFindingOpen, type FindingSpot } from './review'

/**
 * A finding of the review as one line: its severity, its title, where it stands, and a chevron.
 * What changes as the user acts on it is only attributes, the tags drawn from them by CSS, so a
 * card slotted into the diff's rows never adds or removes a node there: on a diff of thousands of
 * lines, each node a slot gains costs a few hundred milliseconds of the diff's style and layout.
 * Inline, under a list above the diff, it opens to its detail; on a line, its detail opens on the
 * layer over the diff.
 */
export const FindingCard = memo(function FindingCard({
  sessionId,
  review,
  spot,
  inline = false,
}: {
  sessionId: string
  review: ReviewRun
  spot: FindingSpot
  inline?: boolean
}) {
  const { t } = useTranslation('files')
  const { finding } = spot
  const open = useFindingOpen(sessionId, review.id, finding.id)
  const where =
    spot.kind === 'outdated'
      ? t('review.outdated')
      : spot.kind === 'outside'
        ? t('review.elsewhere', { line: spot.line })
        : spot.moved
          ? t('review.moved')
          : undefined
  return (
    <div
      className="kp-finding"
      data-finding={finding.id}
      data-severity={finding.severity}
      data-state={finding.state}
      data-spot={spot.kind}
      data-open={open ? '' : undefined}
    >
      <button
        type="button"
        className="kp-finding__head focus-ring"
        aria-expanded={open}
        title={spot.kind === 'outdated' ? t('review.outdatedTitle') : finding.title}
        onClick={() => toggleFinding(sessionId, review.id, finding.id)}
      >
        <span className="kp-finding__severity">{t(`review.severity.${finding.severity}`)}</span>
        <span className="kp-finding__title">{finding.title}</span>
        <span
          className="kp-finding__tags"
          data-where={where}
          data-sent={finding.state === 'sent' ? t('review.sent') : undefined}
        />
        <PaneIcon icon={ArrowDown01Icon} size={14} className="kp-finding__chevron" />
      </button>
      {inline && open && <FindingDetail sessionId={sessionId} review={review} finding={finding} />}
    </div>
  )
})

/** A finding's detail: what the reviewer wrote, its place, and Dismiss, Restore and Fix it. */
export function FindingDetail({
  sessionId,
  review,
  finding,
}: {
  sessionId: string
  review: ReviewRun
  finding: ReviewFinding
}) {
  const { t } = useTranslation('files')
  const lines =
    finding.start === finding.end ? `${finding.start}` : `${finding.start}-${finding.end}`
  const act = (action: 'fix' | 'dismiss' | 'restore') =>
    void actOnFindings(sessionId, review, [finding], action)
  return (
    <div className="kp-finding__detail">
      {finding.body !== '' && <p className="kp-finding__body">{finding.body}</p>}
      <div className="kp-finding__foot">
        <span className="kp-finding__place" title={`${finding.path}:${lines}`}>
          {`${finding.path}:${lines}`}
        </span>
        {finding.state === 'dismissed' ? (
          <Button variant="ghost" size="xs" onClick={() => act('restore')}>
            <PaneIcon icon={Undo02Icon} size={13} />
            {t('review.restore')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="xs" onClick={() => act('dismiss')}>
              <PaneIcon icon={ViewOffIcon} size={13} />
              {t('review.dismiss')}
            </Button>
            <Button variant="outline" size="xs" onClick={() => act('fix')}>
              <PaneIcon icon={Wrench01Icon} size={13} />
              {finding.state === 'sent' ? t('review.fixAgain') : t('review.fix')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
