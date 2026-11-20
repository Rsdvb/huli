// Huli: a tool's text result as Markdown that shows it as the tool wrote it. Read as Markdown, JSON
// loses its indentation, a log its line breaks, and a list of links runs together on one line.

/** Past this a JSON result is fenced as it came, not parsed and indented again. */
const PRETTY_LIMIT = 256 * 1024

/** `body` in a fence longer than any run of backticks it holds, so it shows as written. */
function fence(body: string, info = ''): string {
  let longest = 2
  for (const match of body.matchAll(/`{3,}/g)) longest = Math.max(longest, match[0].length)
  const marks = '`'.repeat(longest + 1)
  return `${marks}${info}\n${body.replace(/\n+$/, '')}\n${marks}`
}

// What only Markdown has: headings, lists, quotes, fences, tables, emphasis, links and code spans.
const MARKDOWN = [
  /^#{1,6}\s+\S/m,
  /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+\S/m,
  /^\s{0,3}>/m,
  /^\s{0,3}(?:```|~~~)/m,
  /^\s*\|.*\|\s*$/m,
  /\*\*[^*\n]+\*\*|__[^_\n]+__/,
  /\[[^\]\n]+\]\([^)\s]+\)/,
  /`[^`\n]+`/,
]

const URL_LINE = /^<?https?:\/\/\S+>?$/

function json(text: string): string | null {
  if (!/^[[{]/.test(text) || !/[\]}]$/.test(text)) return null
  if (text.length > PRETTY_LIMIT) return fence(text, 'json')
  try {
    return fence(JSON.stringify(JSON.parse(text), null, 2), 'json')
  } catch {
    return null
  }
}

/**
 * A tool's text as Markdown: JSON indented in a fence, links one per line as a list, text that
 * reads as Markdown as it is, and other text of more than one line, a log or a listing, in a fence.
 * A single line stays as it is.
 */
export function resultMarkdown(raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  const parsed = json(text)
  if (parsed !== null) return parsed
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length >= 2 && lines.every((line) => URL_LINE.test(line.trim()))) {
    return lines.map((line) => `- <${line.trim().replace(/^<|>$/g, '')}>`).join('\n')
  }
  if (MARKDOWN.some((pattern) => pattern.test(text))) return text
  // Lines that follow each other with no blank line between run together as Markdown.
  return /\S[^\S\n]*\n[^\S\n]*\S/.test(text) ? fence(text) : text
}
