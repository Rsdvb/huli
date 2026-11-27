// A device that draws tool calls folded gets their long outputs and inputs as digests in the pages
// it reads, which are most of their bytes; `sessions.entry` reads an entry whole when it opens one.
// Huli: a lean page (`lean` in the read) goes further: its digests carry a short preview, a long
// title is cut and an input digested sooner, so a step costs about what its folded row shows.

import type {
  DigestedThreadEntry,
  DigestedToolEntry,
  ThreadEntry,
  ToolContent,
  ToolContentDigest,
  ToolInputDigest,
} from '@shared/thread'

/** An input this long or shorter, in UTF-8 bytes, stays whole: nearly every command. */
export const DIGEST_INPUT_BYTES = 2 * 1024
/** A text output this long or shorter stays whole. */
export const DIGEST_OUTPUT_BYTES = 1024
/** A diff whose old and new text are together this long or shorter stays whole: most edits. */
export const DIGEST_DIFF_BYTES = 8 * 1024
/** The steps comparing a diff's lines may take, a few milliseconds, before its counts are null. */
export const DIFF_WORK = 2_000_000

/** Huli: in a lean page, an input this long or shorter stays whole. */
export const LEAN_INPUT_BYTES = 1024
/** Huli: a lean page cuts a title longer than this many characters. */
export const LEAN_TITLE_CHARS = 240
/** Huli: a lean preview's head and tail each take at most this many lines and UTF-8 bytes. */
export const PREVIEW_LINES = 5
export const PREVIEW_BYTES = 384

/** The entries with each long tool output and input as a digest; the same entries otherwise. */
export function digestEntries<T extends { entries: ThreadEntry[] }>(
  page: T,
): Omit<T, 'entries'> & { entries: DigestedThreadEntry[] } {
  return { ...page, entries: page.entries.map(digestEntry) }
}

/** Huli: the entries of a lean page, each tool call as `leanEntry` makes it. */
export function leanEntries<T extends { entries: ThreadEntry[] }>(
  page: T,
): Omit<T, 'entries'> & { entries: DigestedThreadEntry[] } {
  return { ...page, entries: page.entries.map(leanEntry) }
}

/** A tool call that waits for an answer stays whole, since its card shows what it asks about. */
export function digestEntry(entry: ThreadEntry): DigestedThreadEntry {
  return digested(entry, false)
}

/**
 * Huli: `digestEntry` for a lean page: each digest of an output with its first and last lines, a
 * diff's saying whether it made the file, an input digested past `LEAN_INPUT_BYTES` and a title
 * cut at `LEAN_TITLE_CHARS`.
 */
export function leanEntry(entry: ThreadEntry): DigestedThreadEntry {
  return digested(entry, true)
}

function digested(entry: ThreadEntry, lean: boolean): DigestedThreadEntry {
  if (entry.kind !== 'tool' || entry.permission !== null) return entry
  let content: (ToolContent | ToolContentDigest)[] | null = null
  entry.content.forEach((item, index) => {
    const digest = digestContent(item, lean)
    if (digest) (content ??= [...entry.content])[index] = digest
  })
  const input = entry.rawInput === undefined ? null : digestInput(entry.rawInput, lean)
  const title = lean ? cutTitle(entry.title) : null
  if (!content && !input && title === null) return entry
  const out: DigestedToolEntry = { ...entry, content: content ?? entry.content }
  if (input) {
    delete out.rawInput
    out.rawInputDigest = input
  }
  if (title !== null) {
    out.title = title
    out.titleSize = Buffer.byteLength(entry.title)
  }
  return out
}

function digestContent(item: ToolContent, lean: boolean): ToolContentDigest | null {
  if (item.type === 'markdown') {
    const size = Buffer.byteLength(item.markdown)
    if (size <= DIGEST_OUTPUT_BYTES) return null
    const digest = {
      type: 'digest',
      of: 'markdown',
      size,
      lines: lineCount(item.markdown),
    } as const
    return lean ? { ...digest, ...preview(item.markdown) } : digest
  }
  if (item.type === 'diff') {
    const size = Buffer.byteLength(item.oldText ?? '') + Buffer.byteLength(item.newText)
    if (size <= DIGEST_DIFF_BYTES) return null
    const { added, removed } = diffCounts(item.oldText, item.newText)
    const digest = { type: 'digest', of: 'diff', path: item.path, size, added, removed } as const
    return lean && item.oldText === null ? { ...digest, created: true } : digest
  }
  return null
}

