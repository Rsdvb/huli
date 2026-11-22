// Huli: TOML as Codex's config.toml is written, read into values with the place of each table
// header, and changed one `[mcp_servers.<name>]` table at a time, so every other byte of the
// file stays as it was.

export class TomlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`)
  }
}

export interface TomlHeader {
  path: string[]
  array: boolean
  /** Where the header's line starts. */
  start: number
}

export type TomlTable = Record<string, unknown>

const BARE = /^[A-Za-z0-9_-]+$/
const ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  e: '\x1b',
  '"': '"',
  '\\': '\\',
}

const isTable = (value: unknown): value is TomlTable =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

class Parser {
  i = 0
  readonly root: TomlTable = {}
  readonly headers: TomlHeader[] = []
  /** Tables made by a header or a dotted key, which a later header may not define again. */
  private readonly defined = new Set<TomlTable>()
  private readonly inline = new Set<TomlTable>()

  constructor(readonly text: string) {
    if (text.charCodeAt(0) === 0xfeff) this.i = 1
  }

  fail(message: string): never {
    throw new TomlError(message, this.text.slice(0, this.i).split('\n').length)
  }

  private spaces(): void {
    while (this.text[this.i] === ' ' || this.text[this.i] === '\t') this.i++
  }

  private comment(): void {
    if (this.text[this.i] === '#') {
      while (this.i < this.text.length && this.text[this.i] !== '\n') this.i++
    }
  }

  private lineEnd(): void {
    this.spaces()
    this.comment()
    if (this.i >= this.text.length) return
    if (this.text[this.i] === '\r' && this.text[this.i + 1] === '\n') this.i += 2
    else if (this.text[this.i] === '\n') this.i++
    else this.fail('expected the end of the line')
  }

  /** Whitespace, line breaks and comments, as arrays allow between their values. */
  private blank(): void {
    for (;;) {
      this.spaces()
      this.comment()
      const char = this.text[this.i]
      if (char === '\n') this.i++
      else if (char === '\r' && this.text[this.i + 1] === '\n') this.i += 2
      else return
    }
  }

  parse(): void {
    let table = this.root
    while (this.i < this.text.length) {
      this.blank()
      if (this.i >= this.text.length) break
      const start = this.text.lastIndexOf('\n', this.i - 1) + 1
      if (this.text[this.i] === '[') {
        const array = this.text[this.i + 1] === '['
        this.i += array ? 2 : 1
        this.spaces()
        const path = this.key()
        this.spaces()
        if (this.text[this.i] !== ']' || (array && this.text[this.i + 1] !== ']')) {
          this.fail('expected ] to close the table header')
        }
        this.i += array ? 2 : 1
        this.lineEnd()
        this.headers.push({ path, array, start })
        table = array ? this.arrayTable(path) : this.table(path)
      } else {
        this.pair(table)
        this.lineEnd()
      }
    }
  }

  private table(path: string[]): TomlTable {
    let table = this.root
    for (const [index, key] of path.entries()) {
      const last = index === path.length - 1
      let next = table[key]
      if (next === undefined) {
        next = {}
        table[key] = next
      } else if (Array.isArray(next) && !last) {
        next = next.at(-1)
      }
      if (!isTable(next) || this.inline.has(next)) this.fail(`${path.join('.')} is not a table`)
      if (last) {
        if (this.defined.has(next)) this.fail(`${path.join('.')} is defined twice`)
        this.defined.add(next)
      }
      table = next
    }
    return table
  }

  private arrayTable(path: string[]): TomlTable {
    const parent = path.length > 1 ? this.walk(this.root, path.slice(0, -1), false) : this.root
    const key = path.at(-1)!
    const list = parent[key] ?? []
    if (!Array.isArray(list)) this.fail(`${path.join('.')} is not an array of tables`)
    const table: TomlTable = {}
    list.push(table)
    parent[key] = list
    return table
  }

  /** The table `path` names under `table`, made when missing, through the last of each array. */
  private walk(table: TomlTable, path: string[], dotted: boolean): TomlTable {
    let current = table
    for (const key of path) {
      let next = current[key]
      if (next === undefined) {
        next = {}
        current[key] = next
        if (dotted) this.defined.add(next as TomlTable)
      } else if (Array.isArray(next)) {
        next = next.at(-1)
      }
      if (!isTable(next) || this.inline.has(next)) this.fail(`${key} is not a table`)
      current = next
    }
    return current
  }

  private pair(table: TomlTable): void {
    const path = this.key()
    this.spaces()
    if (this.text[this.i] !== '=') this.fail('expected =')
    this.i++
    this.spaces()
    const value = this.value()
    const target = this.walk(table, path.slice(0, -1), true)
    const key = path.at(-1)!
    if (key in target) this.fail(`${path.join('.')} is set twice`)
    target[key] = value
  }

  private key(): string[] {
    const parts: string[] = []
    for (;;) {
      this.spaces()
      const char = this.text[this.i]
      if (char === '"') parts.push(this.basic())
      else if (char === "'") parts.push(this.literal())
      else {
        const start = this.i
        while (this.i < this.text.length && /[A-Za-z0-9_-]/.test(this.text[this.i]!)) this.i++
        if (this.i === start) this.fail('expected a key')
        parts.push(this.text.slice(start, this.i))
      }
      this.spaces()
      if (this.text[this.i] !== '.') return parts
      this.i++
    }
  }

  private value(): unknown {
    const text = this.text
    const char = text[this.i]
    if (char === '"') return text.startsWith('"""', this.i) ? this.multiBasic() : this.basic()
    if (char === "'") return text.startsWith("'''", this.i) ? this.multiLiteral() : this.literal()
    if (char === '[') return this.array()
    if (char === '{') return this.inlineTable()
    if (text.startsWith('true', this.i)) {
      this.i += 4
      return true
    }
    if (text.startsWith('false', this.i)) {
      this.i += 5
      return false
    }
    const date =
      /^(\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?([Zz]|[+-]\d{2}:\d{2})?|\d{2}:\d{2}(:\d{2}(\.\d+)?)?)/.exec(
        text.slice(this.i, this.i + 40),
      )
    if (date && /^(\d{4}-|\d{2}:)/.test(date[0])) {
      this.i += date[0].length
      return date[0]
    }
    const start = this.i
    while (this.i < text.length && /[0-9A-Za-z_+.-]/.test(text[this.i]!)) this.i++
    const token = text.slice(start, this.i).replace(/_/g, '')
    if (token === '') this.fail('expected a value')
    const sign = token.startsWith('-') ? -1 : 1
    const bare = token.replace(/^[+-]/, '')
    if (bare === 'inf') return sign * Infinity
    if (bare === 'nan') return NaN
    if (/^0x[0-9a-f]+$/i.test(bare)) return sign * parseInt(bare.slice(2), 16)
    if (/^0o[0-7]+$/.test(bare)) return sign * parseInt(bare.slice(2), 8)
    if (/^0b[01]+$/.test(bare)) return sign * parseInt(bare.slice(2), 2)
    if (/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(bare)) return sign * Number(bare)
    return this.fail(`${token} is not a value`)
  }

  private escape(): string {
    const char = this.text[this.i + 1]
    if (char === 'u' || char === 'U') {
      const size = char === 'u' ? 4 : 8
      const hex = this.text.slice(this.i + 2, this.i + 2 + size)
      if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex)) this.fail('bad unicode escape')
      this.i += 2 + size
      return String.fromCodePoint(parseInt(hex, 16))
    }
    if (char === 'x') {
      const hex = this.text.slice(this.i + 2, this.i + 4)
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail('bad escape')
      this.i += 4
      return String.fromCharCode(parseInt(hex, 16))
    }
    const value = char === undefined ? undefined : ESCAPES[char]
    if (value === undefined) this.fail('bad escape')
    this.i += 2
    return value
  }

  private basic(): string {
    this.i++
    let out = ''
    for (;;) {
      const char = this.text[this.i]
      if (char === undefined || char === '\n') this.fail('unterminated string')
      if (char === '"') {
        this.i++
        return out
      }
      if (char === '\\') out += this.escape()
      else {
        out += char
        this.i++
      }
    }
  }

  private literal(): string {
    const start = ++this.i
    while (this.text[this.i] !== "'") {
      if (this.i >= this.text.length || this.text[this.i] === '\n') this.fail('unterminated string')
      this.i++
    }
    return this.text.slice(start, this.i++)
  }

  private skipFirstBreak(): void {
    if (this.text[this.i] === '\n') this.i++
    else if (this.text[this.i] === '\r' && this.text[this.i + 1] === '\n') this.i += 2
  }

  private multiBasic(): string {
    this.i += 3
    this.skipFirstBreak()
    let out = ''
    for (;;) {
      if (this.i >= this.text.length) this.fail('unterminated string')
      if (this.text.startsWith('"""', this.i)) {
        // Up to two quotes may end the content right before the closing three.
        let end = this.i + 3
        while (this.text[end] === '"' && end - this.i < 5) end++
        out += '"'.repeat(end - this.i - 3)
        this.i = end
        return out
      }
      const char = this.text[this.i]!
      if (char === '\\') {
        const rest = /^\\[ \t]*\r?\n[\s]*/.exec(this.text.slice(this.i, this.i + 4096))
        if (rest) {
          this.i += rest[0].length
          continue
        }
        out += this.escape()
      } else {
        out += char
        this.i++
      }
    }
  }

  private multiLiteral(): string {
    this.i += 3
    this.skipFirstBreak()
    const end = this.text.indexOf("'''", this.i)
    if (end < 0) this.fail('unterminated string')
    let close = end + 3
    while (this.text[close] === "'" && close - end < 5) close++
    const out = this.text.slice(this.i, close - 3)
    this.i = close
    return out
  }

  private array(): unknown[] {
    this.i++
    const out: unknown[] = []
    for (;;) {
      this.blank()
      if (this.text[this.i] === ']') {
        this.i++
        return out
      }
      out.push(this.value())
      this.blank()
      if (this.text[this.i] === ',') this.i++
      else if (this.text[this.i] !== ']') this.fail('expected , or ]')
    }
  }

  private inlineTable(): TomlTable {
    this.i++
    const table: TomlTable = {}
    for (;;) {
      this.blank()
      if (this.text[this.i] === '}') {
        this.i++
        break
      }
      this.pair(table)
      this.blank()
      if (this.text[this.i] === ',') this.i++
      else if (this.text[this.i] !== '}') this.fail('expected , or }')
    }
    const mark = (value: unknown): void => {
      if (isTable(value)) {
        this.inline.add(value)
        Object.values(value).forEach(mark)
      }
    }
    mark(table)
    return table
  }
}

/** The values of a TOML text and its table headers, in order. */
export function parseToml(text: string): { value: TomlTable; headers: TomlHeader[] } {
  const parser = new Parser(text)
  parser.parse()
  return { value: parser.root, headers: parser.headers }
}

export function tomlKey(key: string): string {
  return BARE.test(key) ? key : tomlString(key)
}

export function tomlString(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

function inlineValue(value: unknown): string {
  if (typeof value === 'string') return tomlString(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf'
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(inlineValue).join(', ')}]`
  if (isTable(value)) {
    const items = Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${inlineValue(v)}`)
    return items.length === 0 ? '{}' : `{ ${items.join(', ')} }`
  }
  throw new TypeError('TOML has no null')
}

/** `table` as a header and its keys, its tables after it as headers of their own. */
function tableText(path: string[], table: TomlTable, eol: string): string {
  const scalars: string[] = []
  const tables: [string, TomlTable][] = []
  for (const [key, value] of Object.entries(table)) {
    if (value === undefined || value === null) continue
    if (isTable(value) && Object.keys(value).length > 0) tables.push([key, value])
    else scalars.push(`${tomlKey(key)} = ${inlineValue(value)}`)
  }
  let out = `[${path.map(tomlKey).join('.')}]${eol}`
  for (const line of scalars) out += line + eol
  for (const [key, value] of tables) out += eol + tableText([...path, key], value, eol)
  return out
}

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n')

/** Adds `[<table>.<name>]` at the end of the file. */
export function addTomlTable(text: string, table: string, name: string, entry: TomlTable): string {
  const eol = eolOf(text)
  let lead = text
  if (lead.trim() === '') lead = ''
  else if (!lead.endsWith('\n')) lead += eol + eol
  else if (!lead.endsWith('\n\n') && !lead.endsWith('\n\r\n')) lead += eol
  return lead + tableText([table, name], entry, eol)
}

/**
 * Takes out the headers under `<table>.<name>` and their keys. A comment block right above the
 * next header stays with it. Keys of that server written another way, as dotted keys or an inline
 * table, stay too, which the caller finds by reading the file again.
 */
export function removeTomlTable(text: string, table: string, name: string): string {
  const { headers } = parseToml(text)
  const ranges: [number, number][] = []
  headers.forEach((header, index) => {
    if (header.path.length < 2 || header.path[0] !== table || header.path[1] !== name) return
    const next = headers[index + 1]?.start ?? text.length
    ranges.push([header.start, next === text.length ? next : keptAbove(text, header.start, next)])
  })
  if (ranges.length === 0) return text
  const atEnd = ranges.at(-1)![1] === text.length
  let out = text
  for (const [start, end] of ranges.reverse()) out = out.slice(0, start) + out.slice(end)
  if (out.trim() === '') return ''
  // The file's last table gone, the blank line that set it apart goes too.
  if (atEnd) out = out.replace(/(\r?\n)+$/, eolOf(text))
  return out
}

/** Where the comment lines right above the header at `next` start, so they stay. */
function keptAbove(text: string, from: number, next: number): number {
  let at = next
  for (;;) {
    const lineStart = text.lastIndexOf('\n', at - 2) + 1
    if (lineStart <= from) return at
    const line = text.slice(lineStart, at).trim()
    if (!line.startsWith('#')) return at
    at = lineStart
  }
}
