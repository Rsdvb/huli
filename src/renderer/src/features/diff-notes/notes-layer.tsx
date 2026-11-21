import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'
import { BubbleChatIcon, Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { MAX_DIFF_NOTES, MAX_NOTE_TEXT, diffNotePlace, type DiffNote } from '@shared/diff-notes'
import { Button } from '@renderer/components/ui/button'
import { useDraftNotes } from '@renderer/features/session/composer/drafts'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { formatShortcut, isMod } from '@renderer/lib/platform'
import {
  addNote,
  editNote,
  makeNote,
  noteSpan,
  notesFull,
  removeNote,
  rowSpan,
  type RenderCount,
} from './notes'

/** The comment being written: a new one on the lines picked, or one already in the draft. */
export type NoteEditing = { kind: 'new'; range: SelectedLineRange } | { kind: 'edit'; id: string }

/** The number cell under the pointer, from an event that came out of the diff's shadow root. */
function numberCellOf(event: Event): HTMLElement | null {
  for (const target of event.composedPath()) {
    if (!(target instanceof HTMLElement)) continue
    if (target.hasAttribute('data-column-number')) return target
    if (target.hasAttribute('data-gutter') || target.classList.contains('files-diff')) return null
  }
  return null
}

/** A row's place on its side of the diff, from its number cell: old numbers for removed rows. */
function cellLine(cell: HTMLElement): { line: number; side: SelectedLineRange['side'] } | null {
  const line = Number.parseInt(cell.getAttribute('data-column-number') ?? '', 10)
  if (!Number.isFinite(line)) return null
  const removed = cell.getAttribute('data-line-type') === 'change-deletion'
  return { line, side: removed ? 'deletions' : 'additions' }
}

/** Where a pin or the editor sits, from the top of the scrolled content. */
interface Spots {
  pins: { row: number; top: number; notes: DiffNote[] }[]
  /** The edited lines' last row, its top and bottom. */
  editor: { top: number; bottom: number } | null
}

const NONE: Spots = { pins: [], editor: null }
/** How long the pointer stays on a row's number before the + comes to it. */
const REST_MS = 120
const MARK = 'data-note'

/** The gutter's number cells, one per drawn row, in the diff's shadow root. */
function gutterOf(box: HTMLElement): Element | null {
  return box.querySelector('.files-diff')?.shadowRoot?.querySelector('[data-gutter]') ?? null
}

/**
 * Marks the numbers of the rows `notes` cover, taking the marks off rows they no longer cover, and
 * finds where each comment's pin and the editor go. One pass over the drawn rows, whose first index
 * is the row's place in the whole diff; rows of folded runs are not drawn and get neither.
 */
function placeNotes(
  box: HTMLElement,
  fileDiff: FileDiffMetadata,
  notes: readonly DiffNote[],
  editing: NoteEditing | null,
  marked: Set<Element>,
): { spots: Spots; marked: Set<Element> } {
  const gutter = gutterOf(box)
  if (!gutter) return { spots: NONE, marked }
  const spans = notes.flatMap((note) => {
    const span = noteSpan(fileDiff, note)
    return span ? [{ note, span }] : []
  })
  const edited =
    editing?.kind === 'new'
      ? rowSpan(fileDiff, editing.range)
      : editing
        ? (spans.find(({ note }) => note.id === editing.id)?.span ?? null)
        : null
  const ends = new Map<number, DiffNote[]>()
  for (const { note, span } of spans) ends.set(span[1], [...(ends.get(span[1]) ?? []), note])
  const next = new Set<Element>()
  const anchors = new Map<number, Element>()
  for (const cell of gutter.children) {
    const at = cell.getAttribute('data-line-index')
    if (at === null) continue
    const row = Number.parseInt(at, 10)
    if (spans.some(({ span }) => row >= span[0] && row <= span[1])) next.add(cell)
    if (ends.has(row) || row === edited?.[1]) anchors.set(row, cell)
  }
  for (const cell of marked) if (!next.has(cell)) cell.removeAttribute(MARK)
  for (const cell of next) if (!marked.has(cell)) cell.setAttribute(MARK, '')
  const origin = box.getBoundingClientRect().top - box.scrollTop
  const pins: Spots['pins'] = []
  for (const [row, rowNotes] of ends) {
    const cell = anchors.get(row)
    if (cell) pins.push({ row, top: cell.getBoundingClientRect().top - origin, notes: rowNotes })
  }
  pins.sort((a, b) => a.row - b.row)
  const anchor = edited ? anchors.get(edited[1])?.getBoundingClientRect() : undefined
  const editor = !editing
    ? null
    : anchor
      ? { top: anchor.top - origin, bottom: anchor.bottom - origin }
      : { top: box.scrollTop + 8, bottom: box.scrollTop + 8 }
  return { spots: { pins, editor }, marked: next }
}

function sameSpots(a: Spots, b: Spots): boolean {
  return (
    a.editor?.top === b.editor?.top &&
    a.editor?.bottom === b.editor?.bottom &&
    a.pins.length === b.pins.length &&
    a.pins.every(
      (pin, i) =>
        pin.row === b.pins[i]!.row &&
        pin.top === b.pins[i]!.top &&
        pin.notes.length === b.pins[i]!.notes.length &&
        pin.notes.every((note, j) => note === b.pins[i]!.notes[j]),
    )
  )
}

/**
 * The session's comments on the file the diff shows: the commented rows' numbers marked in the
 * diff, a pin at the end of each comment to open it, and the box a comment is written in. Nothing
 * in the diff renders again for them: the marks are attributes on a few of its cells.
 */
export function NotesLayer({
  scroller,
  fileDiff,
  sessionId,
  place,
  selected,
  editing,
  onEditing,
  renders,
  onComment,
}: {
  scroller: RefObject<HTMLDivElement | null>
  fileDiff: FileDiffMetadata
  sessionId: string
  place: { path: string; ref: string | null }
  /** The lines picked by their numbers, which a + inside them comments on. */
  selected: SelectedLineRange | null
  editing: NoteEditing | null
  onEditing: (editing: NoteEditing | null) => void
  renders: RenderCount
  /** Starts a comment on `range`, picking its lines. */
  onComment: (range: SelectedLineRange) => void
}) {
  const { t } = useTranslation('files')
  const all = useDraftNotes(sessionId)
  const notes = useMemo(
    () => all.filter((note) => note.path === place.path && note.ref === place.ref),
    [all, place.path, place.ref],
  )
  const rendered = useSyncExternalStore(renders.subscribe, () => renders.count)
  const marked = useRef(new Set<Element>())
  const [spots, setSpots] = useState<Spots>(NONE)

  // Placed after the diff is laid out, which is what the pins and the editor are placed on.
  useLayoutEffect(() => {
    const box = scroller.current
    if (!box) return
    const placed = placeNotes(box, fileDiff, notes, editing, marked.current)
    marked.current = placed.marked
    setSpots((current) => (sameSpots(current, placed.spots) ? current : placed.spots))
  }, [scroller, fileDiff, notes, editing, rendered])

  // A + by the number the pointer rests on. The library's own + is not used: it follows the
  // pointer over every row, code too, into the row's number cell, and each move lays out the diff's
  // whole grid again, over 100 ms on a diff of thousands of lines. This one moves only in the
  // gutter, on a layer of its own, and nothing renders for it.
  const plus = useRef<HTMLButtonElement>(null)
  const hovered = useRef<{ line: number; side: SelectedLineRange['side'] } | null>(null)
  useEffect(() => {
    const box = scroller.current
    const button = plus.current
    if (!box || !button) return
    // Where the pointer rests: the + moves there once it has stayed on a row a moment, since on a
    // diff of thousands of rows every move of it costs the compositor over 10 ms.
    let shownCell: HTMLElement | null = null
    let restingCell: HTMLElement | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const place = (): void => {
      timer = undefined
      const cell = restingCell
      const line = cell && cellLine(cell)
      if (!cell || !line) {
        shownCell = null
        if (button.dataset.shown !== 'false') button.dataset.shown = 'false'
        return
      }
      if (cell === shownCell) return
      shownCell = cell
      const at = cell.getBoundingClientRect()
      const origin = box.getBoundingClientRect()
      const x = Math.round(at.right - origin.left - 4)
      const y = Math.round(at.top - origin.top + box.scrollTop + (at.height - 18) / 2)
      button.style.transform = `translate(${x}px, ${y}px)`
      if (button.dataset.shown !== 'true') button.dataset.shown = 'true'
      hovered.current = line
    }
    const move = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse' || button.contains(event.target as Node)) return
      const cell = numberCellOf(event)
      if (cell === restingCell) return
      restingCell = cell
      clearTimeout(timer)
      timer = setTimeout(place, REST_MS)
    }
    const leave = (event: PointerEvent): void => {
      if (button.contains(event.relatedTarget as Node | null)) return
      clearTimeout(timer)
      restingCell = null
      place()
    }
    box.addEventListener('pointermove', move, { passive: true })
    box.addEventListener('pointerleave', leave, { passive: true })
    return () => {
      clearTimeout(timer)
      box.removeEventListener('pointermove', move)
      box.removeEventListener('pointerleave', leave)
    }
  }, [scroller])
  const commentHere = () => {
    const at = hovered.current
    if (!at) return
    const point = { start: at.line, end: at.line, side: at.side, endSide: at.side }
    const row = rowSpan(fileDiff, point)?.[0]
    const span = selected ? rowSpan(fileDiff, selected) : null
    const inside = span !== null && row !== undefined && row >= span[0] && row <= span[1]
    onComment(inside && selected ? selected : point)
  }

  // The marks leave with the layer, as when the pane shows another session.
  useEffect(() => {
    const cells = marked
    return () => {
      for (const cell of cells.current) cell.removeAttribute(MARK)
      cells.current = new Set()
    }
  }, [])

  const editedNote =
    editing?.kind === 'edit' ? (notes.find((note) => note.id === editing.id) ?? null) : null

  const save = (text: string): string | null => {
    if (editing?.kind === 'edit') {
      editNote(sessionId, editing.id, text)
    } else if (editing?.kind === 'new') {
      const span = rowSpan(fileDiff, editing.range)
      if (!span) return null
      if (notesFull(sessionId)) return 'full'
      addNote(sessionId, makeNote(fileDiff, span, place, text))
    }
    onEditing(null)
    return null
  }

  const label =
    editing?.kind === 'new'
      ? newPlace(fileDiff, editing.range, place.path)
      : editedNote
        ? diffNotePlace(editedNote)
        : null

  // One layer for the pins and the editor, always there and laid out on its own, so one coming or
  // going lays out nothing of the diff beside it.
  return (
    <div className="kp-notes-layer">
      <button
        ref={plus}
        type="button"
        data-shown="false"
        className="kp-note-plus focus-ring"
        aria-label={t('notes.commentTitle')}
        title={t('notes.commentTitle')}
        onClick={commentHere}
      >
        <PaneIcon icon={PlusSignIcon} size={12} />
      </button>
      {spots.pins.map((pin) => (
        <NotePin
          key={pin.row}
          top={pin.top}
          notes={pin.notes}
          onOpen={() => onEditing({ kind: 'edit', id: pin.notes[0]!.id })}
        />
      ))}
      {editing && spots.editor !== null && label !== null && (
        <NoteEditor
          key={editing.kind === 'edit' ? editing.id : `${editing.range.start}:${editing.range.end}`}
          anchor={spots.editor}
          scroller={scroller}
          place={label}
          initial={editedNote?.text ?? ''}
          existing={editedNote !== null}
          onSave={save}
          onCancel={() => onEditing(null)}
          {...(editedNote
            ? {
                onDelete: () => {
                  removeNote(sessionId, editedNote.id)
                  onEditing(null)
                },
              }
            : {})}
        />
      )}
    </div>
  )
}

