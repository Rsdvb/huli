// Markdown read into blocks and inline runs for the phone's renderer: the CommonMark and GFM that
// agents write (headings, nested lists with tasks, quotes, fenced code, tables, rules, emphasis,
// code spans, links), forgiving about the half-written text a reply streams in.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'image'; href: string; alt: string }

export type Align = 'left' | 'center' | 'right' | null

export interface ListItem {
  blocks: Block[]
  /** A task item's box; null for a plain item. */
  task: boolean | null
}

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'code'; lang: string; text: string; open: boolean; meta: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] }
  | { kind: 'rule' }

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)([^`]*)$/
const HEADING = /^\s{0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*)|\s*$)/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const SETEXT = /^\s{0,3}(=+|-+)\s*$/

function indentOf(line: string): number {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n++
    else if (ch === '\t') n += 4 - (n % 4)
    else break
  }
  return n
}

/** Removes up to `n` columns of leading spaces. */
function dedent(line: string, n: number): string {
  let cut = 0
  let col = 0
  while (cut < line.length && col < n) {
    const ch = line[cut]
    if (ch === ' ') col++
    else if (ch === '\t') col += 4 - (col % 4)
    else break
    cut++
  }
  return line.slice(cut)
}

function cells(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const out: string[] = []
  let cell = ''
  let code = false
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!
    if (ch === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
    } else if (ch === '`') {
      code = !code
      cell += ch
    } else if (ch === '|' && !code) {
      out.push(cell.trim())
      cell = ''
    } else cell += ch
  }
  out.push(cell.trim())
  return out
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line)
  )
}

const sameTexts = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((text, i) => text === b[i])

/** Whether two blocks read the same, all the way down. */
function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true
  switch (a.kind) {
    case 'heading':
      return b.kind === 'heading' && a.level === b.level && a.text === b.text
    case 'para':
      return b.kind === 'para' && a.text === b.text
    case 'code':
      return (
        b.kind === 'code' &&
        a.lang === b.lang &&
        a.meta === b.meta &&
        a.open === b.open &&
        a.text === b.text
      )
    case 'rule':
      return b.kind === 'rule'
    case 'quote':
      return b.kind === 'quote' && sameBlocks(a.blocks, b.blocks)
    case 'table':
      return (
        b.kind === 'table' &&
        sameTexts(a.head, b.head) &&
        a.align.length === b.align.length &&
        a.align.every((align, i) => align === b.align[i]) &&
        a.rows.length === b.rows.length &&
        a.rows.every((row, i) => sameTexts(row, b.rows[i]!))
      )
    case 'list':
      return (
        b.kind === 'list' &&
        a.ordered === b.ordered &&
        a.start === b.start &&
        a.items.length === b.items.length &&
        a.items.every(
          (item, i) =>
            item.task === b.items[i]!.task && sameBlocks(item.blocks, b.items[i]!.blocks),
        )
      )
  }
}

function sameBlocks(a: readonly Block[], b: readonly Block[]): boolean {
  return a.length === b.length && a.every((block, i) => sameBlock(block, b[i]!))
}

/**
 * `next` with each block that reads as the one at its place in `before` replaced by it, and
 * `before` itself when all do: as a reply streams in, its finished blocks keep their objects.
 */
export function keepBlocks(before: readonly Block[], next: readonly Block[]): Block[] {
  if (before.length === 0) return next as Block[]
  let all = before.length === next.length
  const out = next.map((block, i) => {
    const old = before[i]
    if (old && sameBlock(old, block)) return old
    all = false
    return block
  })
  return all ? (before as Block[]) : out
}
export function parseBlocks(source: string): Block[] {
  return blocks(source.replace(/\r\n?/g, '\n').split('\n'))
}

/** What of a reply being written was read already: its text up to a block's start, and blocks. */
export interface Settled {
  text: string
  blocks: Block[]
}

/**
 * Where the last block that cannot reach back starts in `source`, from `from` on: a line after a
 * blank one, outside a fence, at the margin, that no list, quote or table goes on into. The parser
 * reads what comes before such a line and what comes after it apart as it reads them together.
 * `from` lies at such a start, or is 0.
 */
