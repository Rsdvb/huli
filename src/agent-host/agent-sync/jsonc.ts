// Huli: JSON with comments and trailing commas, as several agents' settings files are: read into
// values, and changed one member at a time, so every byte outside that member stays as it was.

const BOM = 0xfeff

/** The text is not JSON this module can read or change. */
export class JsoncError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message)
  }
}

export interface Member {
  key: string
  keyStart: number
  valueStart: number
  valueEnd: number
  /** The comma that follows the value, when one does. */
  commaAfter: number | null
}

export interface ObjectSpan {
  open: number
  close: number
  members: Member[]
}

const isSpace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r'

/** Past whitespace, comments and a leading byte order mark. */
function skipTrivia(text: string, from: number): number {
  let i = from
  for (;;) {
    if (i === 0 && text.charCodeAt(0) === BOM) i++
    const char = text[i]
    if (isSpace(char)) {
      i++
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) throw new JsoncError('unterminated comment', i)
      i = end + 2
    } else {
      return i
    }
  }
}

function stringEnd(text: string, from: number): number {
  let i = from + 1
  while (i < text.length) {
    const char = text[i]
    if (char === '\\') i += 2
    else if (char === '"') return i + 1
    else if (char === '\n') break
    else i++
  }
  throw new JsoncError('unterminated string', from)
}

function valueEnd(text: string, from: number): number {
  const first = text[from]
  if (first === '"') return stringEnd(text, from)
  if (first === '{') return objectAt(text, from).close + 1
  if (first === '[') {
    let i = skipTrivia(text, from + 1)
    while (text[i] !== ']') {
      if (i >= text.length) throw new JsoncError('unterminated array', from)
      i = skipTrivia(text, valueEnd(text, i))
      if (text[i] === ',') i = skipTrivia(text, i + 1)
      else if (text[i] !== ']') throw new JsoncError('expected , or ]', i)
    }
    return i + 1
  }
  let i = from
  while (i < text.length && !isSpace(text[i]) && !',:}]/'.includes(text[i]!)) i++
  if (i === from) throw new JsoncError('expected a value', from)
  return i
}

/** The members of the object that opens at `open`, in order. */
export function objectAt(text: string, open: number): ObjectSpan {
  if (text[open] !== '{') throw new JsoncError('expected {', open)
  const members: Member[] = []
  let i = skipTrivia(text, open + 1)
  while (text[i] !== '}') {
    if (text[i] !== '"') throw new JsoncError('expected a quoted key', i)
    const keyStart = i
    const keyEnd = stringEnd(text, i)
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string
    i = skipTrivia(text, keyEnd)
    if (text[i] !== ':') throw new JsoncError('expected :', i)
    const valueStart = skipTrivia(text, i + 1)
    const end = valueEnd(text, valueStart)
    i = skipTrivia(text, end)
    let commaAfter: number | null = null
    if (text[i] === ',') {
      commaAfter = i
      i = skipTrivia(text, i + 1)
    } else if (text[i] !== '}') {
      throw new JsoncError('expected , or }', i)
    }
    members.push({ key, keyStart, valueStart, valueEnd: end, commaAfter })
  }
  return { open, close: i, members }
}

/** The top-level object of `text`; an empty or blank text has none. */
function rootObject(text: string): ObjectSpan | null {
  const start = skipTrivia(text, 0)
  if (start >= text.length) return null
  const span = objectAt(text, start)
  if (skipTrivia(text, span.close + 1) < text.length) {
    throw new JsoncError('text after the top-level object', span.close + 1)
  }
  return span
}

/** `text` as plain JSON: comments blanked and trailing commas dropped. */
function stripped(text: string): string {
  let out = ''
  let i = text.charCodeAt(0) === BOM ? 1 : 0
  let pendingComma = -1
  while (i < text.length) {
    const char = text[i]!
    if (char === '"') {
      const end = stringEnd(text, i)
      out += text.slice(i, end)
      i = end
      pendingComma = -1
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) throw new JsoncError('unterminated comment', i)
      i = end + 2
      out += ' '
    } else if (char === ',') {
      pendingComma = out.length
      out += char
      i++
    } else if ((char === '}' || char === ']') && pendingComma >= 0) {
      out = out.slice(0, pendingComma) + out.slice(pendingComma + 1) + char
      pendingComma = -1
      i++
    } else {
      if (!isSpace(char)) pendingComma = -1
      out += char
      i++
    }
  }
  return out
}

