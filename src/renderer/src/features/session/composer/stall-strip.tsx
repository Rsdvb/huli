import { useState } from 'react'
import { HourglassIcon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { Stall, StallAction } from '@shared/supervisor'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { fadeExit } from '@renderer/lib/motion'

const MINUTE = 60_000

/**
 * Huli: the strip at the top of the composer's box while the running turn has said nothing for a
 * while: how long, and Stop, Retry, which stops it and goes on again, or Keep waiting. It goes by
 * itself once output comes again.
 */
export function StallStrip({
  sessionId,
  stall,
  now,
}: {
  sessionId: string
  stall: Stall
  now: number
}) {
  const { t } = useTranslation('composer')
  const [busy, setBusy] = useState<StallAction | null>(null)
  const [error, setError] = useState<string | null>(null)

  const act = (action: StallAction) => {
    setBusy(action)
    setError(null)
    host('sessions.stall', { sessionId, action })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(null))
  }

  const minutes = Math.max(1, Math.floor((now - stall.since) / MINUTE))
  return (
    <motion.div
      exit={fadeExit}
      className="kettu-switch flex w-full animate-in flex-wrap items-center gap-x-2.5 gap-y-1.5 fade-in animation-duration-(--duration-fast)"
    >
      <Glyph icon={HourglassIcon} className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-[1_1_14rem] text-primary">
        <p>{t('stall.title')}</p>
        <p className="text-xs text-tertiary">
          {t(stall.reason === 'retrying' ? 'stall.retrying' : 'stall.silent', { count: minutes })}
        </p>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => act('wait')}>
          {t('stall.wait')}
        </Button>
        <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => act('retry')}>
          {busy === 'retry' && <Spinner className="size-3" />}
          {t('stall.retry')}
        </Button>
        <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => act('stop')}>
          {busy === 'stop' && <Spinner className="size-3" />}
          {t('stall.stop')}
        </Button>
      </div>
    </motion.div>
  )
}
