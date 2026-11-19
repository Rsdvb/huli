import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { OutsideKind } from '@shared/thread'
import { fadeExit } from '@renderer/lib/motion'
import { Glyph } from '@renderer/features/shell/glyph'
import { confirmOutside } from './outside-confirmed'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'

/** The note at the top of the composer's box while a program outside Kettu has the session open. */
export function HeldStrip({ by, busy }: { by: OutsideKind; busy: boolean }) {
  const { t } = useTranslation('composer')
  // Huli: the Claude desktop app and other programs have no /exit; what they write comes in.
  const text =
    by === 'terminal'
      ? t('heldOutside.strip')
      : by === 'desktop'
        ? t(busy ? 'heldOutside.desktopBusy' : 'heldOutside.desktop')
        : t(busy ? 'heldOutside.otherBusy' : 'heldOutside.other')
  return (
    <motion.div
      exit={fadeExit}
      className="kettu-switch flex w-full animate-in items-center gap-x-2.5 fade-in animation-duration-(--duration-fast)"
    >
      <Glyph icon={ComputerTerminal01Icon} className="size-4 shrink-0 text-tertiary" />
      <p className="min-w-0 flex-1 text-primary">{text}</p>
    </motion.div>
  )
}

/**
 * Huli: asks once before a message goes on with a session a program outside Kettu still has open
 * but idle, since two writers of one transcript tangle it. Cancel leaves the message in the
 * composer.
 */
export function OutsideConfirm({
  sessionId,
  by,
  onAnswer,
}: {
  sessionId: string
  /** What has it open; null while nothing is asked. */
  by: OutsideKind | null
  onAnswer: (go: boolean) => void
}) {
  const { t } = useTranslation(['composer', 'common'])
  const body =
    by === 'desktop'
      ? t('heldOutside.confirmDesktop')
      : by === 'terminal'
        ? t('heldOutside.confirmTerminal')
        : t('heldOutside.confirmOther')
  return (
    <AlertDialog open={by !== null} onOpenChange={(open) => !open && onAnswer(false)}>
      <AlertDialogContent className="gap-0 px-5.5 pt-5 pb-4.5 data-[size=default]:sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('heldOutside.confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-4.5">
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              confirmOutside(sessionId)
              onAnswer(true)
            }}
          >
            {t('heldOutside.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
