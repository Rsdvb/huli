import { Cancel01Icon, Timer02Icon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Glyph } from '@renderer/features/shell/glyph'
import { fadeExit } from '@renderer/lib/motion'

/**
 * Huli: the line at the top of the composer's box after the model changed mid-session, for an
 * agent whose provider keeps a prompt cache per model: the next turn reads the conversation again
 * at full price. It goes once that turn has made its first request.
 */
export function CacheRestartStrip({ model, onDismiss }: { model: string; onDismiss: () => void }) {
  const { t } = useTranslation(['composer', 'common'])
  return (
    <motion.div
      role="status"
      exit={fadeExit}
      className="kettu-switch flex w-full animate-in items-center gap-2.5 fade-in animation-duration-(--duration-fast)"
    >
      <Glyph icon={Timer02Icon} className="size-4 shrink-0 text-tertiary" />
      <p className="min-w-0 flex-1 truncate text-primary" title={t('modelCache.note', { model })}>
        {t('modelCache.note', { model })}
      </p>
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
