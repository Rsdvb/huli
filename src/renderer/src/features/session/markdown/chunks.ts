import { parseMarkdownIntoBlocks } from 'streamdown'
import { fenceInlineSvgFrom, SVG_START, type SvgState } from './inline-svg'
import { BRACKET_START, fenceBracketMathFrom, type BracketState } from './maths'

/**
 * A chunk is cut once the text after the previous one grows past this many characters: a screen
 * or two of prose, which is how much more than it shows a long text renders (in-parts.ts).
 */
export const CHUNK_SIZE = 3_000

// The last blocks can still change as text arrives: a paragraph becomes a setext heading, a list
// takes another item, and a cut at the window's edge leaves the last block incomplete.
const LIVE_BLOCKS = 2

// Footnotes and link definitions resolve across the whole text, which Streamdown then renders as
// one block; these are its own tests for them.
const FOOTNOTE = /\[\^[\w-]{1,200}\]/
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:/m

/** Where the rewrites before parsing (prepare) stand at a cut, which the next chunk goes on from. */
interface Rewrites {
  svg: SvgState
  math: BracketState
}

const START: Rewrites = { svg: SVG_START, math: BRACKET_START }

const NONE: readonly string[] = []

export interface Chunks {
  /** The text the chunks were cut from, as given. */
  markdown: string
  /** Whether the tail was written for a text still being written. */
  live: boolean
  /**
   * The settled chunks, prepared for parsing: none changes once cut, and the array stays the same
   * while no chunk settles, so a streamed update renders and allocates for the tail alone.
   */
  settled: readonly string[]
  /** The length of the text the settled chunks were cut from. */
  settledLength: number
  /** Where the rewrites stand at the end of the settled chunks. */
  rewrites: Rewrites
  /** The text after the settled chunks, as given. */
  rest: string
  /** The rest, prepared: the live tail, or a finished text's last chunk. */
  tail: string
  /** The text length at which the tail is looked at again. */
  retryAt: number
}

/** The chunks' count: the settled ones and the tail. */
export const chunkCount = (chunks: Chunks): number => chunks.settled.length + 1

/** The chunk at `index`, the tail past the settled ones. */
export const chunkAt = (chunks: Chunks, index: number): string =>
  index < chunks.settled.length ? chunks.settled[index]! : chunks.tail

/**
 * The text as the renderer parses it: an inline `<svg>` written as an `svg` code block
 * (`inline-svg.ts`) and a `\[...\]` on lines of its own as a `$$` block (`maths.ts`), going on
 * from `from`. `open` says one of them has not closed by the text's end.
 */
function prepare(
  text: string,
  live: boolean,
  from: Rewrites,
  withState: boolean,
): { text: string; rewrites: Rewrites; open: boolean } {
  const svg = fenceInlineSvgFrom(text, live, from.svg, withState)
  const math = fenceBracketMathFrom(svg.text, live, from.math, withState)
  return {
    text: math.text,
    rewrites: { svg: svg.state, math: math.state },
    open: svg.open || math.open,
  }
}

/**
 * Splits markdown into chunks that end on block boundaries, so a long message renders as settled
 * chunks that never change plus a live tail, and each streamed update costs the tail rather than
 * the whole message. When the text only grew since `previous`, its settled chunks are kept as
 * they are and only the tail is prepared again; the tail is lexed again only every few thousand
 * characters. A chunk is cut only where no rewritten picture or formula runs on past it, so
 * preparing each chunk after the one before gives the text it would as a whole.
 *
 * `appended`, when given, is what was added to `previous.markdown` to make `text` (thread.ts,
 * textStep). Then nothing reads the whole text: an append leaves it in pieces, and reading it, even
 * to compare or slice it, joins them into one string the size of all of it, at every update.
 */
export function splitIntoChunks(
  text: string,
  live: boolean,
  previous?: Chunks,
  appended?: string,
): Chunks {
  const grown = previous !== undefined && appended !== undefined
  const kept = grown || (previous !== undefined && keepsSettled(text, previous))
  let settled = kept ? previous!.settled : NONE
  let offset = kept ? previous!.settledLength : 0
  let rewrites = kept ? previous!.rewrites : START
  let rest = grown ? previous!.rest + appended : text.slice(offset)
  // Settled chunks hold neither, so only the text after them needs the test.
  if (FOOTNOTE.test(rest) || LINK_DEFINITION.test(rest)) {
    return {
      markdown: text,
      live,
      settled: NONE,
      settledLength: 0,
      rewrites: START,
      rest: text,
      tail: prepare(text, live, START, false).text,
      retryAt: 0,
    }
  }
  if (kept && text.length < previous!.retryAt) {
    return {
      ...previous!,
      markdown: text,
      live,
      rest,
      tail: prepare(rest, live, rewrites, false).text,
    }
  }
  for (;;) {
    const from = rewrites
    const cut = nextCut(rest, (length) => {
      const chunk = prepare(rest.slice(0, length), live, from, true)
      return chunk.open ? null : chunk
    })
    if (!cut) break
    settled = [...settled, own(cut.chunk.text)]
    offset += cut.length
    rewrites = cut.chunk.rewrites
    rest = rest.slice(cut.length)
  }
  return {
    markdown: text,
    live,
    settled,
    settledLength: offset,
    rewrites,
    rest,
    tail: prepare(rest, live, rewrites, false).text,
    // A tail too long to settle is one large block still arriving; it is looked at again after
    // half a chunk more.
    retryAt: rest.length > CHUNK_SIZE ? text.length + CHUNK_SIZE / 2 : offset + CHUNK_SIZE + 1,
  }
}

/** Whether `text` still starts with what `previous` settled. */
function keepsSettled(text: string, previous: Chunks): boolean {
  const length = previous.settledLength
  if (length === 0) return true
  if (text.length < length) return false
  // Streamed text only grows, so the whole of the previous text is the common case.
  return text.startsWith(previous.markdown) || text.startsWith(previous.markdown.slice(0, length))
}

/**
 * The text as a string of its own. A slice refers to the whole string it was cut from, so each
 * settled chunk of a reply being written held on to the reply as it was then: one of 300 KB
 * streamed in a hundred chunks kept 15 MB of its earlier versions.
 */
function own(text: string): string {
  return JSON.parse(JSON.stringify(text)) as string
}

/**
 * The first chunk of `text`: the first run of its settled blocks of CHUNK_SIZE or more, or all of
 * them when they come to less, that `fits` takes; null when what there is is still live.
 */
function nextCut<T>(
  text: string,
  fits: (length: number) => T | null,
): { length: number; chunk: T } | null {
  if (text.length <= CHUNK_SIZE) return null
  // Lexing a window rather than the rest keeps a long finished message linear to split.
  for (let window = 2 * CHUNK_SIZE; ; window *= 2) {
    const blocks = parseMarkdownIntoBlocks(text.slice(0, window)).slice(0, -LIVE_BLOCKS)
    let length = 0
    for (let i = 0; i < blocks.length; i++) {
      length += blocks[i]!.length
      if (length < CHUNK_SIZE && i < blocks.length - 1) continue
      const chunk = fits(length)
      if (chunk) return { length, chunk }
    }
    if (window >= text.length) return null
  }
}
