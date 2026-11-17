// The composer's text rules, as the desktop's editor keeps them (composer/slash.ts, chips.ts):
// a slash command typed at the start, an `@` mention typed anywhere a word starts, and each
// mention's `@name` kept as one piece, so an edit that cuts into it takes the whole of it, and with
// it the file it attached.

/** A mention's `@name` in the text, and the attachment it stands for, by its key. */
export interface Mention {
  key: string
  from: number
  to: number
}

export interface Edited {
  text: string
  mentions: Mention[]
  /** The keys of the mentions the edit broke, whose attachments go. */
  dropped: string[]
  /** Where the caret goes when the edit took more than was typed; null when it stays. */
  caret: number | null
  /** What was typed or pasted in one go. */
  inserted: string
  /** Where it went. */
  at: number
}

/**
 * The text after a change the keyboard made, with the mentions moved along. A deletion that reaches
 * into a mention takes the whole `@name`; typing inside one leaves the text and lets the mention go.
 */
export function editText(before: string, after: string, mentions: readonly Mention[]): Edited {
  let start = 0
  const shortest = Math.min(before.length, after.length)
  while (start < shortest && before[start] === after[start]) start++
  let tail = 0
  while (
    tail < shortest - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }
  const oldEnd = before.length - tail
  const inserted = after.slice(start, after.length - tail)
  const deleting = oldEnd > start

  const touched = mentions.filter((m) =>
    deleting ? m.from < oldEnd && m.to > start : m.from < start && m.to > start,
  )
  if (touched.length === 0) {
    const delta = after.length - before.length
    return {
      text: after,
      mentions: mentions.map((m) =>
        m.from >= oldEnd && !(m.to <= start) ? { ...m, from: m.from + delta, to: m.to + delta } : m,
      ),
      dropped: [],
      caret: null,
      inserted,
      at: start,
    }
  }
  const dropped = touched.map((m) => m.key)
  if (!deleting) {
    // Typed inside a mention: the text stays as typed, and the mention is plain text from now.
    const delta = after.length - before.length
    return {
      text: after,
      mentions: mentions
        .filter((m) => !dropped.includes(m.key))
        .map((m) => (m.from >= start ? { ...m, from: m.from + delta, to: m.to + delta } : m)),
      dropped,
      caret: null,
      inserted,
      at: start,
    }
  }
  const from = Math.min(start, ...touched.map((m) => m.from))
  const to = Math.max(oldEnd, ...touched.map((m) => m.to))
  const text = before.slice(0, from) + inserted + before.slice(to)
  const delta = text.length - before.length
  return {
    text,
    mentions: mentions
      .filter((m) => !dropped.includes(m.key))
      .map((m) => (m.from >= to ? { ...m, from: m.from + delta, to: m.to + delta } : m)),
    dropped,
    caret: from + inserted.length,
    inserted,
    at: from,
  }
}

/** The text with `[from, to)` replaced by `put`, the mentions after it moved along. */
export function replaceRange(
  text: string,
  mentions: readonly Mention[],
  from: number,
  to: number,
  put: string,
): { text: string; mentions: Mention[] } {
  const delta = put.length - (to - from)
  return {
    text: text.slice(0, from) + put + text.slice(to),
    mentions: mentions
      .filter((m) => m.to <= from || m.from >= to)
      .map((m) => (m.from >= to ? { ...m, from: m.from + delta, to: m.to + delta } : m)),
  }
}

/** The `/word` being typed at the very start of the text, with the caret in it; null otherwise. */
export function slashAt(text: string, caret: number | null): string | null {
  if (caret === null || !text.startsWith('/')) return null
  const word = /^\/(\S*)/.exec(text)![0]
  if (caret < 1 || caret > word.length) return null
  return word.slice(1)
}

/** The length of the command the text starts with, as the agent reads it: `/name` exactly. */
export function leadingCommand(text: string, names: readonly string[]): number {
  const match = /^\/(\S+)(?=[ \n]|$)/.exec(text)
  return match && names.includes(match[1]!) ? match[0].length : 0
}

/** The text with `/name ` at its start, in place of the word being typed or a command there. */
export function withCommand(text: string, name: string, names: readonly string[]): string {
  const typed = /^\/\S*/.exec(text)
  const led = leadingCommand(text, names)
  const cut = typed ? typed[0].length : led
  const rest = text.slice(cut).replace(/^ /, '')
  return `/${name} ${rest.trimStart()}`
}

export interface MentionQuery {
  /** Where the `@` is. */
  start: number
  /** The end of the word it starts. */
  end: number
  query: string
}

/** The `@word` the caret is in, where the `@` starts a word and no mention holds it. */
export function mentionAt(
  text: string,
  caret: number | null,
  mentions: readonly Mention[],
): MentionQuery | null {
  if (caret === null || caret > text.length) return null
  for (let at = caret - 1; at >= 0 && !/\s/.test(text[at]!); at--) {
    if (text[at] !== '@') continue
    if (at > 0 && !/\s/.test(text[at - 1]!)) return null
    if (mentions.some((m) => at >= m.from && at < m.to)) return null
    let end = caret
    while (end < text.length && !/\s/.test(text[end]!)) end++
    return { start: at, end, query: text.slice(at + 1, caret) }
  }
  return null
}
