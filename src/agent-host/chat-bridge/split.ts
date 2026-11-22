// Huli: a long reply cut into messages a chat platform takes. Each piece stays within the
// platform's limit as it counts (UTF-16 units for Telegram, UTF-8 bytes for Feishu's cards), cut
// at a paragraph, else a line, else a space, else anywhere but inside a character; a code block
// cut in two is closed at the end of one piece and opened again, with its language, at the start
// of the next. See tools/huli/README.md (Chat apps).

/** How a platform counts a message's length. */
export type Measure = (text: string) => number

export const utf16Length: Measure = (text) => text.length
export const utf8Length: Measure = (text) => Buffer.byteLength(text, 'utf8')

/** The most pieces one reply is sent as; the rest is left out with a line that says so. */
export const MAX_PIECES = 20

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

interface Fence {
  marker: string
  info: string
}

/** The code block open after `lines`, given the one open before them. */
function fenceAfter(lines: readonly string[], open: Fence | null): Fence | null {
  let fence = open
  for (const line of lines) {
    const match = FENCE.exec(line)
    if (!match) continue
    const marker = match[1]!
    if (fence === null) fence = { marker, info: match[2]!.trim() }
    else if (
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      !match[2]!.trim()
    )
      fence = null
  }
  return fence
}

/** The longest start of `text` within `budget`, cut between characters, never inside one. */
function fitting(text: string, budget: number, measure: Measure): number {
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (measure(text.slice(0, mid)) <= budget) low = mid
    else high = mid - 1
  }
  // A cut between the halves of a surrogate pair would leave half a character on each side.
  const code = text.charCodeAt(low - 1)
  if (low > 0 && low < text.length && code >= 0xd800 && code <= 0xdbff) low--
  return low
}

/** Where to cut `text`, which is over `budget`: the last paragraph, line or space within it. */
function cutAt(text: string, budget: number, measure: Measure): number {
  const most = fitting(text, budget, measure)
  if (most <= 0) return 0
  const head = text.slice(0, most)
  // A cut too near the start wastes a piece; past a third of it a softer cut is worth taking.
  const floor = Math.floor(most / 3)
  for (const separator of ['\n\n', '\n', ' ']) {
    const at = head.lastIndexOf(separator)
    if (at > floor) return at + separator.length
  }
  return most
}

/**
 * `text` in pieces of at most `limit` as `measure` counts, in order. An empty text is no piece.
 * Past `maxPieces` the last piece says how much was left out, in `omitted`'s words.
 */
export function splitMessage(
  text: string,
  limit: number,
  measure: Measure = utf16Length,
  omitted: (pieces: number) => string = (n) => `… (${n} more)`,
  maxPieces = MAX_PIECES,
): string[] {
  const body = text.replace(/\r\n?/g, '\n').trimEnd()
  if (body.trim() === '') return []
  if (measure(body) <= limit) return [body]
  const pieces: string[] = []
  let rest = body
  let open: Fence | null = null
  while (rest !== '') {
    const opener = open ? `${open.marker}${open.info}\n` : ''
    const whole = `${opener}${rest}`
    if (measure(whole) <= limit) {
      pieces.push(whole)
      break
    }
    // Room for the fence that may have to close this piece, as long as any a reply opens.
    const fenceRoom = measure(`\n${'`'.repeat(Math.max(8, open?.marker.length ?? 0))}`)
    const budget = limit - measure(opener) - fenceRoom
    if (budget <= 0) throw new Error('The limit is too small for a piece')
    let cut = cutAt(rest, budget, measure)
    if (cut === 0) cut = Math.max(1, fitting(rest, budget, measure))
    const taken = rest.slice(0, cut)
    const after = fenceAfter(taken.split('\n'), open)
    let piece = `${opener}${taken.replace(/\n+$/, '')}`
    if (after) piece += `\n${after.marker}`
    pieces.push(piece)
    open = after
    rest = rest.slice(cut)
    // Blank lines between pieces are lost anyway, but inside code they are the code's own.
    if (!after) rest = rest.replace(/^\n+/, '')
  }
  if (pieces.length <= maxPieces) return pieces
  const kept = pieces.slice(0, maxPieces)
  const left = pieces.length - maxPieces
  const note = omitted(left)
  const last = kept[maxPieces - 1]!
  kept[maxPieces - 1] = measure(`${last}\n\n${note}`) <= limit ? `${last}\n\n${note}` : note
  return kept
}
