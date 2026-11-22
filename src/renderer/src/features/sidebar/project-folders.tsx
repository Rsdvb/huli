import { useEffect, useState, type ReactNode } from 'react'
import {
  Cancel01Icon,
  Folder01Icon,
  FolderAddIcon,
  GitBranchIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { FolderSuggestion, Project } from '@shared/agent-host'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { useProjectsStore } from '@renderer/stores/projects'
import { useProjectFolders } from './project-folders-model'

/**
 * Huli: a project's folders: its own, the further folders its sessions also work in, and the
 * repositories and workspace folders found in it to add. Mounted once for the window.
 */
export function ProjectFoldersDialog() {
  const shown = useProjectFolders((s) => s.shown)
  // The last project stays drawn while the dialog closes.
  const [drawn, setDrawn] = useState(shown)
  if (shown && shown !== drawn) setDrawn(shown)
  const close = () => useProjectFolders.setState({ shown: null })
  return (
    <Dialog open={shown !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-130">
        {drawn && <FoldersForm key={drawn.id} projectPath={drawn.path} />}
      </DialogContent>
    </Dialog>
  )
}

type Found = { list: FolderSuggestion[]; error: null } | { list: null; error: string } | null

function FoldersForm({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation(['sidebar', 'common'])
  const project = useProjectsStore((s) => s.projects.find((p) => p.path === projectPath) ?? null)
  const [found, setFound] = useState<Found>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const folders = project?.folders ?? []
  const listed = folders.map((folder) => folder.path).join('\n')

  // Read from the disk only while the dialog is open, again as its folders change.
  useEffect(() => {
    let live = true
    host('projects.suggestFolders', { path: projectPath }).then(
      (list) => live && setFound({ list, error: null }),
      (failure: unknown) => live && setFound({ list: null, error: errorMessage(failure) }),
    )
    return () => {
      live = false
    }
  }, [projectPath, listed])

  const run = async (key: string, work: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(key)
    setError(null)
    try {
      await work()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(null)
    }
  }
  const add = (folder: string) =>
    host('projects.addFolder', { path: projectPath, folder }).then(receive)
  const addChosen = () =>
    run('choose', async () => {
      const folder = await window.kettu.dialogs.chooseProjectFolder()
      if (folder) await add(folder)
    })
  const addAll = (list: FolderSuggestion[]) =>
    run('all', async () => {
      for (const item of list) await add(item.path)
    })
  const remove = (folder: { path: string; name: string }) =>
    run(folder.path, async () => {
      await host('projects.removeFolder', { path: projectPath, folder: folder.path })
      toast(t('projectFolders.removed', { name: folder.name }))
    })

  if (!project) return null
  const offered = found?.list ?? []
  return (
    <>
      <DialogHeader className="px-5.5 pt-5">
        <DialogTitle className="truncate">
          {t('projectFolders.title', { project: project.name })}
        </DialogTitle>
        <DialogDescription className="text-small text-tertiary">
          {t('projectFolders.description')}
        </DialogDescription>
      </DialogHeader>
      <div className="flex max-h-[min(520px,70svh)] min-h-0 flex-col overflow-y-auto overscroll-contain px-5.5 pt-3.5">
        <ul className="flex flex-col rounded-[10px] bg-(--shell-chip) p-1">
          <FolderRow
            name={project.name}
            path={project.path}
            badge={<Badge variant="neutral">{t('projectFolders.own')}</Badge>}
          />
          {folders.map((folder) => (
            <FolderRow
              key={folder.path}
              name={folder.name}
              path={folder.path}
              badge={
                folder.missing ? (
                  <Badge variant="warning">{t('projectFolders.missing')}</Badge>
                ) : null
              }
              action={
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('projectFolders.remove', { name: folder.name })}
                        disabled={busy !== null}
                        onClick={() => void remove(folder)}
                      />
                    }
                  >
                    {busy === folder.path ? (
                      <Spinner className="size-3" />
                    ) : (
                      <Glyph icon={Cancel01Icon} size={14} />
                    )}
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('projectFolders.remove', { name: folder.name })}
                  </TooltipContent>
                </Tooltip>
              }
            />
          ))}
        </ul>
        {folders.length === 0 && (
          <p className="mt-2 text-small leading-normal text-tertiary">{t('projectFolders.none')}</p>
        )}
        <div className="mt-2.5">
          <Button
            type="button"
            variant="outline"
            size="compact"
            disabled={busy !== null}
            onClick={() => void addChosen()}
          >
            {busy === 'choose' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Glyph icon={FolderAddIcon} size={15} data-icon="inline-start" />
            )}
            {t('projectFolders.add')}
          </Button>
        </div>
        {error !== null && (
          <p role="alert" className="mt-2.5 text-small leading-normal text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center gap-2">
          <h3 className="min-w-0 flex-1 text-control font-medium text-primary">
            {t('projectFolders.found')}
          </h3>
          {offered.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy !== null}
              onClick={() => void addAll(offered)}
            >
              {busy === 'all' && <Spinner data-icon="inline-start" />}
              {t('projectFolders.addAll')}
            </Button>
          )}
        </div>
        <p className="mt-0.5 text-small leading-normal text-tertiary">
          {t('projectFolders.foundHint')}
        </p>
        {found === null ? (
          <div
            aria-busy
            aria-label={t('projectFolders.searching')}
            className="mt-2 flex flex-col gap-2"
          >
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-4/5" />
          </div>
        ) : found.error !== null ? (
          <p className="mt-2 text-small leading-normal text-danger">{found.error}</p>
        ) : offered.length === 0 ? (
          <p className="mt-2 text-small leading-normal text-secondary">
            {t('projectFolders.noneFound')}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col rounded-[10px] border border-subtle p-1">
            {offered.map((item) => (
              <FolderRow
                key={item.path}
                name={item.name}
                path={item.path}
                repo={item.repo}
                badge={
                  item.source === 'workspace' ? (
                    <Badge variant="neutral">{t('projectFolders.workspace')}</Badge>
                  ) : null
                }
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={busy !== null}
                    onClick={() => void run(item.path, () => add(item.path))}
                  >
                    {busy === item.path && <Spinner data-icon="inline-start" />}
                    {t('projectFolders.addFound')}
                  </Button>
                }
              />
            ))}
          </ul>
        )}
        {folders.length > 0 && (
          <p className="mt-4 text-small leading-normal text-tertiary">
            {t('projectFolders.worktrees')}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-5.5 py-4.5 *:data-[slot=button]:h-7.5">
        <DialogClose render={<Button type="button" size="compact" />}>
          {t('projectFolders.done')}
        </DialogClose>
      </div>
    </>
  )
}

/** The project as the host answered once a folder was added, which the list shows at once. */
function receive(project: Project): void {
  useProjectsStore.setState((s) => ({
    projects: s.projects.map((p) => (p.path === project.path ? project : p)),
  }))
}

function FolderRow({
  name,
  path,
  repo,
  badge,
  action,
}: {
  name: string
  path: string
  repo?: boolean
  badge?: ReactNode
  action?: ReactNode
}) {
  return (
    <li className="flex min-h-11 items-center gap-2.5 rounded-[7px] px-2.5 py-1.5">
      <Glyph
        icon={repo ? GitBranchIcon : Folder01Icon}
        size={16}
        className="shrink-0 text-tertiary"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-control font-medium text-primary">{name}</span>
          {badge}
        </span>
        <span className="truncate font-mono text-meta text-tertiary" title={path}>
          {path}
        </span>
      </span>
      {action}
    </li>
  )
}
