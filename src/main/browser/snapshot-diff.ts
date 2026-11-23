// What changed between two outlines of a page: the lines added and removed, each under the lines
// of the elements that hold it, so an agent that read the first outline reads the second from far
// fewer lines. Refs are the same element's in both, so an unchanged element's line is the same.

/** More changed lines than this, and the whole outline says it better. */
export const MAX_DIFF_EDITS = 400

const SAME = 0
const ADDED = 1
const REMOVED = 2

interface Edit {
  kind: typeof SAME | typeof ADDED | typeof REMOVED
  line: string
}

/**
 * The shortest edit script from `a` to `b` (Myers' O(ND) algorithm), or null when it takes more
 * than `max` edits.
 */
export function editScript(
  a: readonly string[],
  b: readonly string[],
  max = MAX_DIFF_EDITS,
): Edit[] | null {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const n = endA - start
  const m = endB - start
  const bound = Math.min(max, n + m)
  const at = (k: number): number => k + bound + 1
  const v = new Int32Array(2 * bound + 3)
  // After each round d, the furthest x on each diagonal k from -d to d.
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= bound && found < 0; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[at(k - 1)]! < v[at(k + 1)]!) ? v[at(k + 1)]! : v[at(k - 1)]! + 1
      let y = x - k
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x += 1
        y += 1
      }
      v[at(k)] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    trace.push(v.slice(at(-d), at(d) + 1))
  }
  if (found < 0) return null
  const middle: Edit[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d -= 1) {
    const before = trace[d - 1]!
    const read = (k: number): number => before[k + d - 1]!
    const k = x - y
    const down = k === -d || (k !== d && read(k - 1) < read(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = read(prevK)
    const prevY = prevX - prevK
    while (x > prevX + (down ? 0 : 1) && y > prevY + (down ? 1 : 0)) {
      middle.push({ kind: SAME, line: a[start + x - 1]! })
      x -= 1
      y -= 1
    }
    if (down) middle.push({ kind: ADDED, line: b[start + y - 1]! })
    else middle.push({ kind: REMOVED, line: a[start + x - 1]! })
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    middle.push({ kind: SAME, line: a[start + x - 1]! })
    x -= 1
    y -= 1
  }
  middle.reverse()
  return [
    ...a.slice(0, start).map((line) => ({ kind: SAME, line }) as Edit),
    ...middle,
    ...a.slice(endA).map((line) => ({ kind: SAME, line }) as Edit),
  ]
}

function levelOf(line: string): number {
  let spaces = 0
  while (line.charCodeAt(spaces) === 32) spaces += 1
  return spaces >> 1
}

interface Context {
  line: string
  printed: boolean
}

/**
 * The lines that changed from one outline to the next, marked `+ ` or `- `, each after the
 * unchanged lines of the elements that hold it, marked with two spaces. Empty when nothing
 * changed; null when so much did that the whole outline is shorter to read.
 */
export function diffOutline(
  before: readonly string[],
  after: readonly string[],
  max = MAX_DIFF_EDITS,
): string[] | null {
  const edits = editScript(before, after, max)
  if (edits === null) return null
  const lines: string[] = []
  // The elements that hold the current line, in the new outline and in the old one.
  const now: Context[] = []
  const then: Context[] = []
  for (const edit of edits) {
    const level = levelOf(edit.line)
    if (edit.kind === SAME) {
      const context = { line: edit.line, printed: false }
      now.length = Math.min(now.length, level)
      then.length = Math.min(then.length, level)
      now.push(context)
      then.push(context)
      continue
    }
    const path = edit.kind === ADDED ? now : then
    path.length = Math.min(path.length, level)
    for (const holder of path) {
      if (holder.printed) continue
      holder.printed = true
      lines.push(`  ${holder.line}`)
    }
    lines.push(`${edit.kind === ADDED ? '+' : '-'} ${edit.line}`)
    path.push({ line: edit.line, printed: true })
  }
  return lines
}
