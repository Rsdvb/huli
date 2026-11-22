// Huli: the bridge's Markdown as each platform shows it. Replies are the agent's own Markdown; the
// bridge's lines escape what would start Markdown with a backslash. Telegram gets its HTML (code
// blocks as `<pre><code>`), Feishu's cards and DingTalk's and WeCom's Markdown get it nearly as it
// is, and QQ, which shows no Markdown to a bot without approval, gets plain text.

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/

interface Block {
  code: boolean
  lang: string
  text: string
}

/** The text as runs of prose and of fenced code. */
function blocks(markdown: string): Block[] {
  const out: Block[] = []
  let prose: string[] = []
  let code: { marker: string; lang: string; lines: string[] } | null = null
  const flush = () => {
    if (prose.length) out.push({ code: false, lang: '', text: prose.join('\n') })
    prose = []
  }
  for (const line of markdown.split('\n')) {
    const match = FENCE.exec(line)
    if (code) {
      if (match && match[1]![0] === code.marker[0] && match[1]!.length >= code.marker.length) {
        out.push({ code: true, lang: code.lang, text: code.lines.join('\n') })
        code = null
      } else code.lines.push(line)
      continue
    }
    if (match) {
      flush()
      code = { marker: match[1]!, lang: match[2] ?? '', lines: [] }
      continue
    }
    prose.push(line)
  }
  if (code) out.push({ code: true, lang: code.lang, text: code.lines.join('\n') })
  flush()
  return out
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Inline Markdown of one line or paragraph: escapes, code spans, emphasis and links. */
function inline(
  text: string,
  out: {
    text(value: string): string
    code(value: string): string
    bold(value: string): string
    italic(value: string): string
    strike(value: string): string
    link(label: string, url: string): string
  },
): string {
  let result = ''
  let i = 0
  const rest = (from: number) => text.slice(from)
  while (i < text.length) {
    const char = text[i]!
    if (char === '\\' && i + 1 < text.length && /[\\`*_[\]~#>()!-]/.test(text[i + 1]!)) {
      result += out.text(text[i + 1]!)
      i += 2
      continue
    }
    if (char === '`') {
      const run = /^`+/.exec(rest(i))![0]
      const end = text.indexOf(run, i + run.length)
      if (end > i) {
        result += out.code(
          text.slice(i + run.length, end).trim() || text.slice(i + run.length, end),
        )
        i = end + run.length
        continue
      }
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/.exec(rest(i))
    if (strong && (strong[1] === '**' || !/\w/.test(text[i - 1] ?? ''))) {
      result += out.bold(inline(strong[2]!, out))
      i += strong[0].length
      continue
    }
    const strike = /^~~(?=\S)([\s\S]+?)(?<=\S)~~/.exec(rest(i))
    if (strike) {
      result += out.strike(inline(strike[1]!, out))
      i += strike[0].length
      continue
    }
    const em = /^([*_])(?=\S)([\s\S]+?)(?<=\S)\1(?!\w)/.exec(rest(i))
    if (em && (em[1] === '*' || !/\w/.test(text[i - 1] ?? ''))) {
      result += out.italic(inline(em[2]!, out))
      i += em[0].length
      continue
    }
    const link = /^!?\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/.exec(rest(i))
    if (link) {
      result += out.link(link[1]! || link[2]!, link[2]!)
      i += link[0].length
      continue
    }
    result += out.text(char)
    i++
  }
  return result
}

/** Telegram's HTML: the tags it takes, everything else escaped. */
export function toTelegramHtml(markdown: string): string {
  const html = {
    text: escapeHtml,
    code: (value: string) => `<code>${escapeHtml(value)}</code>`,
    bold: (value: string) => `<b>${value}</b>`,
    italic: (value: string) => `<i>${value}</i>`,
    strike: (value: string) => `<s>${value}</s>`,
    link: (label: string, url: string) =>
      `<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${escapeHtml(label)}</a>`,
  }
  return blocks(markdown)
    .map((block) => {
      if (block.code) {
        const lang = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : ''
        return `<pre><code${lang}>${escapeHtml(block.text)}</code></pre>`
      }
      return block.text
        .split('\n')
        .map((line) => {
          const heading = /^ {0,3}#{1,6}\s+(.*)$/.exec(line)
          if (heading) return `<b>${inline(heading[1]!, html)}</b>`
          const quote = /^ {0,3}>\s?(.*)$/.exec(line)
          if (quote) return `<blockquote>${inline(quote[1]!, html)}</blockquote>`
          return inline(line, html)
        })
        .join('\n')
    })
    .join('\n')
}

/** Plain text: the words without Markdown's marks, code as it is. */
export function toPlainText(markdown: string): string {
  const text = {
    text: (value: string) => value,
    code: (value: string) => value,
    bold: (value: string) => value,
    italic: (value: string) => value,
    strike: (value: string) => value,
    link: (label: string, url: string) => (label === url ? url : `${label} (${url})`),
  }
  return blocks(markdown)
    .map((block) =>
      block.code
        ? block.text
        : block.text
            .split('\n')
            .map((line) => inline(line.replace(/^ {0,3}#{1,6}\s+/, ''), text))
            .join('\n'),
    )
    .join('\n')
}

/**
 * Markdown for a platform that renders most of it: the bridge's backslash escapes as HTML
 * entities, which Feishu's cards take, or as the bare character for one that takes neither.
 */
export function withoutEscapes(markdown: string, entities: boolean): string {
  return blocks(markdown)
    .map((block) =>
      block.code
        ? `\`\`\`${block.lang}\n${block.text}\n\`\`\``
        : block.text.replace(/\\([\\`*_[\]~#>()!-])/g, (_, char: string) =>
            entities ? `&#${char.charCodeAt(0)};` : char,
          ),
    )
    .join('\n')
}
