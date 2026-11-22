// Comments on a diff's lines for the session's agent, as the desktop's Files pane takes them
// (src/renderer/src/features/diff-notes): picked by tapping lines, written in a sheet, kept in the
// session's draft (drafts.ts) and sent together as one message through the session's queue, which
// sends at once when the session is free.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  MAX_DIFF_NOTES,
  MAX_NOTE_TEXT,
  diffNotePlace,
  diffNotesMessage,
  newDiffNote,
  type DiffNote,
  type DiffNoteLabels,
  type DiffNoteRow,
} from '@shared/diff-notes'
import type { Diff, DiffRow } from '../diff'
import { readDraftNotes, subscribeDrafts, useDraftNotes, writeDraftNotes } from '../drafts'
import { useSession } from '../host'
import { Button, Field, FormSheet } from '../manage/kit'
import { queueMessage } from '../outbox'
import { BottomSheet } from '../ui/BottomSheet'
import { haptic } from '../ui/haptics'
import { Press } from '../ui/Press'
import { G, Icon } from '../ui/session/icons'
import { MONO, useSessionTokens } from '../ui/session/palette'
import { radius, space, type as typeScale } from '../ui/tokens'

/** The words around the notes in the message, as the desktop's Chinese catalog has them. */
const LABELS: DiffNoteLabels = {
  intro: (count) =>
    count === 1 ? '请处理我对改动的这条意见：' : `请处理我对改动的 ${count} 条意见：`,
  removed: '已删除的行，按旧文件的行号',
  commit: (ref) => `提交 ${ref} 中`,
  more: (count) => `（还有 ${count} 行没有引用）`,
}

/** Where the diff's lines are: the file as the agent finds it, and the commit, if any. */
export interface NotePlace {
  path: string
  ref: string | null
  /** Whether the rows carry the file's own numbers, not those of one edit. */
  numbered: boolean
}

function noteRows(
  rows: readonly DiffRow[],
  [first, last]: readonly [number, number],
): DiffNoteRow[] {
  const out: DiffNoteRow[] = []
  for (let i = first; i <= last; i++) {
    const row = rows[i]
    if (!row || row.kind === 'hunk') continue
    out.push({
      mark: row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ',
      old: row.old,
      new: row.new,
      text: row.text,
    })
  }
  return out
}

let made = 0

/**
 * The rows the notes on this file cover, by index into the diff's rows: by their numbers, or for
 * an edit's comments, which have none, by the lines they quote.
 */
export function notedRows(diff: Diff, notes: readonly DiffNote[], place: NotePlace): Set<number> {
  const mine = notes.filter((note) => note.path === place.path && note.ref === place.ref)
  const rows = new Set<number>()
  if (mine.length === 0) return rows
  const ranges = place.numbered ? mine.flatMap((note) => (note.range ? [note.range] : [])) : []
  const quoted = new Set(mine.flatMap((note) => (note.range ? [] : note.quote)))
  diff.rows.forEach((row, index) => {
    if (row.kind === 'hunk') return
    const mark = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
    const covered =
      quoted.has(mark + row.text) ||
      ranges.some((range) => {
        const line = range.side === 'deletions' ? row.old : row.new
        return line !== null && line >= range.start && line <= range.end
      })
    if (covered) rows.add(index)
  })
  return rows
}

/** Whether the session has notes waiting, rendering again only when that flips. */
export function useHasDraftNotes(computer: string | null, sessionId: string | null): boolean {
  return useSyncExternalStore(
    subscribeDrafts,
    () => !!computer && !!sessionId && readDraftNotes(computer, sessionId).length > 0,
  )
}

