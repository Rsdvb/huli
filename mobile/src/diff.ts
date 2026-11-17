// Line diffs for the phone: the two sides of a change, as a file's diff or a tool's edit carries
// them, turned into unified hunks with line numbers.

export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'same' | 'add' | 'del'; old: number | null; new: number | null; text: string }

export interface Diff {
  rows: DiffRow[]
  insertions: number
  deletions: number
  /** The widest row, in monospace columns, counting a wide character as two. */
  columns: number
  /** The highest line number shown. */
  lastLine: number
  /** Some stretch was too far apart to align line by line, and is shown as removed, then added. */
  rough: boolean
}

const CONTEXT = 3
const MAX_ROW_CHARS = 2000
// Myers keeps one row of its trace per edit, (edits + 1)^2 numbers in all.
const MAX_EDITS = 1000
const MAX_WORK = 30_000_000

const SAME = 0
const DEL = 1
const ADD = 2

export function splitLines(text: string | null): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

function myers(a: Int32Array, b: Int32Array): number[] | null {
  const n = a.length
  const m = b.length
  const limit = Math.min(MAX_EDITS, n + m, Math.max(50, Math.floor(MAX_WORK / (n + m + 1))))
  const off = limit + 1
  const v = new Int32Array(2 * limit + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
          ? v[off + k + 1]!
          : v[off + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1))
        return backtrack(trace, n, m)
      }
    }
    trace.push(v.slice(off - d, off + d + 1))
  }
  return null
}

function backtrack(trace: Int32Array[], n: number, m: number): number[] {
  const ops: number[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]!
    const at = (k: number) => prev[k + d - 1]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const pk = down ? k + 1 : k - 1
    const px = at(pk)
    const midX = down ? px : px + 1
    while (x > midX) {
      ops.push(SAME)
      x--
      y--
    }
    ops.push(down ? ADD : DEL)
    x = px
    y = px - pk
  }
  while (x > 0 && y > 0) {
    ops.push(SAME)
    x--
    y--
  }
  return ops.reverse()
}

/**
 * Pairs the lines that occur once on each side, in an order both sides agree on: the longest
 * increasing run of their new positions, as patience diff anchors on.
 */
function anchors(a: Int32Array, b: Int32Array): [number, number][] {
  const seen = new Map<number, { a: number; b: number; at: number }>()
  for (let i = 0; i < a.length; i++) {
    const id = a[i]!
    const count = seen.get(id)
    if (count) count.a++
    else seen.set(id, { a: 1, b: 0, at: i })
  }
  const pairs: [number, number][] = []
  const inB = new Map<number, number>()
  for (let j = 0; j < b.length; j++) {
    const count = seen.get(b[j]!)
    if (!count) continue
    count.b++
    inB.set(b[j]!, j)
  }
  for (const [id, count] of seen) {
    if (count.a === 1 && count.b === 1) pairs.push([count.at, inB.get(id)!])
  }
  pairs.sort((p, q) => p[0] - q[0])
  // Patience sorting: tails[k] is the pair ending the best run of length k + 1 found so far.
  const tails: number[] = []
  const back = new Int32Array(pairs.length).fill(-1)
  for (let i = 0; i < pairs.length; i++) {
    const j = pairs[i]![1]
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pairs[tails[mid]!]![1] < j) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) back[i] = tails[lo - 1]!
    tails[lo] = i
  }
  const run: [number, number][] = []
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = back[i]!)
    run.push(pairs[i]!)
  return run.reverse()
}

function push(out: number[], op: number, count: number) {
  for (let i = 0; i < count; i++) out.push(op)
}

/** Appends the ops that turn `a` into `b`; true when some part could not be aligned. */
function align(a: Int32Array, b: Int32Array, out: number[]): boolean {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }
  push(out, SAME, prefix)
  const ma = a.subarray(prefix, a.length - suffix)
  const mb = b.subarray(prefix, b.length - suffix)
  let rough = false
  const ops = ma.length && mb.length ? myers(ma, mb) : null
  if (ops) {
    for (const op of ops) out.push(op)
  } else {
    const pinned = ma.length && mb.length ? anchors(ma, mb) : []
    if (pinned.length === 0) {
      rough = ma.length > 0 && mb.length > 0
      push(out, DEL, ma.length)
      push(out, ADD, mb.length)
    } else {
      let x = 0
      let y = 0
      for (const [i, j] of pinned) {
        if (align(ma.subarray(x, i), mb.subarray(y, j), out)) rough = true
        out.push(SAME)
        x = i + 1
        y = j + 1
      }
      if (align(ma.subarray(x), mb.subarray(y), out)) rough = true
    }
  }
  push(out, SAME, suffix)
  return rough
}

