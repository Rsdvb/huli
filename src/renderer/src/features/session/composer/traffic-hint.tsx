// Huli: what a large context costs in traffic, under the composer: every request uploads the whole
// context again, so a long session at a large context sends megabytes with each one. The line
// offers the two ways out, compacting and a handoff to a new session, and is dismissed per session.

import { useState } from 'react'
import {
  ArrowDataTransferVerticalIcon,
  ArrowShrink02Icon,
  Cancel01Icon,
  RepeatIcon,
} from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { requestUpload } from '@shared/traffic'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { Glyph } from '@renderer/features/shell/glyph'
import { tokens, traffic } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { fadeExit } from '@renderer/lib/motion'
import { compactContext, handoffSession } from './traffic-actions'

function useActions(sessionId: string) {
  const { t } = useTranslation('composer')
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<void>, done?: string) => {
    setBusy(true)
    action().then(
      () => {
        setBusy(false)
        if (done) toast(done)
      },
      (error: unknown) => {
        setBusy(false)
        toast(t('trafficHint.failed', { error: errorMessage(error) }))
      },
    )
  }
  return {
    busy,
    compact: (prompt: string) => run(() => compactContext(sessionId, prompt)),
    handoff: () => run(() => handoffSession(sessionId), t('trafficHint.handingOff')),
  }
}

/** The line at the top of the composer's footer. */
export function TrafficHint({
  sessionId,
  used,
  compact,
  canHandoff,
  onDismiss,
}: {
  sessionId: string
  used: number
  /** The agent's compaction command while the session can take it; null otherwise. */
  compact: string | null
  /** The session is between turns and can be handed off. */
  canHandoff: boolean
  onDismiss: () => void
}) {
  const { t } = useTranslation(['composer', 'common'])
  const actions = useActions(sessionId)
  const text = t('trafficHint.text', { size: traffic(requestUpload(used)) })
  return (
    <motion.div role="status" exit={fadeExit} className="kettu-traffic-hint">
      <Glyph icon={ArrowDataTransferVerticalIcon} className="size-3.5 shrink-0" />
      <span className="kettu-traffic-hint__text" title={t('trafficHint.why')}>
        {text}
      </span>
      {compact && (
        <button
          type="button"
          className="kettu-traffic-hint__action"
          disabled={actions.busy}
          title={t('usage.compactHint')}
          onClick={() => actions.compact(compact)}
        >
          <Glyph icon={ArrowShrink02Icon} className="size-3.5" />
          {t('trafficHint.compact')}
        </button>
      )}
      {canHandoff && (
        <button
          type="button"
          className="kettu-traffic-hint__action"
          disabled={actions.busy}
          title={t('trafficHint.handoffHint')}
          onClick={actions.handoff}
        >
          <Glyph icon={RepeatIcon} className="size-3.5" />
          {t('trafficHint.handoff')}
        </button>
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('common:actions.dismiss')}
        onClick={onDismiss}
        className="shrink-0"
      >
        <Glyph icon={Cancel01Icon} />
      </Button>
    </motion.div>
  )
}

/**
 * The card at the top of the composer's box when Settings asks to offer a handoff: shown once a
 * turn ended with the context past the line, never acting on its own.
 */
export function HandoffOfferStrip({
  sessionId,
  used,
  onDismiss,
}: {
  sessionId: string
  used: number
  onDismiss: () => void
}) {
  const { t } = useTranslation(['composer', 'common'])
  const actions = useActions(sessionId)
  return (
    <motion.div
      role="status"
      exit={fadeExit}
      className="kettu-switch flex w-full animate-in flex-wrap items-center gap-x-2.5 gap-y-1.5 fade-in animation-duration-(--duration-fast)"
    >
      <Glyph icon={RepeatIcon} className="size-4 shrink-0 text-tertiary" />
      <div className="min-w-0 flex-[1_1_14rem] text-primary">
        <p>{t('handoffOffer.title', { tokens: tokens(used) })}</p>
        <p className="text-xs text-tertiary">
          {t('handoffOffer.text', { size: traffic(requestUpload(used)) })}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button size="xs" variant="outline" onClick={onDismiss}>
          {t('handoffOffer.later')}
        </Button>
        <Button size="xs" disabled={actions.busy} onClick={actions.handoff}>
          {t('handoffOffer.go')}
        </Button>
      </div>
    </motion.div>
  )
}