/** The place a comment on `range` would name, as its heading in the message does. */
function newPlace(fileDiff: FileDiffMetadata, range: SelectedLineRange, path: string): string {
  const span = rowSpan(fileDiff, range)
  if (!span) return path
  return diffNotePlace(makeNote(fileDiff, span, { path, ref: null }, ''))
}

function NotePin({ top, notes, onOpen }: { top: number; notes: DiffNote[]; onOpen: () => void }) {
  const { t } = useTranslation('files')
  const text = notes.map((note) => note.text).join('\n\n')
  return (
    <button
      type="button"
      className="kp-note-pin focus-ring"
      style={{ top }}
      title={t('notes.pin', { text })}
      aria-label={t('notes.pin', { text })}
      onClick={onOpen}
    >
      <PaneIcon icon={BubbleChatIcon} size={12} />
      {notes.length > 1 && <span>{notes.length}</span>}
    </button>
  )
}

function NoteEditor({
  anchor,
  scroller,
  place,
  initial,
  existing,
  onSave,
  onCancel,
  onDelete,
}: {
  anchor: { top: number; bottom: number }
  scroller: RefObject<HTMLDivElement | null>
  place: string
  initial: string
  existing: boolean
  /** Saves the comment; returns why it could not, or null. */
  onSave: (text: string) => string | null
  onCancel: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation('files')
  const box = useRef<HTMLDivElement>(null)
  const [text, setText] = useState(initial)
  const [full, setFull] = useState(false)
  const [top, setTop] = useState<number | null>(null)

  // Under the lines, or above them where it would run past the end of the diff, whose layer
  // adds nothing to the scrolled height.
  useLayoutEffect(() => {
    const height = box.current?.offsetHeight ?? 0
    const end = scroller.current?.scrollHeight ?? Infinity
    setTop(anchor.bottom + height + 8 > end ? Math.max(0, anchor.top - height - 8) : anchor.bottom)
  }, [anchor.top, anchor.bottom, scroller])
  useLayoutEffect(() => {
    if (top !== null) box.current?.scrollIntoView({ block: 'nearest' })
  }, [top])

  const save = () => {
    if (!text.trim()) return
    setFull(onSave(text.trim()) === 'full')
  }

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={t('notes.editorLabel', { place })}
      data-note-editor=""
      data-placed={top === null ? undefined : ''}
      className="kp-note-editor"
      style={{ top: top ?? anchor.bottom }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        // Handled here, so the session does not also take Esc as a request to stop.
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
    >
      <div className="kp-note-editor__head">
        <PaneIcon icon={BubbleChatIcon} size={13} />
        <span className="kp-note-editor__place">{place}</span>
        {onDelete && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label={t('notes.delete')}
            title={t('notes.delete')}
            onClick={onDelete}
          >
            <PaneIcon icon={Delete02Icon} size={13} />
          </Button>
        )}
      </div>
      <textarea
        autoFocus
        value={text}
        rows={3}
        maxLength={MAX_NOTE_TEXT}
        placeholder={t('notes.placeholder')}
        aria-label={t('notes.editorLabel', { place })}
        className="kp-note-editor__text"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key !== 'Enter' ||
            !isMod(event.nativeEvent) ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return
          event.preventDefault()
          save()
        }}
      />
      {full && (
        <p role="alert" className="kp-note-editor__error">
          {t('notes.full', { count: MAX_DIFF_NOTES })}
        </p>
      )}
      <div className="kp-note-editor__foot">
        <span className="kp-note-editor__keys">
          {t('notes.keys', { keys: formatShortcut('Mod+Enter') })}
        </span>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          {t('notes.cancel')}
        </Button>
        <Button size="xs" data-note-save="" disabled={!text.trim()} onClick={save}>
          {existing ? t('notes.update') : t('notes.save')}
        </Button>
      </div>
    </div>
  )
}