/** How the screen picks lines: a tap picks one, another stretches the pick to it. */
export function useLinePick(diff: Diff | null) {
  const [picked, setPicked] = useState<readonly [number, number] | null>(null)
  const anchor = useRef<number | null>(null)
  const [editing, setEditing] = useState(false)
  // A new diff's rows are other rows.
  const [pickedOf, setPickedOf] = useState(diff)
  if (diff !== pickedOf) {
    setPickedOf(diff)
    setPicked(null)
    setEditing(false)
  }
  const press = useCallback((index: number) => {
    haptic.select()
    setPicked((current) => {
      if (current && current[0] === index && current[1] === index) {
        anchor.current = null
        return null
      }
      if (!current || anchor.current === null) {
        anchor.current = index
        return [index, index]
      }
      const from = anchor.current
      return from <= index ? [from, index] : [index, from]
    })
  }, [])
  const longPress = useCallback((index: number) => {
    haptic.tap()
    setPicked((current) => {
      if (current && index >= current[0] && index <= current[1]) return current
      anchor.current = index
      return [index, index]
    })
    setEditing(true)
  }, [])
  const clear = useCallback(() => {
    anchor.current = null
    setPicked(null)
  }, [])
  return { picked, press, longPress, clear, editing, setEditing }
}

/** The lines a pick covers as the diff numbers them: 第 5 行, 第 5–7 行. */
function pickLabel(rows: readonly DiffRow[], picked: readonly [number, number]): string {
  const numbers = noteRows(rows, picked).flatMap((row) => {
    const n = row.new ?? row.old
    return n === null ? [] : [n]
  })
  if (numbers.length === 0) return '已选中'
  const a = Math.min(...numbers)
  const b = Math.max(...numbers)
  return a === b ? `第 ${a} 行` : `第 ${a}–${b} 行`
}

/**
 * The bar under the diff: the lines picked and Comment, the session's comments waiting to go, or
 * how to pick lines; and the sheet a comment is written in.
 */
export function DiffNotesBar(props: {
  computer: string
  sessionId: string
  place: NotePlace
  diff: Diff
  pick: ReturnType<typeof useLinePick>
  onHeight: (height: number) => void
}) {
  const { computer, sessionId, place, diff, pick, onHeight } = props
  const { c } = useSessionTokens()
  const insets = useSafeAreaInsets()
  const notes = useDraftNotes(computer, sessionId)
  const [text, setText] = useState('')
  const barShown = pick.picked !== null || notes.length > 0
  useEffect(() => {
    if (!barShown) onHeight(0)
  }, [barShown, onHeight])

  const add = async () => {
    if (!pick.picked) return
    if (notes.length >= MAX_DIFF_NOTES) throw new Error(`一次最多 ${MAX_DIFF_NOTES} 条意见`)
    const at = Date.now()
    const note = newDiffNote(
      {
        id: `${at.toString(36)}-p${(++made).toString(36)}`,
        path: place.path,
        ref: place.ref,
        text: text.trim(),
        at,
      },
      noteRows(diff.rows, pick.picked),
      place.numbered,
    )
    writeDraftNotes(computer, sessionId, [...notes, note])
    setText('')
    pick.clear()
  }
  const picked = pick.picked
  const pickedRows = useMemo(() => (picked ? noteRows(diff.rows, picked) : []), [diff, picked])
  const bottom = space.md + insets.bottom

  return (
    <>
      {picked ? (
        <View
          style={[styles.bar, { backgroundColor: c.surface, borderColor: c.border, bottom }]}
          onLayout={(event) => onHeight(event.nativeEvent.layout.height + space.md)}
        >
          <Text style={[typeScale.subhead, styles.grow, { color: c.text }]} numberOfLines={1}>
            {pickLabel(diff.rows, picked)}
          </Text>
          <Button label="取消" tone="plain" onPress={pick.clear} />
          <Button
            label="写意见"
            tone="primary"
            icon="message"
            onPress={() => pick.setEditing(true)}
          />
        </View>
      ) : notes.length > 0 ? (
        <NotesTray
          computer={computer}
          sessionId={sessionId}
          style={[styles.bar, { backgroundColor: c.surface, borderColor: c.border, bottom }]}
          onHeight={(height) => onHeight(height + space.md)}
        />
      ) : (
        <View
          pointerEvents="none"
          style={[styles.hint, { backgroundColor: c.surface, borderColor: c.border, bottom }]}
        >
          <Text style={[typeScale.caption, { color: c.textSecondary }]}>
            轻点一行选中，再点一行选一段，长按写意见
          </Text>
        </View>
      )}
      <FormSheet
        visible={pick.editing && picked !== null}
        title="写意见"
        message={
          picked
            ? diffNotePlace(
                newDiffNote(
                  { id: 'shown', path: place.path, ref: place.ref, text: '', at: 0 },
                  pickedRows,
                  place.numbered,
                ),
              )
            : undefined
        }
        onClose={() => pick.setEditing(false)}
        submitLabel="添加意见"
        canSubmit={text.trim().length > 0}
        onSubmit={add}
      >
        {picked ? <Quote rows={pickedRows} /> : null}
        <Field
          value={text}
          onChangeText={setText}
          placeholder="想让 Agent 怎么改这里？"
          multiline
          autoFocus
          maxLength={MAX_NOTE_TEXT}
          autoCapitalize="sentences"
          autoCorrect
        />
      </FormSheet>
    </>
  )
}

