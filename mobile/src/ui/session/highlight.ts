// A cheap highlighter for code blocks: comments, strings, numbers, keywords and capitalized names,
// found by one regular expression per language family. Not a parser; good enough to read by.

export type TokenKind = 'keyword' | 'string' | 'comment' | 'number' | 'type' | 'plain'

export interface Token {
  kind: TokenKind
  text: string
}

const C_LIKE =
  'abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|from|func|function|go|if|implements|import|in|instanceof|interface|let|match|mod|mut|new|nil|null|of|package|private|protected|pub|public|readonly|return|static|struct|super|switch|this|throw|true|try|type|typeof|undefined|use|var|void|while|yield|fn|impl|trait|where|self|Self|defer|chan|select|range|map|int|string|bool|float|double|char|long|unsigned|auto|namespace|template|virtual|override|final|val|fun|when|guard|let|var|protocol|extension|init'
const PYTHON =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield|self|print'
const SHELL =
  'if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|exit|export|local|readonly|set|unset|echo|cd|source|sudo|true|false|param|foreach|Write-Host|Get-ChildItem'
const SQL =
  'select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|drop|alter|join|left|right|inner|outer|on|group|by|order|having|limit|as|null|is|in|distinct|union|primary|key|index'

interface Family {
  comment: string
  keywords: string
  caseless?: boolean
}

const FAMILIES: Record<string, Family> = {
  c: { comment: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', keywords: C_LIKE },
  py: { comment: '#[^\\n]*', keywords: PYTHON },
  sh: { comment: '#[^\\n]*', keywords: SHELL },
  sql: { comment: '--[^\\n]*', keywords: SQL, caseless: true },
  data: { comment: '#[^\\n]*|\\/\\/[^\\n]*', keywords: 'true|false|null|yes|no|on|off' },
}

const LANGUAGES: Record<string, keyof typeof FAMILIES> = {
  js: 'c',
  jsx: 'c',
  javascript: 'c',
  mjs: 'c',
  cjs: 'c',
  ts: 'c',
  tsx: 'c',
  typescript: 'c',
  java: 'c',
  kotlin: 'c',
  kt: 'c',
  swift: 'c',
  go: 'c',
  golang: 'c',
  rust: 'c',
  rs: 'c',
  c: 'c',
  cpp: 'c',
  'c++': 'c',
  h: 'c',
  cs: 'c',
  csharp: 'c',
  dart: 'c',
  php: 'c',
  scala: 'c',
  py: 'py',
  python: 'py',
  rb: 'py',
  ruby: 'py',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  shell: 'sh',
  console: 'sh',
  powershell: 'sh',
  ps1: 'sh',
  pwsh: 'sh',
  sql: 'sql',
  json: 'data',
  jsonc: 'data',
  yaml: 'data',
  yml: 'data',
  toml: 'data',
  ini: 'data',
}

const cache = new Map<string, RegExp>()

function patternFor(key: keyof typeof FAMILIES): RegExp {
  const known = cache.get(key)
  if (known) return known
  const family = FAMILIES[key]!
  const source = [
    `(${family.comment})`,
    '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)',
    '(\\b(?:0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b)',
    `(\\b(?:${family.keywords})\\b)`,
    '(\\b[A-Z][A-Za-z0-9_]*\\b)',
  ].join('|')
  const made = new RegExp(source, family.caseless ? 'gi' : 'g')
  cache.set(key, made)
  return made
}

/** Tokens of `code` in `language`, or null for a language it does not know. */
// Blocks highlighted already, by language and text: a row the list mounts again as it scrolls back
// into view draws its colors at once rather than working them out again. The oldest go first.
const KEPT = 120
const kept = new Map<string, Token[] | null>()

export function highlight(code: string, language: string): Token[] | null {
  const id = `${language}\n${code}`
  const known = kept.get(id)
  if (known !== undefined) {
    kept.delete(id)
    kept.set(id, known)
    return known
  }
  const tokens = tokensOf(code, language)
  kept.set(id, tokens)
  if (kept.size > KEPT) kept.delete(kept.keys().next().value!)
  return tokens
}

function tokensOf(code: string, language: string): Token[] | null {
  const key = LANGUAGES[language.toLowerCase()]
  if (!key || code.length > 20_000) return null
  const pattern = patternFor(key)
  pattern.lastIndex = 0
  const tokens: Token[] = []
  let last = 0
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    if (match[0] === '') {
      pattern.lastIndex++
      continue
    }
    if (match.index > last) tokens.push({ kind: 'plain', text: code.slice(last, match.index) })
    const kind: TokenKind = match[1]
      ? 'comment'
      : match[2]
        ? 'string'
        : match[3]
          ? 'number'
          : match[4]
            ? 'keyword'
            : 'type'
    tokens.push({ kind, text: match[0] })
    last = match.index + match[0].length
  }
  if (last < code.length) tokens.push({ kind: 'plain', text: code.slice(last) })
  return tokens
}
