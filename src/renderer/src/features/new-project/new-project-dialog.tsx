// Huli: Add project's Clone from Git and New empty project: the repository's address, where the
// folder goes among the places the host offers (or, for this computer, any folder its dialog
// picks) and its name, then the clone's progress with a way to cancel it. The host checks it all
// again.

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Project } from '@shared/agent-host'
import {
  cloneFolderName,
  cloneUrlProblem,
  GITIGNORE_PRESETS,
  isGitignorePreset,
  projectNameProblem,
  type GitignorePreset,
  type ProjectPlace,
  type ProjectPlaces,
} from '@shared/project-create'
import { newSession } from '@renderer/app/actions'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Progress } from '@renderer/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useOtherHost } from '@renderer/stores/hosts'
import {
  cloneEnded,
  cloneStarted,
  closeNewProject,
  useNewProjectStore,
  type NewProjectDialog,
} from './store'

// The value of the location menu's item that opens the system's folder dialog.
const CHOOSE = '\0choose'
const NO_GITIGNORE = 'none'

type Field = 'url' | 'parent' | 'name'
type Failure = { field: Field | null; message: string }

export function NewProjectDialogHost() {
  const dialog = useNewProjectStore((s) => s.dialog)
  const [busy, setBusy] = useState(false)
  // The dialog keeps its last content while it closes, so it leaves as it was.
  const [shown, setShown] = useState(dialog)
  if (dialog !== null && dialog !== shown) setShown(dialog)
  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => {
        // A clone or a creation that runs ends with its own Cancel, not with Escape.
        if (!open && !busy) closeNewProject()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="grid-cols-[minmax(0,1fr)] gap-0 p-0 sm:max-w-120"
      >
        {shown && (
          <NewProjectForm
            key={`${shown.kind}:${shown.hostId ?? ''}`}
            dialog={shown}
            onBusy={setBusy}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function failureOf(error: unknown): Failure & { cancelled: boolean } {
  const data = (error as { data?: { field?: unknown; reason?: unknown } } | null)?.data
  const field = data?.field
  return {
    field: field === 'url' || field === 'parent' || field === 'name' ? field : null,
    message: errorMessage(error),
    cancelled: data?.reason === 'cancelled',
  }
}

/** The path's separator as its host writes it. */
function separatorOf(path: string): string {
  return /^[A-Za-z]:\\|^\\\\/.test(path) ? '\\' : '/'
}

function joinPath(folder: string, name: string): string {
  const sep = separatorOf(folder)
  return folder.endsWith(sep) ? `${folder}${name}` : `${folder}${sep}${name}`
}

/** The path from the home folder's `~`, as the host writes it. */
function shortPath(path: string, home: string | null): string {
  if (home === null) return path
  const windows = separatorOf(home) === '\\'
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (same(path, home)) return '~'
  const prefix = home.endsWith(separatorOf(home)) ? home : `${home}${separatorOf(home)}`
  if (path.length > prefix.length && same(path.slice(0, prefix.length), prefix)) {
    return `~${separatorOf(home)}${path.slice(prefix.length)}`
  }
  return path
}

function NewProjectForm({
  dialog,
  onBusy,
}: {
  dialog: NewProjectDialog
  onBusy: (busy: boolean) => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const { kind, hostId } = dialog
  const host = useOtherHost(hostId)
  // A browser shows another computer's host, which takes only the places it offers.
  const canChoose = hostId === null && !isWeb
  const [places, setPlaces] = useState<ProjectPlaces | null>(null)
  const [placesError, setPlacesError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [urlTouched, setUrlTouched] = useState(false)
  const [typedName, setTypedName] = useState<string | null>(null)
  const [readme, setReadme] = useState(true)
  const [gitignore, setGitignore] = useState<GitignorePreset | null>(null)
  const [cloneId, setCloneId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const progress = useNewProjectStore((s) =>
    cloneId === null ? null : (s.clones[cloneId] ?? null),
  )
  const busy = cloneId !== null || creating

  useEffect(() => onBusy(busy), [busy, onBusy])

  useEffect(() => {
    let live = true
    hostAt(hostId, 'projects.places', undefined).then(
      (found) => {
        if (!live) return
        setPlaces(found)
        setParent((current) => current ?? found.last ?? found.places[0]?.path ?? null)
      },
      (error: unknown) => live && setPlacesError(errorMessage(error)),
    )
    return () => {
      live = false
    }
  }, [hostId])

  const trimmed = url.trim()
  const urlProblem = kind === 'clone' ? cloneUrlProblem(trimmed) : null
  // Named after the repository until the user names it, once the address is one.
  const name =
    typedName ?? (kind === 'clone' && urlProblem === null ? cloneFolderName(trimmed) : '')
  const nameProblem = projectNameProblem(name)
  const home = places?.places.find((place) => place.kind === 'home')?.path ?? null
  const listed: ProjectPlace[] = [
    ...(places?.places ?? []),
    ...(picked !== null && !places?.places.some((place) => place.path === picked)
      ? [{ path: picked, kind: 'project' as const }]
      : []),
  ]
  const ready = !busy && parent !== null && urlProblem === null && nameProblem === null
  const shownUrlProblem = urlTouched && trimmed !== '' ? urlProblem : null
  const shownNameProblem = name !== '' ? nameProblem : null
  const fieldFailure = (field: Field) => (failure?.field === field ? failure.message : null)

  const choose = async (): Promise<void> => {
    const folder = await window.kettu.dialogs.chooseNewProjectParent(parent)
    if (folder === null) return
    setPicked(folder)
    setParent(folder)
    setFailure(null)
  }

  const finish = (project: Project): void => {
    closeNewProject()
    ;(dialog.onDone ?? newSession)(project.path)
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setUrlTouched(true)
    if (!ready || parent === null) return
    setFailure(null)
    if (kind === 'clone') {
      const id = randomId()
      cloneStarted(id)
      setCloneId(id)
      try {
        finish(await hostAt(hostId, 'projects.clone', { cloneId: id, url: trimmed, parent, name }))
      } catch (error) {
        const failed = failureOf(error)
        if (!failed.cancelled) setFailure(failed)
      } finally {
        cloneEnded(id)
        setCloneId(null)
      }
      return
    }
    setCreating(true)
    try {
      finish(await hostAt(hostId, 'projects.create', { parent, name, readme, gitignore }))
    } catch (error) {
      setFailure(failureOf(error))
    } finally {
      setCreating(false)
    }
  }

  const cancel = (): void => {
    if (cloneId !== null) {
      void hostAt(hostId, 'projects.cancelClone', { cloneId }).catch(() => {})
      return
    }
    if (!creating) closeNewProject()
  }

  const hostName = host?.name ?? null
  const description =
    hostName === null
      ? t(kind === 'clone' ? 'newProject.clone.description' : 'newProject.empty.description')
      : t(kind === 'clone' ? 'newProject.clone.descriptionOn' : 'newProject.empty.descriptionOn', {
          host: hostName,
        })

  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <DialogHeader className="px-5.5 pt-5">
        <DialogTitle>
          {t(kind === 'clone' ? 'newProject.clone.title' : 'newProject.empty.title')}
        </DialogTitle>
        <DialogDescription className="text-control leading-normal">{description}</DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col px-5.5 pt-1.5">
        {kind === 'clone' && (
          <>
            <Label htmlFor="huli-new-project-url">{t('newProject.url.label')}</Label>
            <Input
              id="huli-new-project-url"
              value={url}
              placeholder={t('newProject.url.placeholder')}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              className="font-mono text-command"
              aria-invalid={shownUrlProblem !== null || fieldFailure('url') !== null || undefined}
              onChange={(event) => {
                setUrl(event.target.value)
                setFailure(null)
              }}
              onBlur={() => setUrlTouched(true)}
              onPaste={() => setUrlTouched(true)}
            />
            <FieldNote
              text={
                shownUrlProblem !== null
                  ? t(`newProject.url.${shownUrlProblem}`)
                  : fieldFailure('url')
              }
            />
          </>
        )}
        <Label htmlFor="huli-new-project-parent">{t('newProject.parent.label')}</Label>
        {placesError !== null ? (
          <p role="alert" className="text-small text-danger">
            {t('newProject.parent.loadFailed', { error: placesError })}
          </p>
        ) : places === null ? (
          <Skeleton className="h-8.5 w-full rounded-lg" />
        ) : listed.length === 0 && !canChoose ? (
          <p className="text-small text-secondary">{t('newProject.parent.none')}</p>
        ) : (
          <Select
            value={parent}
            items={[
              ...listed.map((place) => ({ value: place.path, label: shortPath(place.path, home) })),
              ...(canChoose ? [{ value: CHOOSE, label: t('newProject.parent.choose') }] : []),
            ]}
            disabled={busy}
            onValueChange={(next) => {
              if (next === CHOOSE) void choose()
              else if (typeof next === 'string') {
                setParent(next)
                setFailure(null)
              }
            }}
          >
            <SelectTrigger
              id="huli-new-project-parent"
              aria-invalid={fieldFailure('parent') !== null || undefined}
              className="w-full text-control data-[size=default]:h-8.5 [&>svg:last-child]:size-3.25 [&>svg:last-child]:text-tertiary"
            >
              <SelectValue className="min-w-0">
                {(value: string | null) => {
                  const place = listed.find((item) => item.path === value)
                  return place ? <PlaceLabel place={place} home={home} /> : null
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {listed.length > 0 && (
                <SelectGroup>
                  {listed.map((place) => (
                    <SelectItem key={place.path} value={place.path} title={place.path}>
                      <PlaceLabel place={place} home={home} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {canChoose && (
                <>
                  {listed.length > 0 && <SelectSeparator />}
                  <SelectGroup>
                    <SelectItem value={CHOOSE}>{t('newProject.parent.choose')}</SelectItem>
                  </SelectGroup>
                </>
              )}
            </SelectContent>
          </Select>
        )}
        <FieldNote text={fieldFailure('parent')} />
        <Label htmlFor="huli-new-project-name">{t('newProject.name.label')}</Label>
        <Input
          id="huli-new-project-name"
          value={name}
          autoFocus={kind === 'empty'}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-invalid={shownNameProblem !== null || fieldFailure('name') !== null || undefined}
          onChange={(event) => {
            setTypedName(event.target.value)
            setFailure(null)
          }}
        />
        <FieldNote
          text={
            shownNameProblem !== null
              ? t(`newProject.name.${shownNameProblem}`)
              : fieldFailure('name')
          }
          hint={
            parent !== null && name !== '' && nameProblem === null
              ? t('newProject.name.target', { path: shortPath(joinPath(parent, name), home) })
              : null
          }
        />
        {kind === 'empty' && (
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2.5">
            <label className="flex items-center gap-2 text-control text-primary">
              <Checkbox
                checked={readme}
                disabled={busy}
                onCheckedChange={(value) => setReadme(value === true)}
              />
              {t('newProject.readme')}
            </label>
            <div className="flex items-center gap-2">
              <label htmlFor="huli-new-project-gitignore" className="text-control text-primary">
                {t('newProject.gitignore.label')}
              </label>
              <Select
                value={gitignore ?? NO_GITIGNORE}
                items={[
                  { value: NO_GITIGNORE, label: t('newProject.gitignore.none') },
                  ...GITIGNORE_PRESETS.map((preset) => ({
                    value: preset,
                    label: t(`newProject.gitignore.${preset}`),
                  })),
                ]}
                disabled={busy}
                onValueChange={(next) => setGitignore(isGitignorePreset(next) ? next : null)}
              >
                <SelectTrigger
                  id="huli-new-project-gitignore"
                  className="min-w-28 text-control data-[size=default]:h-8 [&>svg:last-child]:size-3.25 [&>svg:last-child]:text-tertiary"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NO_GITIGNORE}>{t('newProject.gitignore.none')}</SelectItem>
                  </SelectGroup>
                  <SelectSeparator />
                  <SelectGroup>
                    {GITIGNORE_PRESETS.map((preset) => (
                      <SelectItem key={preset} value={preset}>
                        {t(`newProject.gitignore.${preset}`)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        {cloneId !== null && (
          <div className="mt-3.5 flex flex-col gap-2" aria-live="polite">
            <div className="flex items-center gap-2 text-control text-secondary">
              {progress?.percent == null && <Spinner className="size-3.5" />}
              <span className="min-w-0 flex-1 truncate">
                {t(`newProject.phase.${progress?.phase ?? 'connecting'}`)}
              </span>
              {progress?.percent != null && (
                <span className="tabular text-tertiary">
                  {t('newProject.percent', { percent: progress.percent })}
                </span>
              )}
            </div>
            <Progress value={progress?.percent ?? 0} />
          </div>
        )}
        {failure !== null && failure.field === null && (
          <p
            role="alert"
            className="mt-3.5 max-h-40 overflow-y-auto rounded-code bg-subtle px-3 py-2.5 font-mono text-small leading-normal whitespace-pre-wrap text-danger [overflow-wrap:anywhere]"
          >
            {failure.message}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-5.5 py-4.5 *:data-[slot=button]:h-7.5">
        <Button type="button" variant="outline" size="compact" disabled={creating} onClick={cancel}>
          {cloneId !== null ? t('newProject.clone.cancel') : t('common:actions.cancel')}
        </Button>
        <Button type="submit" size="compact" disabled={!ready}>
          {busy && <Spinner data-icon="inline-start" />}
          {t(kind === 'clone' ? 'newProject.clone.submit' : 'newProject.empty.submit')}
        </Button>
      </div>
    </form>
  )
}

/** A place as the menu lists it: its path from `~`, and why it is offered when not a project's. */
function PlaceLabel({ place, home }: { place: ProjectPlace; home: string | null }) {
  const { t } = useTranslation('sidebar')
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <span className="min-w-0 flex-1 truncate font-mono text-command">
        {shortPath(place.path, home)}
      </span>
      {place.kind !== 'project' && (
        <span className="shrink-0 text-hint text-tertiary">
          {t(place.kind === 'last' ? 'newProject.parent.last' : 'newProject.parent.home')}
        </span>
      )}
    </span>
  )
}

function Label({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mt-3 mb-1.5 text-control font-medium text-primary">
      {children}
    </label>
  )
}

/** A field's problem in the danger color, else a hint; the line keeps no room when empty. */
function FieldNote({ text, hint = null }: { text: string | null; hint?: string | null }) {
  if (text === null && hint === null) return null
  return (
    <p
      role={text !== null ? 'alert' : undefined}
      className={cn(
        'mt-1.5 truncate text-small',
        text !== null ? 'text-danger [overflow-wrap:anywhere] whitespace-normal' : 'text-tertiary',
      )}
      title={text ?? hint ?? undefined}
    >
      {text ?? hint}
    </p>
  )
}

export default NewProjectDialogHost