function lastStart(source: string, from: number): number {
  let found = from
  let fence: string | null = null
  let blank = false
  let at = from
  while (at < source.length) {
    const end = source.indexOf('\n', at)
    const next = end === -1 ? source.length : end + 1
    // The last line may still be being written: a start is known only once it has ended.
    if (end === -1) break
    const line = source.slice(at, end).replace(/\r$/, '')
    const trimmed = line.trim()
    if (fence !== null) {
      if (trimmed.startsWith(fence) && /^[`~]+$/.test(trimmed)) fence = null
    } else if (!trimmed) {
      blank = true
      at = next
      continue
    } else {
      if (blank && !/^\s/.test(line) && !ITEM.test(line) && !QUOTE.test(line)) found = at
      const open = FENCE.exec(line)
      if (open) fence = open[2]![0]!.repeat(open[2]!.length)
    }
    blank = false
    at = next
  }
  return found
}

/**
 * The blocks of a reply being written, read again as it grows: what was settled is kept and only
 * the text after its last block's start is read again, so a long reply costs the same each time
 * rather than more with each line. `settled` carries what was read between calls.
 */
export function streamBlocks(source: string, settled: { current: Settled | null }): Block[] {
  let base = settled.current
  if (!base || !source.startsWith(base.text)) base = { text: '', blocks: [] }
  const cut = lastStart(source, base.text.length)
  if (cut > base.text.length) {
    const read = parseBlocks(source.slice(base.text.length, cut))
    base = { text: source.slice(0, cut), blocks: [...base.blocks, ...read] }
  }
  settled.current = base
  return [...base.blocks, ...parseBlocks(source.slice(base.text.length))]
}

/** A reply's first part runs at least this many characters before the reply is cut. */
const FIRST_PART = 3000
/** Each later part runs at least this many characters. */
const PART = 1000

/** A piece of a long reply that the conversation draws as a row of its own. */
export interface ReplyPart {
  index: number
  text: string
  /** How it follows the part before: after a block, or between two items of one bullet list. */
  joint: 'block' | 'item'
  last: boolean
}

/** A reply cut into parts, with where its reading stopped, so a growing reply is read on. */
export interface ReplySplit {
  source: string
  parts: ReplyPart[]
  cuts: { at: number; joint: 'block' | 'item' }[]
  /** The start of the first line not read yet, which may still be being written. */
  read: number
  fence: string | null
  blank: boolean
  /** The kind of list a line at the margin seems to go on in: only to pass lines by quickly. */
  list: 'bullet' | 'ordered' | null
}

/**
 * How `line` may start a part after `before`: as a block of its own, as the next item of the
 * bullet list `before` ends in, or not at all. Read by the parser itself, so a cut never changes
 * what the reply reads as: the line starts afresh exactly when reading it after `before` gives
 * the blocks of the two read apart, and from such a line on, the rest reads alike either way.
 */
function jointAt(before: string, line: string): 'block' | 'item' | null {
  const head = parseBlocks(before)
  const tail = parseBlocks(line)
  const together = parseBlocks(before + line)
  if (sameBlocks(together, [...head, ...tail])) return 'block'
  const end = head[head.length - 1]
  const first = tail[0]
  // Read apart, an item with a pipe heads a table when a separator row follows, which a list
  // reading it as its next item never asks.
  if (
    line.includes('|') ||
    tail.length !== 1 ||
    end?.kind !== 'list' ||
    first?.kind !== 'list' ||
    end.ordered ||
    first.ordered ||
    together.length !== head.length
  ) {
    return null
  }
  const merged: Block = { ...end, items: [...end.items, ...first.items] }
  return sameBlocks(together, [...head.slice(0, -1), merged]) ? 'item' : null
}

/**
 * `source` cut into parts at the starts of blocks and between the items of bullet lists at the
 * margin, read on from `before` when it only grew. Each cut is checked by `jointAt`, so the parts
 * draw as the whole did. Cuts are made only once a line has ended and never move, so a part keeps
 * its text, and its object, as the reply grows; a reply read as it grew is cut where it would be
 * read finished.
 */
export function splitReply(source: string, before?: ReplySplit | null): ReplySplit {
  if (before && before.source === source) return before
  const grew = !!before && source.startsWith(before.source)
  const state: ReplySplit =
    before && grew
      ? { ...before, source, cuts: before.cuts }
      : {
          source,
          parts: [],
          cuts: [],
          read: 0,
          fence: null,
          blank: false,
          list: null,
        }
  let cuts = state.cuts
  const cut = (at: number, end: number) => {
    const from = cuts.length ? cuts[cuts.length - 1]!.at : 0
    if (at - from < (cuts.length ? PART : FIRST_PART)) return
    const joint = jointAt(source.slice(from, at), source.slice(at, end + 1))
    if (!joint) return
    if (cuts === state.cuts) cuts = [...cuts]
    cuts.push({ at, joint })
  }
  let at = state.read
  while (at < source.length) {
    const end = source.indexOf('\n', at)
    if (end === -1) break
    const line = source.slice(at, end).replace(/\r$/, '')
    const trimmed = line.trim()
    if (state.fence !== null) {
      if (trimmed.startsWith(state.fence) && /^[`~]+$/.test(trimmed)) state.fence = null
    } else if (!trimmed) {
      state.blank = true
      at = end + 1
      continue
    } else {
      if (!/^\s/.test(line)) {
        const item = RULE.test(line) ? null : ITEM.exec(line)
        if (item) {
          const bullet = !/\d/.test(item[2]!)
          // The next item of an ordered list never reads alike apart, so it is not tried.
          if ((bullet && state.list === 'bullet') || (state.blank && state.list !== 'ordered')) {
            cut(at, end)
          }
          state.list = bullet ? 'bullet' : 'ordered'
        } else if (state.blank) {
          cut(at, end)
          state.list = null
        } else if (startsBlock(line)) {
          state.list = null
        }
      }
      const open = FENCE.exec(line)
      if (open) state.fence = open[2]![0]!.repeat(open[2]!.length)
    }
    state.blank = false
    at = end + 1
  }
  state.read = at
  state.cuts = cuts

  const count = cuts.length + 1
  const parts: ReplyPart[] = []
  for (let i = 0; i < count; i++) {
    const from = i === 0 ? 0 : cuts[i - 1]!.at
    const to = i < cuts.length ? cuts[i]!.at : source.length
    const last = i === count - 1
    const old = grew ? before!.parts[i] : undefined
    // A part that ended before the text grew ends there still.
    if (old && !old.last && old.last === last) {
      parts.push(old)
      continue
    }
    const text = count === 1 ? source : source.slice(from, to)
    const joint = i === 0 ? 'block' : cuts[i - 1]!.joint
    parts.push(
      old && old.last === last && old.text === text ? old : { index: i, text, joint, last },
    )
  }
  state.parts = parts
  return state
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'para', text: para.join('\n') })
    para = []
  }

  for (let i = 0; i < lines.length;) {
    const line = lines[i]!
    if (!line.trim()) {
      flush()
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const indent = fence[1]!.length
      const mark = fence[2]!
      const code: string[] = []
      let j = i + 1
      let closed = false
      for (; j < lines.length; j++) {
        const body = lines[j]!
        const trimmed = body.trim()
        if (trimmed.startsWith(mark[0]!.repeat(mark.length)) && /^[`~]+$/.test(trimmed)) {
          closed = true
          break
        }
        code.push(dedent(body, indent))
      }
      out.push({
        kind: 'code',
        lang: fence[3] ?? '',
        text: code.join('\n'),
        open: !closed,
        meta: (fence[4] ?? '').trim(),
      })
      i = closed ? j + 1 : j
      continue
    }

    // A line of = or - under a paragraph makes it a heading.
    const setext = para.length > 0 ? SETEXT.exec(line) : null
    if (setext) {
      out.push({ kind: 'heading', level: setext[1]![0] === '=' ? 1 : 2, text: para.join(' ') })
      para = []
      i++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      out.push({ kind: 'heading', level: heading[1]!.length, text: heading[2] ?? '' })
      i++
      continue
    }

    if (RULE.test(line)) {
      flush()
      out.push({ kind: 'rule' })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      flush()
      const quoted: string[] = []
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!)
        if (q) quoted.push(q[1]!)
        else if (lines[i]!.trim() && !startsBlock(lines[i]!) && quoted.length)
          quoted.push(lines[i]!)
        else break
        i++
      }
      out.push({ kind: 'quote', blocks: blocks(quoted) })
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const sep = lines[i + 1]!
      if (sep.includes('|') || sep.includes('-')) {
        flush()
        const head = cells(line)
        const align: Align[] = cells(sep).map((cell) => {
          const left = cell.startsWith(':')
          const right = cell.endsWith(':')
          return left && right ? 'center' : right ? 'right' : left ? 'left' : null
        })
        const rows: string[][] = []
        i += 2
        while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
          rows.push(cells(lines[i]!))
          i++
        }
        out.push({ kind: 'table', head, align, rows })
        continue
      }
    }

    const item = ITEM.exec(line)
    if (item) {
      flush()
      i = list(lines, i, out)
      continue
    }

    para.push(line.trim())
    i++
  }
  flush()
  return out
}

/** Reads the list that starts at `start` into `out`; returns the line after it. */
function list(lines: string[], start: number, out: Block[]): number {
  const first = ITEM.exec(lines[start]!)!
  const base = indentOf(first[1]!)
  const ordered = /\d/.test(first[2]!)
  const items: { lines: string[] }[] = []
  let i = start
  let contentIndent = 0
  let blank = false

  while (i < lines.length) {
    const line = lines[i]!
    const item = ITEM.exec(line)
    const indent = indentOf(line)
    if (
      item &&
      indent >= base &&
      (items.length === 0 || indent < contentIndent) &&
      !RULE.test(line)
    ) {
      if (/\d/.test(item[2]!) !== ordered) {
        if (indent <= base) break
      } else {
        const rest = item[3] ?? ''
        const gap = rest ? Math.min(4, line.length - indent - item[2]!.length - rest.length) : 1
        contentIndent = indent + item[2]!.length + Math.max(1, gap)
        items.push({ lines: [rest] })
        blank = false
        i++
        continue
      }
    }
    if (!line.trim()) {
      blank = true
      items[items.length - 1]!.lines.push('')
      i++
      continue
    }
    if (indent >= contentIndent || indent > base + 1) {
      items[items.length - 1]!.lines.push(dedent(line, Math.min(indent, contentIndent)))
      blank = false
      i++
      continue
    }
    // A lazy continuation of the item's paragraph.
    if (!blank && !startsBlock(line)) {
      items[items.length - 1]!.lines.push(line.trim())
      i++
      continue
    }
    break
  }

  const parsed: ListItem[] = items.map((each) => {
    const lines = [...each.lines]
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
    let task: boolean | null = null
    const box = /^\[([ xX])\]\s+/.exec(lines[0] ?? '')
    if (box) {
      task = box[1] !== ' '
      lines[0] = lines[0]!.slice(box[0].length)
    }
    return { blocks: blocks(lines), task }
  })
  out.push({ kind: 'list', ordered, start: ordered ? parseInt(first[2]!, 10) : 1, items: parsed })
  return i
}

interface Rule {
  re: RegExp
  /** Whether a match may stand where it was found: emphasis by `_` needs no word before it. */
  ok?: (text: string, index: number) => boolean
  make(m: RegExpExecArray): Inline
}

const WORD = /[A-Za-z0-9_]/

const RULES: Rule[] = [
  { re: /\\([\\`*_{}[\]()#+\-.!|~<>])/g, make: (m) => ({ t: 'text', v: m[1]! }) },
  {
    re: /(`+)([\s\S]*?[^`])\1(?!`)/g,
    make: (m) => {
      const v = m[2]!.replace(/\n/g, ' ')
      return { t: 'code', v: /^ .* $/.test(v) ? v.slice(1, -1) : v }
    },
  },
  {
    re: /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g,
    make: (m) => ({ t: 'image', alt: m[1]!, href: m[2]! }),
  },
  {
    re: /\[((?:[^[\]]|\[[^\]]*\])+)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g,
    make: (m) => ({ t: 'link', href: m[2]!, c: inline(m[1]!) }),
  },
  {
    re: /<((?:https?|mailto):[^>\s]+)>/g,
    make: (m) => ({ t: 'link', href: m[1]!, c: [{ t: 'text', v: m[1]! }] }),
  },
  {
    re: /https?:\/\/[^\s<>()（）\u3000-\u303f\uff00-\uffef]+[^\s<>()（）.,;:!?'"\u3000-\u303f\uff00-\uffef]/g,
    make: (m) => ({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] }),
  },
  { re: /\*\*(?=\S)([\s\S]+?)\*\*/g, make: (m) => ({ t: 'strong', c: inline(m[1]!) }) },
  {
    re: /__(?=\S)([\s\S]+?)__(?![A-Za-z0-9_])/g,
    ok: (text, index) => index === 0 || !WORD.test(text[index - 1]!),
    make: (m) => ({ t: 'strong', c: inline(m[1]!) }),
  },
  { re: /~~(?=\S)([\s\S]+?)~~/g, make: (m) => ({ t: 'del', c: inline(m[1]!) }) },
  {
    re: /\*(?=[^\s*])((?:[^*\n]|\*\*[^*\n]+\*\*)+?)\*(?!\*)/g,
    make: (m) => ({ t: 'em', c: inline(m[1]!) }),
  },
  {
    re: /_(?=[^\s_])([^_\n]+?)_(?![A-Za-z0-9_])/g,
    ok: (text, index) => index === 0 || !WORD.test(text[index - 1]!),
    make: (m) => ({ t: 'em', c: inline(m[1]!) }),
  },
]

function earliest(text: string, from: number): { rule: Rule; m: RegExpExecArray } | null {
  let best: { rule: Rule; m: RegExpExecArray } | null = null
  for (const rule of RULES) {
    rule.re.lastIndex = from
    let m = rule.re.exec(text)
    while (m && rule.ok && !rule.ok(text, m.index)) {
      rule.re.lastIndex = m.index + 1
      m = rule.re.exec(text)
    }
    if (m && (!best || m.index < best.m.index)) best = { rule, m }
    if (best && best.m.index === from) break
  }
  return best
}

export function inline(text: string): Inline[] {
  const out: Inline[] = []
  let at = 0
  let plain = ''
  while (at < text.length) {
    const found = earliest(text, at)
    if (!found) break
    plain += text.slice(at, found.m.index)
    const node = found.rule.make(found.m)
    if (node.t === 'text') plain += node.v
    else {
      if (plain) out.push({ t: 'text', v: plain })
      plain = ''
      out.push(node)
    }
    at = found.m.index + found.m[0].length
  }
  plain += text.slice(at)
  if (plain) out.push({ t: 'text', v: plain })
  return out
}
