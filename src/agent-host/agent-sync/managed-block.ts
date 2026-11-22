// Huli: the block of shared instructions Kite keeps in an agent's instructions file, between two
// marker lines. Everything outside the block is the user's and stays byte for byte as it was:
// a new block goes at the end, a change replaces only the lines between the markers, and taking
// it out removes only its lines and the blank line Kite put before it.

export const BLOCK_START = '<!-- kite:shared start -->'
export const BLOCK_END = '<!-- kite:shared end -->'
const NOTE = '<!-- Managed by Kite (纸鸢): edit these in Kite, changes made here are replaced. -->'

export class BlockError extends Error {
  constructor(readonly code: 'unpaired' | 'several') {
    super(
      code === 'unpaired'
        ? 'The file has a Kite block marker without its partner'
        : 'The file has more than one Kite block',
    )
  }
}

interface Found {
  /** The start of the start marker's line, and the end of the end marker's line break. */
  start: number
  end: number
  /** The text between the marker lines. */
  inner: string
}

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n')

function markerLines(text: string, marker: string): number[] {
  const found: number[] = []
  let at = 0
  for (const line of text.split('\n')) {
    if (line.replace(/\r$/, '').trim() === marker) found.push(at)
    at += line.length + 1
  }
  return found
}

/** The block in `text`, or null when it has none. */
export function findBlock(text: string): Found | null {
  const starts = markerLines(text, BLOCK_START)
  const ends = markerLines(text, BLOCK_END)
  if (starts.length === 0 && ends.length === 0) return null
  if (starts.length !== ends.length) throw new BlockError('unpaired')
  if (starts.length > 1) throw new BlockError('several')
  const start = starts[0]!
  const endLine = ends[0]!
  if (endLine < start) throw new BlockError('unpaired')
  const newline = text.indexOf('\n', endLine)
  const end = newline < 0 ? text.length : newline + 1
  const innerStart = text.indexOf('\n', start) + 1
  return { start, end, inner: text.slice(innerStart, endLine) }
}

/** The snippets as the block's body, in the file's line breaks. */
export function blockBody(snippets: readonly string[], eol: string): string {
  return snippets
    .map((text) => text.replace(/\r\n?/g, '\n').replace(/\s+$/, ''))
    .filter((text) => text.trim() !== '')
    .join('\n\n')
    .split('\n')
    .join(eol)
}

function blockText(snippets: readonly string[], eol: string): string {
  const body = blockBody(snippets, eol)
  return `${BLOCK_START}${eol}${NOTE}${eol}${body === '' ? '' : body + eol}${BLOCK_END}${eol}`
}

/** The body the block in `text` holds, without Kite's note; null when there is no block. */
export function blockContent(text: string): string | null {
  const found = findBlock(text)
  if (!found) return null
  const eol = eolOf(text)
  const lines = found.inner.split('\n')
  if (lines[0]?.replace(/\r$/, '').trim() === NOTE) lines.shift()
  return lines
    .join('\n')
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .join(eol)
}

/**
 * `text` with the block holding `snippets`, or without the block when there are none. A new block
 * goes at the end of the file after a blank line.
 */
export function withBlock(text: string, snippets: readonly string[]): string {
  const found = findBlock(text)
  const eol = eolOf(text)
  const empty = snippets.every((snippet) => snippet.trim() === '')
  if (!found) {
    if (empty) return text
    const block = blockText(snippets, eol)
    if (text === '') return block
    return text + (text.endsWith('\n') ? eol : eol + eol) + block
  }
  if (empty) return removeBlock(text, found)
  return text.slice(0, found.start) + blockText(snippets, eol) + text.slice(found.end)
}

function removeBlock(text: string, found: Found): string {
  const before = text.slice(0, found.start)
  const after = text.slice(found.end)
  // The blank line Kite put before a block at the end of the file goes with it.
  if (after === '') {
    if (before.endsWith('\r\n\r\n')) return before.slice(0, -2)
    if (before.endsWith('\n\n')) return before.slice(0, -1)
  }
  return before + after
}