/** The value of a JSON or JSONC text; an empty or blank text is an empty object. */
export function parseJsonc(text: string): unknown {
  const plain = stripped(text)
  if (plain.trim() === '') return {}
  try {
    return JSON.parse(plain) as unknown
  } catch (error) {
    throw new JsoncError((error as Error).message, 0)
  }
}

const lineStart = (text: string, at: number): number => text.lastIndexOf('\n', at - 1) + 1

/** The whitespace that starts the line `at` is on. */
function lineIndent(text: string, at: number): string {
  const start = lineStart(text, at)
  let end = start
  while (text[end] === ' ' || text[end] === '\t') end++
  return text.slice(start, end)
}

/** Whether only whitespace comes before `at` on its line. */
const startsLine = (text: string, at: number): boolean =>
  text.slice(lineStart(text, at), at).trim() === ''

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** One level of the file's indentation, from its first indented key; two spaces otherwise. */
function indentUnit(text: string): string {
  const match = /\n([ \t]+)"/.exec(text)
  if (!match) return '  '
  const indent = match[1]!
  return indent.startsWith('\t') ? '\t' : ' '.repeat(Math.min(indent.length, 8))
}

/** `value` as JSON whose lines after the first start with `indent`. */
function serialize(value: unknown, unit: string, indent: string, eol: string, compact: boolean) {
  if (compact) return JSON.stringify(value)
  return JSON.stringify(value, null, unit)
    .split('\n')
    .join(eol + indent)
}

function memberOf(span: ObjectSpan, key: string): Member | undefined {
  // The last of duplicate keys is the one JSON.parse keeps.
  return span.members.findLast((member) => member.key === key)
}

/** The object `path` names, the root for an empty path; undefined when a step is missing. */
function objectAtPath(text: string, path: readonly string[]): ObjectSpan | null | undefined {
  let span = rootObject(text)
  if (!span) return null
  for (const key of path) {
    const member = memberOf(span, key)
    if (!member) return undefined
    if (text[member.valueStart] !== '{') {
      throw new JsoncError(`"${key}" is not an object`, member.valueStart)
    }
    span = objectAt(text, member.valueStart)
  }
  return span
}

function insertInto(text: string, span: ObjectSpan, key: string, value: unknown): string {
  const eol = eolOf(text)
  const unit = indentUnit(text)
  const multiline = text.includes('\n')
  const last = span.members.at(-1)
  if (!last) {
    const interior = text.slice(span.open + 1, span.close)
    const outer = lineIndent(text, span.open)
    const indent = outer + unit
    if (!multiline) {
      const body = `${JSON.stringify(key)}: ${serialize(value, unit, '', eol, true)}`
      return text.slice(0, span.open + 1) + body + text.slice(span.close)
    }
    const body = `${JSON.stringify(key)}: ${serialize(value, unit, indent, eol, false)}`
    if (interior.trim() === '') {
      return `${text.slice(0, span.open + 1)}${eol}${indent}${body}${eol}${outer}${text.slice(span.close)}`
    }
    return `${text.slice(0, span.open + 1)}${eol}${indent}${body}${text.slice(span.open + 1)}`
  }
  const ownLine = startsLine(text, last.keyStart)
  const indent = ownLine ? lineIndent(text, last.keyStart) : ''
  const body = `${JSON.stringify(key)}: ${serialize(value, unit, indent, eol, !ownLine)}`
  if (ownLine) {
    // The new member takes a line of its own after the last one's, which keeps its comment.
    const after = last.commaAfter !== null ? last.commaAfter + 1 : last.valueEnd
    const lineEnd = restOfLine(text, after, span.close)
    if (lineEnd >= 0) {
      const line = `${indent}${body}${last.commaAfter !== null ? ',' : ''}${eol}`
      const head =
        last.commaAfter !== null
          ? text.slice(0, lineEnd)
          : `${text.slice(0, last.valueEnd)},${text.slice(last.valueEnd, lineEnd)}`
      return head + line + text.slice(lineEnd)
    }
  }
  const gap = ownLine ? eol + indent : ' '
  if (last.commaAfter !== null) {
    // A trailing comma stays trailing.
    const at = last.commaAfter + 1
    return `${text.slice(0, at)}${gap}${body},${text.slice(at)}`
  }
  return `${text.slice(0, last.valueEnd)},${gap}${body}${text.slice(last.valueEnd)}`
}

