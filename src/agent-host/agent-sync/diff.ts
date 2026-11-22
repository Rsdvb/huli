// Huli: the lines a write changes, as the preview shows them. The edits are splices, so the files
// share a long head and tail; only what lies between is compared line by line.

import type { SyncDiffHunk, SyncDiffLine } from '@shared/agent-sync'

const CONTEXT = 3
/** Past this many line pairs the middle shows as all taken out and all put in. */
const MAX_CELLS = 4_000_000

function lines(text: string): string[] {
  if (text === '') return []
  const out = text.split('\n').map((line) => line.replace(/\r$/, ''))
  if (text.endsWith('\n')) out.pop()
  return out
}

/** The middle's lines as kept, taken out and put in, by their longest common run. */
function middle(a: readonly string[], b: readonly string[]): SyncDiffLine[] {
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text): SyncDiffLine => ({ kind: 'del', text })),
      ...b.map((text): SyncDiffLine => ({ kind: 'add', text })),
    ]
  }
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const out: SyncDiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      out.push({ kind: 'del', text: a[i++]! })
    } else {
      out.push({ kind: 'add', text: b[j++]! })
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! })
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! })
  return out
}

/** The changed lines of `before` to `after` in hunks with a few lines around each. */
export function diffHunks(before: string, after: string): SyncDiffHunk[] {
  const a = lines(before)
  const b = lines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }
  const all: SyncDiffLine[] = [
    ...a.slice(0, head).map((text): SyncDiffLine => ({ kind: 'same', text })),
    ...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((text): SyncDiffLine => ({ kind: 'same', text })),
  ]
  // Changes closer than twice the context share a hunk.
  const hunks: SyncDiffHunk[] = []
  const oldAt: number[] = []
  const newAt: number[] = []
  let oldLine = 1
  let newLine = 1
  for (const line of all) {
    oldAt.push(oldLine)
    newAt.push(newLine)
    if (line.kind !== 'add') oldLine++
    if (line.kind !== 'del') newLine++
  }
  let first = -1
  let last = -1
  const close = (): void => {
    const from = Math.max(0, first - CONTEXT)
    const to = Math.min(all.length, last + CONTEXT + 1)
    hunks.push({ oldStart: oldAt[from]!, newStart: newAt[from]!, lines: all.slice(from, to) })
  }
  all.forEach((line, index) => {
    if (line.kind === 'same') return
    if (first >= 0 && index - last > CONTEXT * 2) close()
    if (first < 0 || index - last > CONTEXT * 2) first = index
    last = index
  })
  if (first >= 0) close()
  return hunks
}
