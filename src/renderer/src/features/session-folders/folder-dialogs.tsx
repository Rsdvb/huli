// Huli: naming a new folder, renaming one and asking before one is deleted. Huli's own; see
// tools/huli/README.md.

import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { FOLDER_NAME_CHARS } from '@shared/session-folders'
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
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import { errorMessage } from '@renderer/lib/host'
import {
  askFolderDialog,
  createFolder,
  deleteFolder,
  renameFolder,
  useSessionFoldersStore,
  type FolderDialog,
} from './store'

/** The folder dialogs, asked for from any folder's menu, a session's or a drop. */
export function SessionFolderDialogs() {
  const dialog = useSessionFoldersStore((s) => s.dialog)
  const close = () => askFolderDialog(null)
  const naming = dialog?.kind === 'create' || dialog?.kind === 'rename' ? dialog : null
  const deleting = dialog?.kind === 'delete' ? dialog : null
  return (
    <>
      <Dialog open={naming !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          {naming && (
            <NameForm
              key={naming.kind === 'rename' ? naming.folder.id : 'create'}
              dialog={naming}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && close()}>
        <AlertDialogContent className="gap-3.5 px-5.5 data-[size=default]:sm:max-w-105">
          {deleting && <DeleteBody dialog={deleting} />}
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function cleanName(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function NameForm({
  dialog,
}: {
  dialog: Extract<FolderDialog, { kind: 'create' } | { kind: 'rename' }>
}) {
  const { t } = useTranslation(['sessionFolders', 'common'])
  const before = dialog.kind === 'rename' ? dialog.folder.name : ''
  const [name, setName] = useState(before)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const clean = cleanName(name)
  const tooLong = clean.length > FOLDER_NAME_CHARS
  const valid = clean.length > 0 && !tooLong

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    if (dialog.kind === 'rename' && clean === before) return askFolderDialog(null)
    setBusy(true)
    try {
      if (dialog.kind === 'create') await createFolder(dialog.hostId, clean, dialog.sessionIds)
      else await renameFolder(dialog.hostId, dialog.folder.id, clean)
      askFolderDialog(null)
    } catch (error) {
      setFailed(errorMessage(error))
      setBusy(false)
    }
  }

  const count = dialog.kind === 'create' ? dialog.sessionIds.length : 0
  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>
          {dialog.kind === 'create' ? t('dialog.newTitle') : t('dialog.renameTitle')}
        </DialogTitle>
        {count > 0 && <DialogDescription>{t('dialog.newWith', { count })}</DialogDescription>}
      </DialogHeader>
      <Field data-invalid={tooLong || failed !== null || undefined}>
        <FieldLabel htmlFor="huli-folder-name" className="sr-only">
          {t('dialog.name')}
        </FieldLabel>
        <Input
          id="huli-folder-name"
          value={name}
          placeholder={t('dialog.name')}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-invalid={tooLong || failed !== null || undefined}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setName(event.target.value)
            setFailed(null)
          }}
        />
        {tooLong && <FieldError>{t('dialog.tooLong', { count: FOLDER_NAME_CHARS })}</FieldError>}
        {failed !== null && <FieldError>{failed}</FieldError>}
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button type="submit" disabled={!valid || busy}>
          {dialog.kind === 'create' ? t('dialog.create') : t('dialog.rename')}
        </Button>
      </DialogFooter>
    </form>
  )
}

function DeleteBody({ dialog }: { dialog: Extract<FolderDialog, { kind: 'delete' }> }) {
  const { t } = useTranslation(['sessionFolders', 'common'])
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{t('dialog.deleteTitle', { name: dialog.folder.name })}</AlertDialogTitle>
      </AlertDialogHeader>
      <AlertDialogDescription className="text-small text-tertiary">
        {t('dialog.deleteBody')}
      </AlertDialogDescription>
      <AlertDialogFooter className="pt-1">
        <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          onClick={() => {
            askFolderDialog(null)
            void deleteFolder(dialog.hostId, dialog.folder.id)
          }}
        >
          {t('dialog.delete')}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}