function digestInput(input: string, lean: boolean): ToolInputDigest | null {
  const size = Buffer.byteLength(input)
  return size > (lean ? LEAN_INPUT_BYTES : DIGEST_INPUT_BYTES)
    ? { size, lines: lineCount(input) }
    : null
}

/** A title past `LEAN_TITLE_CHARS`, cut there with an ellipsis; null for one that fits. */
function cutTitle(title: string): string | null {
  if (title.length <= LEAN_TITLE_CHARS) return null
  let end = LEAN_TITLE_CHARS
  // A cut between a surrogate pair's halves would leave a lone half.
  if (isHighSurrogate(title.charCodeAt(end - 1))) end--
  return `${title.slice(0, end)}\u2026`
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * A long text's first and last lines, each at most `PREVIEW_LINES` lines and `PREVIEW_BYTES`
 * UTF-8 bytes; a line longer than that is cut, from its end for the head and its start for the
 * tail, at a character.
 */
export function preview(text: string): { head: string; tail: string } {
  const all = lines(text)
  const head = fitStart(all.slice(0, PREVIEW_LINES).join('\n'), PREVIEW_BYTES)
  const tail = fitEnd(all.slice(-PREVIEW_LINES).join('\n'), PREVIEW_BYTES)
  return { head, tail }
}

function fitStart(text: string, bytes: number): string {
  let used = 0
  let end = 0
  for (const char of text) {
    used += Buffer.byteLength(char)
    if (used > bytes) break
    end += char.length
  }
  return text.slice(0, end)
}

function fitEnd(text: string, bytes: number): string {
  let used = 0
  let start = text.length
  while (start > 0) {
    const low = text.charCodeAt(start - 1)
    const pair =
      start > 1 && low >= 0xdc00 && low <= 0xdfff && isHighSurrogate(text.charCodeAt(start - 2))
    const size = pair ? 2 : 1
    used += Buffer.byteLength(text.slice(start - size, start))
    if (used > bytes) break
    start -= size
  }
  return text.slice(start)
}

/** A text's lines, a final line break ending the last rather than starting another. */
function lines(text: string): string[] {
  if (text === '') return []
  const all = text.split('\n')
  if (all.at(-1) === '') all.pop()
  return all
}

function lineCount(text: string): number {
  if (text === '') return 0
  let count = text.endsWith('\n') ? 0 : 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return count
}

/** The lines a change adds and removes; null for both when comparing them takes too long. */
export function diffCounts(
  oldText: string | null,
  newText: string,
): { added: number | null; removed: number | null } {
  const after = lines(newText)
  if (oldText === null) return { added: after.length, removed: 0 }
  const before = lines(oldText)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++
  }
  const a = before.slice(start, before.length - end)
  const b = after.slice(start, after.length - end)
  const distance = editDistance(a, b)
  if (distance === null) return { added: null, removed: null }
  const common = (a.length + b.length - distance) / 2
  return { added: b.length - common, removed: a.length - common }
}

/**
 * The fewest lines to remove and add to turn `a` into `b`, by Myers' O(ND) algorithm; null past
 * `DIFF_WORK` steps. Node's `util.diff` would also do, but it keeps a copy of its frontier for
 * every step, so a rewritten file of a few thousand lines takes hundreds of megabytes, with no
 * bound on its time.
 */
function editDistance(a: readonly string[], b: readonly string[]): number | null {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return n + m
  const max = n + m
  const offset = max + 1
  // The furthest x reached on each diagonal k = x - y, at index offset + k.
  const reach = new Int32Array(2 * max + 3)
  let work = 0
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && reach[offset + k - 1]! < reach[offset + k + 1]!)
      const from = down ? reach[offset + k + 1]! : reach[offset + k - 1]! + 1
      let x = from
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      work += 1 + x - from
      reach[offset + k] = x
      if (x >= n && y >= m) return d
    }
    if (work > DIFF_WORK) return null
  }
  return max
}
