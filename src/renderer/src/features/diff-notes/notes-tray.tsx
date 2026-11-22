import { useState } from 'react'
import {
  ArrowDown01Icon,
  BubbleChatIcon,
  Delete02Icon,
  PencilEdit02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { MAX_NOTE_TEXT, diffNotePlace } from '@shared/diff-notes'
import { MAX_PAGE_NOTE_TEXT } from '@shared/page-notes'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { OutsideConfirm } from '@renderer/features/session/composer/held-strip'
import { outsideConfirmed } from '@renderer/features/session/composer/outside-confirmed'
import {
  readDraftNotes,
  readDraftPageNotes,
  useDraftNotes,
  useDraftPageNotes,
  writeDraftNotes,
  writeDraftPageNotes,
} from '@renderer/features/session/composer/drafts'
import { editPageNote, removePageNote } from '@renderer/features/page-notes/notes'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { errorMessage } from '@renderer/lib/host'
import { isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { editNote, removeNote, sendNotes } from './notes'

/**
 * The session's comments on diff lines waiting to go: how many, a list to read, edit or delete
 * them, Send to agent and Clear. Above the composer's box, and under the Files pane's diff. Huli:
 * with the comments on page elements from the browser pane's pick mode, which go with them.
 */
export function NotesTray({ sessionId, place }: { sessionId: string; place: 'composer' | 'pane' }) {
  const { t } = useTranslation('files')
  const notes = useDraftNotes(sessionId)
  const pageNotes = useDraftPageNotes(sessionId)
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
  const count = notes.length + pageNotes.length
  if (count === 0) return null

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
    const keptPages = [...readDraftPageNotes(sessionId)]
    writeDraftNotes(sessionId, [])
    writeDraftPageNotes(sessionId, [])
    setListOpen(false)
    toast(t('notes.cleared', { count: kept.length + keptPages.length }), {
      label: t('notes.undo'),
      onClick: () => {
        writeDraftNotes(sessionId, [...kept, ...readDraftNotes(sessionId)])
        writeDraftPageNotes(sessionId, [...keptPages, ...readDraftPageNotes(sessionId)])
      },
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
          {t('notes.count', { count })}
          <PaneIcon icon={ArrowDown01Icon} size={12} className="kp-notes-tray__chevron" />
        </PopoverTrigger>
        <PopoverContent
          side={place === 'pane' ? 'top' : 'bottom'}
          align="start"
          className="kp-notes-list w-96 max-w-[calc(100vw-32px)] gap-1 p-1.5"
        >
          <p className="px-2 pt-1 pb-0.5 text-xs text-tertiary">{t('notes.listTitle')}</p>
          {notes.map((note) => (
            <NoteRow
              key={note.id}
              place={diffNotePlace(note)}
              text={note.text}
              max={MAX_NOTE_TEXT}
              onSave={(text) => editNote(sessionId, note.id, text)}
              onDelete={() => removeNote(sessionId, note.id)}
            />
          ))}
          {pageNotes.map((note) => (
            <NoteRow
              key={note.id}
              place={note.label}
              title={`${note.selector}\n${note.url}`}
              thumb={note.shot?.thumb ?? null}
              text={note.comment}
              max={MAX_PAGE_NOTE_TEXT}
              onSave={(text) => editPageNote(sessionId, note.id, text)}
              onDelete={() => removePageNote(sessionId, note.id)}
            />
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
function NoteRow({
  place,
  title,
  thumb = null,
  text: saved,
  max,
  onSave,
  onDelete,
}: {
  place: string
  title?: string
  /** An element's screenshot, for a comment on a page. */
  thumb?: string | null
  text: string
  max: number
  onSave: (text: string) => void
  onDelete: () => void
}) {
  const { t } = useTranslation('files')
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(saved)
  const save = () => {
    if (!text.trim()) return
    onSave(text.trim())
    setEditing(false)
  }
  return (
    <div className="kp-notes-list__row">
      <div className="kp-notes-list__head">
        {thumb && <img src={thumb} alt="" className="kp-notes-list__thumb" />}
        <span className="kp-notes-list__place" title={title ?? place}>
          {place}
        </span>
        {!editing && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('notes.edit')}
            title={t('notes.edit')}
            onClick={() => {
              setText(saved)
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
          onClick={onDelete}
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
            maxLength={max}
            aria-label={t('notes.editorLabel', { place })}
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
        <p className="kp-notes-list__text">{saved}</p>
      )}
    </div>
  )
}
