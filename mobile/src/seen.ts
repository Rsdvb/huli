// Where this phone last saw each session, per computer, for the recap that greets the user when
// they come back to one (@shared/recap). Read once per computer, written when a session stops being
// looked at: its screen is left or covered, or the app leaves the front.
//
//   <documents>/huli/seen/<computer id>.json   { v: 1, marks: { <session id>: SeenMark } }

import { Directory, File, Paths } from 'expo-file-system'
import { parseSeenMarks, withSeen, type SeenMark } from '@shared/recap'

const VERSION = 1

const memory = new Map<string, Record<string, SeenMark>>()
const loading = new Map<string, Promise<Record<string, SeenMark>>>()

function fileOf(computer: string): File {
  return new File(
    new Directory(Paths.document, 'huli', 'seen'),
    `${computer.replace(/[^A-Za-z0-9_-]/g, '_')}.json`,
  )
}

/** The computer's marks, read once; later calls wait on the same read. */
export function loadSeen(computer: string): Promise<Record<string, SeenMark>> {
  const known = loading.get(computer)
  if (known) return known
  const read = (async () => {
    let marks: Record<string, SeenMark> = {}
    try {
      const file = fileOf(computer)
      if (file.exists) {
        const value = JSON.parse(await file.text()) as { v?: unknown; marks?: unknown }
        if (value.v === VERSION) marks = parseSeenMarks(value.marks)
      }
    } catch (error) {
      console.warn('Could not read where sessions were left', error)
    }
    // A mark made while the file was read is newer than the file's.
    const made = memory.get(computer)
    if (made) marks = { ...marks, ...made }
    memory.set(computer, marks)
    return marks
  })()
  loading.set(computer, read)
  return read
}

/** Marks the session seen now, at `entry`, the thread's last entry (null for an empty one). */
export function markSeen(computer: string, sessionId: string, entry: string | null): void {
  const marks = withSeen(memory.get(computer) ?? {}, sessionId, { at: Date.now(), entry })
  memory.set(computer, marks)
  void save(computer)
}

async function save(computer: string): Promise<void> {
  // Never over the file before it has been read, or the marks in it would be lost.
  await loadSeen(computer)
  const marks = memory.get(computer)
  if (!marks) return
  try {
    const file = fileOf(computer)
    const dir = file.parentDirectory
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
    if (!file.exists) file.create({ intermediates: true })
    await file.write(JSON.stringify({ v: VERSION, marks }))
  } catch (error) {
    console.warn('Could not save where sessions were left', error)
  }
}

/** Forgets a computer's marks, as when it is unpaired. */
export function dropSeen(computer: string): void {
  memory.delete(computer)
  loading.delete(computer)
  try {
    const file = fileOf(computer)
    if (file.exists) file.delete()
  } catch {
    // Nothing to delete.
  }
}
