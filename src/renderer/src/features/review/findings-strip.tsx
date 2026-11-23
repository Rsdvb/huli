import { useMemo } from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  InspectCodeIcon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ReviewFinding } from '@shared/review'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { PaneIcon, PanelButton } from '@renderer/features/shell/panel-button'
import { setFindingFocus, toggleDismissed, useReviewStore } from '@renderer/stores/review'
import {
  actOnFindings,
  orderedFindings,
  showFinding,
  startReview,
  stopReview,
  useReview,
  useReviewBusy,
  useReviewFailed,
  useShowDismissed,
} from './review'

/**
 * Under the diff's bar while the session has a review: how it runs or ended, its findings' count
 * here and in all, the jumps from one to the next across the files, and Fix all, which sends the
 * open ones to the session's agent together.
 */
export function FindingsStrip({
  sessionId,
  projectPath,
  path,
}: {
  sessionId: string
  projectPath: string
  /** The file the diff shows, relative to the session's folder. */
  path: string
}) {
  const { t } = useTranslation('files')
  const review = useReview(sessionId)
  const busy = useReviewBusy(sessionId)
  const failed = useReviewFailed(sessionId)
  const focused = useReviewStore((s) =>
    s.focus?.sessionId === sessionId ? s.focus.findingId : null,
  )
  const withDismissed = useShowDismissed(sessionId)
  const shown = useMemo(() => orderedFindings(review, withDismissed), [review, withDismissed])
  const open = useMemo(() => shown.filter((finding) => finding.state === 'open'), [shown])
  const dismissed = review?.findings.filter((finding) => finding.state === 'dismissed').length ?? 0
  if (!review && !busy && !failed) return null

  const here = shown.filter((finding) => finding.path === path).length
  const jump = (finding: ReviewFinding): void => {
    if (finding.path === path) setFindingFocus({ sessionId, findingId: finding.id })
    else showFinding(sessionId, projectPath, finding)
  }
  const step = (by: 1 | -1): void => {
    if (shown.length === 0) return
    const at = shown.findIndex((finding) => finding.id === focused)
    const from = at >= 0 ? at : by === 1 ? -1 : 0
    jump(shown[(from + by + shown.length) % shown.length]!)
  }
  const again = (
    <Button variant="ghost" size="xs" onClick={() => void startReview(sessionId)}>
      <PaneIcon icon={InspectCodeIcon} size={13} />
      {t('review.again')}
    </Button>
  )

  if (busy || review?.status === 'running') {
    return (
      <div className="kp-findings-strip" role="status">
        <Spinner className="size-3.5 text-tertiary" />
        <span className="kp-findings-strip__text">
          {review?.mode === 'detached' ? t('review.runningDetached') : t('review.running')}
        </span>
        {review?.mode === 'detached' && review.status === 'running' && (
          <Button variant="ghost" size="xs" onClick={() => stopReview(sessionId)}>
            {t('review.stop')}
          </Button>
        )}
      </div>
    )
  }
  if (failed || !review || review.status === 'failed' || review.status === 'stopped') {
    const message = failed ?? review?.error ?? null
    return (
      <div className="kp-findings-strip" data-tone="warning">
        <PaneIcon icon={Alert02Icon} size={14} />
        <span className="kp-findings-strip__text" title={message ?? undefined}>
          {review?.status === 'stopped' && !failed ? t('review.stopped') : t('review.failed')}
          {message && <span className="kp-findings-strip__why"> · {message}</span>}
        </span>
        {again}
      </div>
    )
  }
  const dismissedToggle = dismissed > 0 && (
    <Button
      variant="ghost"
      size="xs"
      className="shrink-0 text-tertiary"
      aria-pressed={withDismissed}
      onClick={() => toggleDismissed(sessionId)}
    >
      {withDismissed ? t('review.hideDismissed') : t('review.dismissed', { count: dismissed })}
    </Button>
  )
  if (shown.length === 0) {
    return (
      <div className="kp-findings-strip" data-tone="clean">
        <span className="kp-findings-strip__text">
          {review.findings.length === 0 ? t('review.clean') : t('review.allHandled')}
        </span>
        {dismissedToggle}
        {again}
      </div>
    )
  }
  return (
    <div className="kp-findings-strip">
      <span className="kp-findings-strip__count">{t('review.count', { count: shown.length })}</span>
      {here > 0 && here < shown.length && (
        <span className="kp-findings-strip__why">{t('review.inFile', { count: here })}</span>
      )}
      <span className="kp-findings-strip__steps">
        <PanelButton size="icon-xs" label={t('review.previous')} onClick={() => step(-1)}>
          <PaneIcon icon={ArrowUp01Icon} size={14} />
        </PanelButton>
        <PanelButton size="icon-xs" label={t('review.next')} onClick={() => step(1)}>
          <PaneIcon icon={ArrowDown01Icon} size={14} />
        </PanelButton>
      </span>
      <span className="flex-1" />
      {dismissedToggle}
      {open.length > 0 && (
        <Button
          variant="outline"
          size="xs"
          title={t('review.fixAllTitle', { count: open.length })}
          onClick={() => void actOnFindings(sessionId, review, open, 'fix')}
        >
          <PaneIcon icon={Wrench01Icon} size={13} />
          {t('review.fixAll')}
        </Button>
      )}
      <PanelButton
        size="icon-xs"
        label={t('review.again')}
        onClick={() => void startReview(sessionId)}
      >
        <PaneIcon icon={InspectCodeIcon} size={14} />
      </PanelButton>
    </div>
  )
}