/**
 * The session's comments waiting to go: how many, which opens them to edit or delete, Send to
 * agent and Clear. Under the diff, and over the session's composer.
 */
export function NotesTray(props: {
  computer: string
  sessionId: string
  style?: StyleProp<ViewStyle>
  onHeight?: (height: number) => void
}) {
  const { computer, sessionId } = props
  const { c, s } = useSessionTokens()
  const status = useSession(sessionId)?.status
  const notes = useDraftNotes(computer, sessionId)
  const [listOpen, setListOpen] = useState(false)
  const [edited, setEdited] = useState<DiffNote | null>(null)
  if (notes.length === 0) return null

  const save = (next: DiffNote[]) => writeDraftNotes(computer, sessionId, next)
  // Through the outbox, as the composer's messages go when the link is down: the message is kept on
  // the phone and shown as the newest until the computer takes it, so a link that drops as Send is
  // tapped loses nothing. Sending straight and clearing first lost the comments in that moment.
  const send = () => {
    queueMessage(
      computer,
      { sessionId },
      { text: diffNotesMessage([...notes], LABELS), attachments: [] },
    )
    save([])
    haptic.success()
    if (status === 'running' || status === 'awaiting_permission') {
      Alert.alert('已排队', 'Agent 这一轮做完就会收到这些意见。')
    }
  }
  const clearAll = () =>
    Alert.alert('清空这些意见？', `${notes.length} 条意见会被删掉。`, [
      { text: '取消', style: 'cancel' },
      { text: '清空', style: 'destructive', onPress: () => save([]) },
    ])

  return (
    <View
      style={[styles.tray, props.style]}
      {...(props.onHeight
        ? { onLayout: (event) => props.onHeight!(event.nativeEvent.layout.height) }
        : {})}
    >
      <Press
        onPress={() => setListOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${notes.length} 条意见，点开查看`}
        containerStyle={styles.grow}
        style={styles.count}
      >
        <Icon icon={G.comment} size={15} color={c.accent} />
        <Text style={[typeScale.subhead, { color: c.text }]}>{notes.length} 条意见</Text>
      </Press>
      <Button label="清空" tone="plain" onPress={clearAll} />
      <Button
        label="发送给 Agent"
        tone="primary"
        disabled={status === 'starting' || status === undefined}
        onPress={send}
      />
      <BottomSheet
        visible={listOpen}
        onClose={() => setListOpen(false)}
        title={`${notes.length} 条意见`}
        message="发送前可以修改或删除"
      >
        {notes.map((note) => (
          <View key={note.id} style={[styles.note, { backgroundColor: s.code }]}>
            <View style={styles.noteHead}>
              <Text
                style={[styles.place, styles.grow, { color: c.textSecondary }]}
                numberOfLines={1}
              >
                {diffNotePlace(note)}
              </Text>
              <Press
                onPress={() => {
                  setListOpen(false)
                  setEdited(note)
                }}
                accessibilityRole="button"
                accessibilityLabel="编辑意见"
                style={styles.iconButton}
              >
                <Icon icon={G.pencil} size={15} color={c.textSecondary} />
              </Press>
              <Press
                onPress={() => save(notes.filter((other) => other.id !== note.id))}
                accessibilityRole="button"
                accessibilityLabel="删除意见"
                style={styles.iconButton}
              >
                <Icon icon={G.trash} size={15} color={c.danger} />
              </Press>
            </View>
            <Text style={[typeScale.callout, { color: c.text }]}>{note.text}</Text>
          </View>
        ))}
      </BottomSheet>
      <EditSheet
        note={edited}
        onClose={() => setEdited(null)}
        onSave={(next) =>
          save(
            readDraftNotes(computer, sessionId).map((note) =>
              note.id === edited?.id ? { ...note, text: next } : note,
            ),
          )
        }
      />
    </View>
  )
}

/** The session's comments waiting to go, as a strip over its composer like the dock's others. */
export function NotesStrip(props: { computer: string; sessionId: string }) {
  const { c, s } = useSessionTokens()
  return (
    <NotesTray
      computer={props.computer}
      sessionId={props.sessionId}
      style={[styles.strip, { backgroundColor: s.dockCard, borderColor: c.border }]}
    />
  )
}

/** The lines a comment is on, as the message quotes them. */
function Quote(props: { rows: DiffNoteRow[] }) {
  const { c, s } = useSessionTokens()
  const shown = props.rows.slice(0, 6)
  const left = props.rows.length - shown.length
  return (
    <View style={[styles.quote, { backgroundColor: s.code }]}>
      {shown.map((row, i) => (
        <Text
          key={i}
          numberOfLines={1}
          style={[
            styles.quoteLine,
            { color: row.mark === '+' ? c.added : row.mark === '-' ? c.removed : c.textSecondary },
          ]}
        >
          {row.mark}
          {row.text}
        </Text>
      ))}
      {left > 0 ? (
        <Text style={[styles.quoteLine, { color: c.textTertiary }]}>还有 {left} 行</Text>
      ) : null}
    </View>
  )
}

function EditSheet(props: {
  note: DiffNote | null
  onClose: () => void
  onSave: (text: string) => void
}) {
  const [text, setText] = useState('')
  const [of, setOf] = useState<DiffNote | null>(null)
  if (props.note !== of) {
    setOf(props.note)
    if (props.note) setText(props.note.text)
  }
  return (
    <FormSheet
      visible={props.note !== null}
      title="编辑意见"
      message={props.note ? diffNotePlace(props.note) : undefined}
      onClose={props.onClose}
      submitLabel="保存"
      canSubmit={text.trim().length > 0}
      onSubmit={async () => props.onSave(text.trim())}
    >
      <Field
        value={text}
        onChangeText={setText}
        multiline
        autoFocus
        maxLength={MAX_NOTE_TEXT}
        autoCapitalize="sentences"
        autoCorrect
      />
    </FormSheet>
  )
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.md,
    paddingRight: space.xs,
    paddingVertical: space.xs,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tray: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  strip: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 14,
    paddingRight: space.xs,
    paddingVertical: space.xxs,
  },
  hint: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  grow: { flex: 1, minWidth: 0 },
  count: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  note: { borderRadius: radius.sm, padding: space.md, gap: space.xs },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  place: { fontFamily: MONO, fontSize: 12 },
  iconButton: { padding: space.xs },
  quote: { borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  quoteLine: { fontFamily: MONO, fontSize: 12, lineHeight: 18 },
})
