import { CommandLineIcon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Glyph } from '@renderer/features/shell/glyph'
import { fadeExit } from '@renderer/lib/motion'

/**
 * Huli: the line at the top of the composer's box while a Codex session's message starts with
 * `!`: it goes as a shell command Codex runs in the session's folder, not as a message.
 */
export function ShellStrip({ asks }: { asks: boolean }) {
  const { t } = useTranslation('composer')
  return (
    <motion.div
      role="status"
      exit={fadeExit}
      className="kettu-switch flex w-full animate-in items-center gap-2.5 fade-in animation-duration-(--duration-fast)"
    >
      <Glyph icon={CommandLineIcon} className="size-4 shrink-0 text-tertiary" />
      <p className="min-w-0 flex-1 text-primary">{t(asks ? 'shell.noteAsks' : 'shell.note')}</p>
    </motion.div>
  )
}
