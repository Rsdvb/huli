// Comments on a diff's lines, kept in a session's draft until they go to its agent together as one
// message. The desktop and the phone both make and send them, so both write the same message.

/** Which file's numbers a note's lines carry: the new file's, or the old file's. */
export type DiffNoteSide = 'additions' | 'deletions'

/** A line of a diff as a note quotes it: added (+), removed (-) or unchanged (space). */
export interface DiffNoteRow {
  mark: ' ' | '+' | '-'
  /** Its number in the old file, null for an added line. */
  old: number | null
  /** Its number in the new file, null for a removed line. */
  new: number | null
  text: string
}

export interface DiffNote {
  id: string
  /** The file, relative to the session's folder where it lies inside it. */
  path: string
  /** The commit the diff showed, or null for the working tree. */
  ref: string | null
  /**
   * The lines' numbers: the new file's, or the old file's for removed lines alone. Null when the
   * diff showed only part of the file, such as a single edit, whose numbers are not the file's.
   */
  range: { side: DiffNoteSide; start: number; end: number } | null
  /** The commented lines, each after its mark, at most MAX_QUOTED_LINES of them. */
  quote: string[]
  /** How many lines the comment covers, quoted or not. */
  lines: number
  text: string
  /** When it was written, in ms. */
  at: number
}

export const MAX_DIFF_NOTES = 50
export const MAX_NOTE_TEXT = 4000
export const MAX_QUOTED_LINES = 40
export const MAX_QUOTED_CHARS = 400
const MAX_PATH = 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isLine = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

function isRange(value: unknown): value is DiffNote['range'] {
  if (value === null) return true
  return (
    isRecord(value) &&
    (value.side === 'additions' || value.side === 'deletions') &&
    isLine(value.start) &&
    isLine(value.end) &&
    value.start <= value.end
  )
}

/** A note as stored in a draft, which another version of the app may have written. */
export function isDiffNote(value: unknown): value is DiffNote {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 64 &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    value.path.length <= MAX_PATH &&
    (value.ref === null || typeof value.ref === 'string') &&
    isRange(value.range) &&
    Array.isArray(value.quote) &&
    value.quote.length <= MAX_QUOTED_LINES &&
    value.quote.every((line) => typeof line === 'string' && line.length <= MAX_QUOTED_CHARS + 1) &&
    isLine(value.lines) &&
    typeof value.text === 'string' &&
    value.text.length <= MAX_NOTE_TEXT &&
    typeof value.at === 'number'
  )
}

/** The stored notes that still read as notes, as many as a draft keeps. */
export function parseDiffNotes(value: unknown): DiffNote[] {
  return Array.isArray(value) ? value.filter(isDiffNote).slice(0, MAX_DIFF_NOTES) : []
}

/**
 * A note on `rows`, the lines in the order the diff shows them. `numbered` says whether their
 * numbers are the file's; a removed line among others takes the new file's numbers around it.
 */
export function newDiffNote(
  input: { id: string; path: string; ref: string | null; text: string; at: number },
  rows: readonly DiffNoteRow[],
  numbered: boolean,
): DiffNote {
  let range: DiffNote['range'] = null
  if (numbered) {
    const added = rows.flatMap((row) => (row.new === null ? [] : [row.new]))
    const removed = rows.flatMap((row) => (row.old === null ? [] : [row.old]))
    const side = added.length > 0 ? 'additions' : 'deletions'
    const numbers = added.length > 0 ? added : removed
    if (numbers.length > 0) {
      range = { side, start: Math.min(...numbers), end: Math.max(...numbers) }
    }
  }
  return {
    id: input.id,
    path: input.path.slice(0, MAX_PATH),
    ref: input.ref,
    range,
    quote: rows
      .slice(0, MAX_QUOTED_LINES)
      .map((row) => row.mark + row.text.replace(/\r$/, '').slice(0, MAX_QUOTED_CHARS)),
    lines: Math.max(1, rows.length),
    text: input.text.slice(0, MAX_NOTE_TEXT),
    at: input.at,
  }
}

/** `src/a.ts:4-6`, `src/a.ts:4`, or the path alone for lines without the file's numbers. */
export function diffNotePlace(note: Pick<DiffNote, 'path' | 'range'>): string {
  const { range } = note
  if (!range) return note.path
  return `${note.path}:${range.start}${range.end > range.start ? `-${range.end}` : ''}`
}

/** The words the message puts around the notes, in the user's language. */
export interface DiffNoteLabels {
  /** The line above the notes, for `count` of them. */
  intro: (count: number) => string
  /** After the place of removed lines, whose numbers are the old file's. */
  removed: string
  /** After the place of lines of a commit. */
  commit: (ref: string) => string
  /** Below a quote that left lines out. */
  more: (count: number) => string
}

/** A fence longer than any run of backticks in the quoted lines. */
function fenceFor(lines: readonly string[]): string {
  let longest = 0
  for (const line of lines) {
    for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * The message the notes go to the agent as, in Markdown any agent reads: for each, where its
 * lines are, the lines as the diff showed them, then the comment.
 */
export function diffNotesMessage(notes: readonly DiffNote[], labels: DiffNoteLabels): string {
  const parts = [labels.intro(notes.length)]
  notes.forEach((note, index) => {
    const after = [
      note.range?.side === 'deletions' ? labels.removed : null,
      note.ref ? labels.commit(note.ref.slice(0, 7)) : null,
    ].filter((part) => part !== null)
    const heading = `### ${index + 1}. \`${diffNotePlace(note)}\`${after.length > 0 ? ` (${after.join(', ')})` : ''}`
    const fence = fenceFor(note.quote)
    const quote = `${fence}diff\n${note.quote.join('\n')}\n${fence}`
    const left = note.lines - note.quote.length
    parts.push(
      [heading, quote, ...(left > 0 ? [labels.more(left)] : []), note.text.trim()].join('\n\n'),
    )
  })
  return parts.join('\n\n')
}
