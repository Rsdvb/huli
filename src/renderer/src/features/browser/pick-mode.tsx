// Huli: the browser pane's pick mode. Main outlines the element under the pointer with the page's
// own inspect overlay; a click there freezes the page into a still, and the comment's box opens at
// the element over it. A comment joins the session's comment tray, which sends it to the agent
// with the others. Escape, in the page or the pane, ends the mode.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { CursorAddSelection01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { MAX_PAGE_NOTE_TEXT, sourceText, type ElementPick } from '@shared/page-notes'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { NotesTray } from '@renderer/features/diff-notes/notes-tray'
import { addPageNote, pageNotesFull } from '@renderer/features/page-notes/notes'
import { useNoteCount } from '@renderer/features/session/composer/drafts'
import { PaneIcon, PanelButton } from '@renderer/features/shell/panel-button'
import { errorMessage } from '@renderer/lib/host'
import { isMac, isMod } from '@renderer/lib/platform'
import { useBrowserStore } from '@renderer/stores/browser'
import { startPicking, stopPicking } from './pick'

/** The address row's toggle. */
export function PickToggle({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const { t } = useTranslation('browser')
  const on = useBrowserStore((s) => !!s.picking[sessionId])
  return (
    <PanelButton
      label={on ? t('pick.stop') : t('pick.toggle')}
      pressed={on}
      disabled={disabled && !on}
      className="kp-pick-toggle"
      onClick={() => (on ? stopPicking(sessionId) : void startPicking(sessionId))}
    >
      <PaneIcon icon={CursorAddSelection01Icon} />
    </PanelButton>
  )
}

/** Over the page while picking: what to do, and that Escape stops. */
export function PickHint({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('browser')
  const on = useBrowserStore((s) => !!s.picking[sessionId])
  // Escape with the pane focused ends the mode too; in the page main hears it.
  useEffect(() => {
    if (!on) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (useBrowserStore.getState().picked[sessionId]) return
      stopPicking(sessionId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [on, sessionId])
  if (!on) return null
  return (
    <div role="status" className="kp-pick-hint">
      <PaneIcon icon={CursorAddSelection01Icon} size={14} />
      <span className="kp-pick-hint__text">{t('pick.hint')}</span>
      <button type="button" className="kp-link" onClick={() => stopPicking(sessionId)}>
        {t('pick.done')}
      </button>
    </div>
  )
}

/** Under the page: the session's comments waiting to go, while it has some. */
export function PickTray({ sessionId }: { sessionId: string }) {
  const count = useNoteCount(sessionId)
  if (count === 0) return null
  return (
    <div className="kp-pick-foot">
      <NotesTray sessionId={sessionId} place="pane" />
    </div>
  )
}

/** The height the comment's box takes below an element before it goes above it instead. */
const EDITOR_ROOM = 190
const EDITOR_WIDTH = 340
const GAP = 8

/**
 * Over the still of the page: the picked element's outline and the comment's box at it. `zoom`
 * is the window's, which the view's pixels are divided by to be the pane's.
 */
export function PickLayer({
  sessionId,
  pick,
  hostId,
  zoom,
}: {
  sessionId: string
  pick: ElementPick
  hostId: string | null
  zoom: number
}) {
  const { t } = useTranslation('browser')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [area, setArea] = useState<{ width: number; height: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setArea({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (area) field.current?.focus()
  }, [area])

  const box = {
    left: pick.frame.x / zoom,
    top: pick.frame.y / zoom,
    width: pick.frame.width / zoom,
    height: pick.frame.height / zoom,
  }
  const room = area ?? { width: 0, height: 0 }
  const below = box.top + box.height + GAP
  const fitsBelow = below + EDITOR_ROOM <= room.height || box.top < EDITOR_ROOM
  const width = Math.min(EDITOR_WIDTH, room.width - 2 * GAP)
  const left = Math.max(GAP, Math.min(box.left, room.width - width - GAP))
  const place: CSSProperties = fitsBelow
    ? { top: Math.min(Math.max(GAP, below), Math.max(GAP, room.height - EDITOR_ROOM)), left, width }
    : { bottom: Math.max(GAP, room.height - box.top + GAP), left, width }

  const close = () => useBrowserStore.getState().setPicked(sessionId, null)
  const save = () => {
    const comment = text.trim()
    if (!comment || saving) return
    if (pageNotesFull(sessionId)) {
      toast(t('pick.full'), undefined, { tone: 'warning' })
      return
    }
    setSaving(true)
    addPageNote(sessionId, pick, comment, hostId)
      .then(close, (error: unknown) =>
        toast(t('pick.failed', { error: errorMessage(error) }), undefined, { tone: 'warning' }),
      )
      .finally(() => setSaving(false))
  }
  const keys = isMac ? '⌘↩' : 'Ctrl+Enter'

  return (
    <div ref={root} className="kp-pick-layer">
      <div
        aria-hidden
        className="kp-pick-box"
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      />
      {area && (
        <div
          role="dialog"
          aria-label={t('pick.editorLabel', { element: pick.label })}
          className="kp-note-editor kp-pick-editor"
          data-placed=""
          style={place}
        >
          <div className="kp-note-editor__head">
            <PaneIcon icon={CursorAddSelection01Icon} size={14} />
            <span className="kp-pick-editor__label" title={pick.selector}>
              {pick.label}
            </span>
            {pick.text && <span className="kp-pick-editor__text">{pick.text}</span>}
          </div>
          {/* Huli: where the element's source is, as the page's dev build said. */}
          {pick.source && (
            <span className="kp-pick-editor__source" title={sourceText(pick.source)}>
              {sourceText(pick.source)}
            </span>
          )}
          <textarea
            ref={field}
            value={text}
            rows={3}
            maxLength={MAX_PAGE_NOTE_TEXT}
            placeholder={t('pick.placeholder')}
            aria-label={t('pick.editorLabel', { element: pick.label })}
            className="kp-note-editor__text"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close()
              }
              if (event.key === 'Enter' && isMod(event.nativeEvent)) {
                event.preventDefault()
                save()
              }
            }}
          />
          <div className="kp-note-editor__foot">
            <span className="kp-note-editor__keys">{t('pick.keys', { keys })}</span>
            <Button variant="ghost" size="xs" onClick={close}>
              {t('pick.cancel')}
            </Button>
            <Button size="xs" disabled={!text.trim() || saving} onClick={save}>
              {saving && <Spinner className="size-3" />}
              {t('pick.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
