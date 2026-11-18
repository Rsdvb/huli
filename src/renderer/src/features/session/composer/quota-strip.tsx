import { ArrowDataTransferHorizontalIcon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { Fallback, PlanQuota } from '@shared/plan-quota'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Glyph } from '@renderer/features/shell/glyph'
import { backTime, limitPhrase } from '@renderer/lib/format'
import { fadeExit } from '@renderer/lib/motion'

/**
 * The note at the top of the composer's box while the chosen agent's plan is used up and another
 * agent has room: when the plan comes back, and one press to pick that agent instead. Nothing
 * switches until the user presses it.
 */
export function QuotaStrip({
  agentName,
  quota,
  fallback,
  onSwitch,
  onDismiss,
  now,
}: {
  agentName: string
  quota: Extract<PlanQuota, { kind: 'out' }>
  fallback: Fallback
  onSwitch: () => void
  onDismiss: () => void
  now: number
}) {
  const { t } = useTranslation('session')
  const limit = limitPhrase(quota.limit)
  const percent = Math.round(fallback.usedPercent)
  return (
    <motion.div
      exit={fadeExit}
      className="kettu-switch flex w-full animate-in flex-wrap items-center gap-x-2.5 gap-y-1.5 fade-in animation-duration-(--duration-fast)"
    >
      <Glyph icon={ArrowDataTransferHorizontalIcon} className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-[1_1_14rem] text-primary">
        <p>
          {quota.resetsAt !== null && quota.resetsAt > now
            ? t('quota.suggest', {
                agent: agentName,
                limit,
                time: backTime(quota.resetsAt, now),
              })
            : t('quota.suggestNoReset', { agent: agentName, limit })}
        </p>
        <p className="text-xs text-tertiary">
          {t('quota.switchToUsed', { agent: fallback.name, percent })}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          {t('quota.dismiss')}
        </Button>
        <Button size="xs" variant="outline" onClick={onSwitch}>
          <AgentMark agent={fallback.agentId} size={12} />
          {t('quota.switchTo', { agent: fallback.name })}
        </Button>
      </div>
    </motion.div>
  )
}
