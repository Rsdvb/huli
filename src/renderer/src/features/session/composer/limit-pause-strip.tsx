import { useState } from 'react'
import { Clock01Icon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { LimitPause } from '@shared/supervisor'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Glyph } from '@renderer/features/shell/glyph'
import { backTime } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { fadeExit } from '@renderer/lib/motion'

const MINUTE = 60_000

/**
 * Huli: the strip at the top of the composer's box while a turn its plan limit stopped waits to go
 * on by itself: when the plan comes back and how long until the session goes on, with Cancel,
 * which leaves it stopped, and Retry now.
 */
export function LimitPauseStrip({
  sessionId,
  pause,
  now,
}: {
  sessionId: string
  pause: LimitPause
  now: number
}) {
  const { t } = useTranslation(['composer', 'common'])
  const [busy, setBusy] = useState<'cancel' | 'now' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const act = (action: 'cancel' | 'now') => {
    setBusy(action)
    setError(null)
    // Held after a success: the strip goes once the session's view drops the pause.
    host('sessions.limitPause', { sessionId, action }).catch((e: unknown) => {
      setError(errorMessage(e))
      setBusy(null)
    })
  }

  const left = Math.max(0, pause.resumeAt - now)
  const wait =
    left < MINUTE
      ? t('limitPause.inMoment')
      : t('limitPause.inMinutes', { count: Math.ceil(left / MINUTE) })
  return (
    <motion.div
      exit={fadeExit}
      className="kettu-switch flex w-full animate-in flex-wrap items-center gap-x-2.5 gap-y-1.5 fade-in animation-duration-(--duration-fast)"
    >
      <Glyph icon={Clock01Icon} className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-[1_1_14rem] text-primary">
        <p>
          {pause.resetsAt === null
            ? t('limitPause.unknown', { time: backTime(pause.resumeAt, now) })
            : t('limitPause.at', { time: backTime(pause.resetsAt, now) })}
        </p>
        <p className="text-xs text-tertiary">
          {pause.resetsAt === null
            ? t('limitPause.checking', { wait })
            : t('limitPause.goesOn', { wait })}
        </p>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => act('cancel')}>
          {t('common:actions.cancel')}
        </Button>
        <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => act('now')}>
          {busy === 'now' && <Spinner className="size-3" />}
          {t('limitPause.now')}
        </Button>
      </div>
    </motion.div>
  )
}