/** The end of the whitespace after `at` on its line, past the line break when only that follows. */
function trailingLineEnd(text: string, at: number): number {
  let i = at
  while (text[i] === ' ' || text[i] === '\t') i++
  if (text[i] === '\r' && text[i + 1] === '\n') return i + 2
  if (text[i] === '\n') return i + 1
  return at
}

function removeFrom(text: string, span: ObjectSpan, index: number): string {
  const member = span.members[index]!
  const own = startsLine(text, member.keyStart)
  const from = own ? lineStart(text, member.keyStart) : member.keyStart
  if (span.members.length === 1) {
    const end = member.commaAfter !== null ? member.commaAfter + 1 : member.valueEnd
    const next = text.slice(0, from) + text.slice(own ? trailingLineEnd(text, end) : end)
    // An object left with only whitespace closes up.
    const close = span.close - (text.length - next.length)
    if (next.slice(span.open + 1, close).trim() === '') {
      return next.slice(0, span.open + 1) + next.slice(close)
    }
    return next
  }
  if (member.commaAfter !== null) {
    const end = member.commaAfter + 1
    const to = own ? trailingLineEnd(text, end) : skipSpaces(text, end)
    return text.slice(0, from) + text.slice(to)
  }
  // The last member without a comma takes the comma before it.
  const comma = span.members[index - 1]!.commaAfter!
  if (own) {
    const rest = text.slice(0, from) + text.slice(trailingLineEnd(text, member.valueEnd))
    return rest.slice(0, comma) + rest.slice(comma + 1)
  }
  return text.slice(0, comma) + text.slice(member.valueEnd)
}

/** Past the line break after `from`, when only spaces and a line comment come before it. */
function restOfLine(text: string, from: number, limit: number): number {
  let i = skipSpaces(text, from)
  if (text[i] === '/' && text[i + 1] === '/') {
    while (i < limit && text[i] !== '\n') i++
  }
  if (text[i] === '\r') i++
  return text[i] === '\n' && i < limit ? i + 1 : -1
}

function skipSpaces(text: string, at: number): number {
  let i = at
  while (text[i] === ' ' || text[i] === '\t') i++
  return i
}

/**
 * Sets `key` in the object `path` names, which is made as members of the root when missing; a new
 * member goes last, a present one has its value replaced where it is.
 */
export function setMember(
  text: string,
  path: readonly string[],
  key: string,
  value: unknown,
): string {
  const eol = eolOf(text)
  if (rootObject(text) === null) {
    const nested = path.reduceRight<unknown>((inner, step) => ({ [step]: inner }), {
      [key]: value,
    })
    const lead = text.charCodeAt(0) === BOM ? String.fromCharCode(BOM) : ''
    return `${lead}${JSON.stringify(nested, null, 2).split('\n').join(eol)}${eol}`
  }
  for (let depth = 0; depth < path.length; depth++) {
    const span = objectAtPath(text, path.slice(0, depth + 1))
    if (span === undefined) {
      const parent = objectAtPath(text, path.slice(0, depth))!
      const nested = path
        .slice(depth + 1)
        .reduceRight<unknown>((inner, step) => ({ [step]: inner }), { [key]: value })
      return insertInto(text, parent, path[depth]!, nested)
    }
  }
  const span = objectAtPath(text, path)!
  const member = memberOf(span, key)
  if (!member) return insertInto(text, span, key, value)
  const ownLine = startsLine(text, member.keyStart)
  const indent = ownLine ? lineIndent(text, member.keyStart) : ''
  const body = serialize(value, indentUnit(text), indent, eol, !ownLine)
  return text.slice(0, member.valueStart) + body + text.slice(member.valueEnd)
}

/** Removes `key` from the object `path` names; the text comes back unchanged when it is absent. */
export function removeMember(text: string, path: readonly string[], key: string): string {
  const span = objectAtPath(text, path)
  if (!span) return text
  let next = text
  // Every copy of a duplicated key goes, last first so the earlier positions hold.
  for (let index = span.members.length - 1; index >= 0; index--) {
    if (span.members[index]!.key !== key) continue
    next = removeFrom(next, objectAtPath(next, path)!, index)
  }
  return next
}
