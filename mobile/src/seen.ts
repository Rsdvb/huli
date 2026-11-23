// Where this phone last saw each session, per computer, for the recap that greets the user when
// they come back to one (@shared/recap). Read once per computer and kept current in memory;
// written when a session leaves view, comes back into it, or its recap is put away.
//
//   <documents>/huli/seen/<computer id>.json   { v: 1, marks: { <session id>: SeenMark } }

import { Directory, File, Paths } from 'expo-file-system'
import { seenBook, type SeenBook, type SeenMark } from '@shared/recap'

const VERSION = 1

const books = new Map<string, SeenBook>()

function fileOf(computer: string): File {
  return new File(
    new Directory(Paths.document, 'huli', 'seen'),
    `${computer.replace(/[^A-Za-z0-9_-]/g, '_')}.json`,
  )
}

function bookOf(computer: string): SeenBook {
  let book = books.get(computer)
  if (book) return book
  book = seenBook({
    async read() {
      try {
        const file = fileOf(computer)
        if (!file.exists) return {}
        const value = JSON.parse(await file.text()) as { v?: unknown; marks?: unknown }
        return value.v === VERSION ? value.marks : {}
      } catch (error) {
        console.warn('Could not read where sessions were left', error)
        return {}
      }
    },
    async write(marks) {
      try {
        const file = fileOf(computer)
        const dir = file.parentDirectory
        if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
        if (!file.exists) file.create({ intermediates: true })
        await file.write(JSON.stringify({ v: VERSION, marks }))
      } catch (error) {
        console.warn('Could not save where sessions were left', error)
      }
    },
  })
  books.set(computer, book)
  return book
}

/** Where this phone last saw the session, once the computer's marks are read. */
export function seenMark(computer: string, sessionId: string): Promise<SeenMark | null> {
  return bookOf(computer).get(sessionId)
}

export function markSeen(computer: string, sessionId: string, mark: SeenMark): void {
  void bookOf(computer).set(sessionId, mark)
}

/** Forgets a computer's marks, as when it is unpaired. */
export function dropSeen(computer: string): void {
  books.get(computer)?.close()
  books.delete(computer)
  try {
    const file = fileOf(computer)
    if (file.exists) file.delete()
  } catch {
    // Nothing to delete.
  }
}