const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\uD800-\uDBFF][\uDC00-\uDFFF]/g

function columns(text: string): number {
  const wide = text.match(WIDE)
  return text.length + (wide ? wide.reduce((sum, ch) => sum + (ch.length === 2 ? 0 : 1), 0) : 0)
}

function shown(line: string): string {
  const text = line.includes('\t') ? line.replace(/\t/g, '    ') : line
  return text.length > MAX_ROW_CHARS ? `${text.slice(0, MAX_ROW_CHARS)}…` : text
}

export function diffTexts(oldText: string | null, newText: string | null): Diff {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }

  const ids = new Map<string, number>()
  const intern = (lines: string[]) => {
    const out = new Int32Array(lines.length - prefix - suffix)
    for (let i = 0; i < out.length; i++) {
      const line = lines[prefix + i]!
      let id = ids.get(line)
      if (id === undefined) {
        id = ids.size
        ids.set(line, id)
      }
      out[i] = id
    }
    return out
  }
  const ia = intern(a)
  const ib = intern(b)
  const middle: number[] = []
  const rough = align(ia, ib, middle)

  const ops = new Uint8Array(prefix + middle.length + suffix)
  ops.set(middle, prefix)

  // Which ops to show: every change, and up to CONTEXT unchanged lines around each.
  const keep = new Uint8Array(ops.length)
  let i = 0
  while (i < ops.length) {
    if (ops[i] !== SAME) {
      keep[i] = 1
      i++
      continue
    }
    let end = i
    while (end < ops.length && ops[end] === SAME) end++
    const first = i === 0
    const last = end === ops.length
    if (!first) for (let j = i; j < Math.min(end, i + CONTEXT); j++) keep[j] = 1
    if (!last) for (let j = Math.max(i, end - CONTEXT); j < end; j++) keep[j] = 1
    i = end
  }

  const rows: DiffRow[] = []
  let insertions = 0
  let deletions = 0
  let widest = 0
  let lastLine = 0
  let oldNo = 1
  let newNo = 1
  i = 0
  while (i < ops.length) {
    if (!keep[i]) {
      if (ops[i] !== ADD) oldNo++
      if (ops[i] !== DEL) newNo++
      i++
      continue
    }
    let end = i
    let oldCount = 0
    let newCount = 0
    while (end < ops.length && keep[end]) {
      if (ops[end] !== ADD) oldCount++
      if (ops[end] !== DEL) newCount++
      end++
    }
    rows.push({
      kind: 'hunk',
      text: `@@ -${oldCount ? oldNo : oldNo - 1},${oldCount} +${newCount ? newNo : newNo - 1},${newCount} @@`,
    })
    for (let j = i; j < end; j++) {
      const op = ops[j]
      let row: DiffRow
      if (op === SAME) {
        row = { kind: 'same', old: oldNo, new: newNo, text: shown(b[newNo - 1]!) }
        oldNo++
        newNo++
      } else if (op === DEL) {
        row = { kind: 'del', old: oldNo, new: null, text: shown(a[oldNo - 1]!) }
        oldNo++
        deletions++
      } else {
        row = { kind: 'add', old: null, new: newNo, text: shown(b[newNo - 1]!) }
        newNo++
        insertions++
      }
      widest = Math.max(widest, columns(row.text))
      rows.push(row)
    }
    lastLine = Math.max(lastLine, oldNo - 1, newNo - 1)
    i = end
  }
  return { rows, insertions, deletions, columns: widest, lastLine, rough }
}

/** A tool's edit, handed from the conversation to the diff screen, which reads it once. */
export interface ToolDiff {
  path: string
  oldText: string | null
  newText: string
  /** Already worked out, as the conversation's line showed its counts. */
  diff?: Diff
}

const handed = new Map<string, ToolDiff>()
let handedCount = 0

export function handDiff(diff: ToolDiff): string {
  const key = String(++handedCount)
  handed.set(key, diff)
  // Kept for going back and forth between screens, but never without bound.
  if (handed.size > 20) handed.delete(handed.keys().next().value!)
  return key
}

export function handedDiff(key: string): ToolDiff | null {
  return handed.get(key) ?? null
}
