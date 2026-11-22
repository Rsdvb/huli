import { useState } from 'react'
import {
  ArrowDown01Icon,
  BubbleChatIcon,
  Delete02Icon,
  PencilEdit02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { MAX_NOTE_TEXT, diffNotePlace, type DiffNote } from '@shared/diff-notes'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { OutsideConfirm } from '@renderer/features/session/composer/held-strip'
import { outsideConfirmed } from '@renderer/features/session/composer/outside-confirmed'
import {
  readDraftNotes,
  useDraftNotes,
  writeDraftNotes,
} from '@renderer/features/session/composer/drafts'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { errorMessage } from '@renderer/lib/host'
import { isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { editNote, removeNote, sendNotes } from './notes'

/**
 * The session's comments on diff lines waiting to go: how many, a list to read, edit or delete
 * them, Send to agent and Clear. Above the composer's box, and under the Files pane's diff.
 */
export function NotesTray({ sessionId, place }: { sessionId: string; place: 'composer' | 'pane' }) {
  const { t } = useTranslation('files')
  const notes = useDraftNotes(sessionId)
  const listed = useSessionsStore((s) => s.byId[sessionId]?.status ?? null)
  const status = useThreadsStore((s) => s.replicas[sessionId]?.state?.session.status) ?? listed
  const heldOutside = useThreadsStore(
    (s) => s.replicas[sessionId]?.state?.session.heldOutside === true,
  )
  const openOutside = useThreadsStore(
    (s) => s.replicas[sessionId]?.state?.session.openOutside ?? null,
  )
  const [sending, setSending] = useState(false)
  const [asking, setAsking] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  if (notes.length === 0) return null

  const unavailable = status === null || status === 'starting' || heldOutside
  const send = () => {
    if (sending || unavailable) return
    const idle = status === 'ready' || status === 'closed'
    if (openOutside && idle && !outsideConfirmed(sessionId)) {
      setAsking(true)
      return
    }
    setSending(true)
    setListOpen(false)
    sendNotes(sessionId)
      .then(
        () => {
          if (!idle) toast(t('notes.queued'), undefined, { tone: 'info' })
        },
        (error: unknown) =>
          toast(t('notes.sendFailed', { error: errorMessage(error) }), undefined, {
            tone: 'warning',
          }),
      )
      .finally(() => setSending(false))
  }
  const clear = () => {
    const kept = [...readDraftNotes(sessionId)]
    writeDraftNotes(sessionId, [])
    setListOpen(false)
    toast(t('notes.cleared', { count: kept.length }), {
      label: t('notes.undo'),
      onClick: () => writeDraftNotes(sessionId, [...kept, ...readDraftNotes(sessionId)]),
    })
  }

  return (
    <div
      data-notes-tray={place}
      className={cn(
        'kp-notes-tray',
        place === 'composer' &&
          'kettu-switch animate-in fade-in animation-duration-(--duration-fast)',
      )}
    >
      <Popover open={listOpen} onOpenChange={setListOpen}>
        <PopoverTrigger
          render={<button type="button" className="kp-notes-tray__count focus-ring" />}
        >
          <PaneIcon icon={BubbleChatIcon} size={14} />
          {t('notes.count', { count: notes.length })}
          <PaneIcon icon={ArrowDown01Icon} size={12} className="kp-notes-tray__chevron" />
        </PopoverTrigger>
        <PopoverContent
          side={place === 'pane' ? 'top' : 'bottom'}
          align="start"
          className="kp-notes-list w-96 max-w-[calc(100vw-32px)] gap-1 p-1.5"
        >
          <p className="px-2 pt-1 pb-0.5 text-xs text-tertiary">{t('notes.listTitle')}</p>
          {notes.map((note) => (
            <NoteRow key={note.id} sessionId={sessionId} note={note} />
          ))}
        </PopoverContent>
      </Popover>
      <span className="kp-notes-tray__acts">
        <Button
          size="xs"
          // The composer's box resets a solid button's fill, so its strips use outline ones.
          variant={place === 'composer' ? 'outline' : 'default'}
          disabled={sending || unavailable}
          title={unavailable ? t('notes.unavailable') : undefined}
          onClick={send}
        >
          {sending && <Spinner className="size-3" />}
          {t('notes.send')}
        </Button>
        <Button size="xs" variant="ghost" disabled={sending} onClick={clear}>
          {t('notes.clear')}
        </Button>
      </span>
      <OutsideConfirm
        sessionId={sessionId}
        by={asking ? openOutside : null}
        onAnswer={(go) => {
          setAsking(false)
          if (go) send()
        }}
      />
    </div>
  )
}

/** A comment in the tray's list: where, what, and Edit and Delete. */
function NoteRow({ sessionId, note }: { sessionId: string; note: DiffNote }) {
  const { t } = useTranslation('files')
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(note.text)
  const save = () => {
    if (!text.trim()) return
    editNote(sessionId, note.id, text.trim())
    setEditing(false)
  }
  return (
    <div className="kp-notes-list__row">
      <div className="kp-notes-list__head">
        <span className="kp-notes-list__place" title={diffNotePlace(note)}>
          {diffNotePlace(note)}
        </span>
        {!editing && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('notes.edit')}
            title={t('notes.edit')}
            onClick={() => {
              setText(note.text)
              setEditing(true)
            }}
          >
            <PaneIcon icon={PencilEdit02Icon} size={13} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('notes.delete')}
          title={t('notes.delete')}
          onClick={() => removeNote(sessionId, note.id)}
        >
          <PaneIcon icon={Delete02Icon} size={13} />
        </Button>
      </div>
      {editing ? (
        <div className="kp-notes-list__edit">
          <textarea
            autoFocus
            value={text}
            rows={3}
            maxLength={MAX_NOTE_TEXT}
            aria-label={t('notes.editorLabel', { place: diffNotePlace(note) })}
            className="kp-note-editor__text"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.stopPropagation()
                setEditing(false)
              }
              if (
                event.key === 'Enter' &&
                isMod(event.nativeEvent) &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault()
                save()
              }
            }}
          />
          <div className="kp-note-editor__foot">
            <span className="flex-1" />
            <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
              {t('notes.cancel')}
            </Button>
            <Button size="xs" disabled={!text.trim()} onClick={save}>
              {t('notes.update')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="kp-notes-list__text">{note.text}</p>
      )}
    </div>
  )
}
