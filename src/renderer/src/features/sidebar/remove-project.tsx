import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/agent-host'
import { binKey } from '@shared/recycle-bin'
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
import { toast } from '@renderer/components/ui/toast'
import { binnedToast, movedTitle } from '@renderer/features/recycle-bin/undo'
import { useHostHasBin } from '@renderer/features/recycle-bin/support'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { findProjectForSession, useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useHostLabel } from './host-label'
import { isRunning } from './session-menu-model'

/**
 * Asks before the host removes a project: its sessions, archived ones included, leave Kettu and
 * running ones stop first, while its folder stays.
 */
export function RemoveProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const hostId = hostOfPath(project.path)
  const hostName = useHostLabel(hostId)
  const binOn = useHostHasBin(hostId)
  const projects = useProjectsStore((s) => s.projects)
  // A sub-agent is part of its session, so it is not counted on its own.
  const [sessions, running] = useSessionsStore(
    useShallow((s) => {
      const own = Object.values(s.byId).filter(
        (x) =>
          !x.scratch &&
          x.origin !== 'subagent' &&
          findProjectForSession(projects, x)?.path === project.path,
      )
      return [own.length, own.filter(isRunning).length]
    }),
  )
  const remove = async () => {
    onOpenChange(false)
    try {
      await useProjectsStore.getState().remove(project.path)
      // Huli: it waits in the recycle bin with its sessions; Undo puts them back.
      binnedToast(movedTitle(project.name), [binKey('project', hostPath(project.path))], hostId)
    } catch (error) {
      toast(errorMessage(error))
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="gap-3.5 px-5.5 data-[size=default]:sm:max-w-105">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('project.remove.title', { name: project.name })}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogDescription className="text-small text-tertiary">
          {[
            binOn
              ? sessions > 0
                ? t('project.remove.sessions', { count: sessions })
                : t('project.remove.noSessions')
              : sessions > 0
                ? t('project.remove.sessionsForGood', { count: sessions })
                : t('project.remove.noSessionsForGood'),
            running > 0 && t('project.remove.running', { count: running }),
            !project.missing &&
              (hostId === null
                ? t('project.remove.folderStays')
                : t('project.remove.folderStaysOn', { host: hostName })),
          ]
            .filter(Boolean)
            .join(t('project.remove.separator'))}
        </AlertDialogDescription>
        <AlertDialogFooter className="pt-1">
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void remove()}>
            {t('project.remove.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
