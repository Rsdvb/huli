// Huli: an exported session's Markdown as a page to print, for its PDF. The Markdown is walked
// with @lezer/markdown, as the document type's Word export does, and every piece of text is
// escaped: raw HTML shows as text, but for the folds the export writes itself and a few plain
// inline tags. Links go to http(s) only, and pictures only to the export's own files, so the
// page, which runs no script, reaches nothing outside.

import { GFM, parser } from '@lezer/markdown'
import { EXPORT_IMAGE_NAME } from '@shared/session-export'

const markdown = parser.configure(GFM)
type SyntaxNode = ReturnType<typeof markdown.parse>['topNode']

// Inline tags kept as tags when they carry no attributes; others show as text.
const INLINE_TAGS = new Set([
  'b',
  'i',
  'em',
  'strong',
  'u',
  's',
  'del',
  'kbd',
  'sub',
  'sup',
  'code',
])

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child)
  return out
}

/** A link's address when it may be one: http(s) only. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

/** A picture's source when it is one of the export's own files, which lie beside the page. */
function safeImage(url: string): string | null {
  const name = decodeURIComponent(url.replace(/^\.\//, ''))
  return EXPORT_IMAGE_NAME.test(name) ? name : null
}

class Renderer {
  private openFolds = 0

  constructor(private readonly text: string) {}

  private slice(from: number, to: number): string {
    return this.text.slice(from, to)
  }

  /** The inline content of `node` between `from` and `to`, its marks left out. */
  private inline(node: SyntaxNode, from = node.from, to = node.to): string {
    let out = ''
    let at = from
    for (const child of children(node)) {
      if (child.to <= from || child.from >= to) continue
      out += escape(this.slice(at, Math.max(at, child.from)))
      out += this.inlineNode(child)
      at = Math.max(at, child.to)
    }
    return out + escape(this.slice(at, to))
  }

  private inlineNode(node: SyntaxNode): string {
    switch (node.name) {
      case 'EmphasisMark':
      case 'CodeMark':
      case 'LinkMark':
      case 'StrikethroughMark':
      case 'QuoteMark':
      case 'HeaderMark':
      case 'ListMark':
      case 'TableDelimiter':
      case 'Comment':
      case 'ProcessingInstruction':
        return ''
      case 'Emphasis':
        return `<em>${this.inline(node)}</em>`
      case 'StrongEmphasis':
        return `<strong>${this.inline(node)}</strong>`
      case 'Strikethrough':
        return `<del>${this.inline(node)}</del>`
      case 'InlineCode': {
        const marks = children(node).filter((child) => child.name === 'CodeMark')
        const from = marks[0]?.to ?? node.from
        const to = marks[1]?.from ?? node.to
        let code = this.slice(from, to).replace(/\n/g, ' ')
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1)
        return `<code>${escape(code)}</code>`
      }
      case 'Link':
      case 'Image': {
        const marks = children(node).filter((child) => child.name === 'LinkMark')
        const label = marks.length >= 2 ? this.inline(node, marks[0]!.to, marks[1]!.from) : ''
        const url = node.getChild('URL')
        const target = url ? this.slice(url.from, url.to).replace(/^<|>$/g, '') : ''
        if (node.name === 'Image') {
          const source = safeImage(target)
          return source
            ? `<img src="${escape(source)}" alt="${label.replace(/<[^>]*>/g, '')}">`
            : `<em>[${label}]</em>`
        }
        const href = safeHref(target)
        return href ? `<a href="${escape(href)}">${label || escape(target)}</a>` : label
      }
      case 'URL':
      case 'Autolink': {
        const url = node.name === 'URL' ? node : node.getChild('URL')
        const target = url ? this.slice(url.from, url.to) : this.slice(node.from, node.to)
        const href = safeHref(target)
        return href ? `<a href="${escape(href)}">${escape(target)}</a>` : escape(target)
      }
      case 'Escape':
        return escape(this.slice(node.from + 1, node.to))
      case 'Entity':
        return escape(decodeEntities(this.slice(node.from, node.to)))
      case 'HardBreak':
        return '<br>'
      case 'HTMLTag': {
        const tag = this.slice(node.from, node.to)
        const match = /^<(\/?)([a-z]+)\s*(\/?)>$/i.exec(tag)
        const name = match?.[2]?.toLowerCase()
        if (name === 'br') return '<br>'
        if (match && name && INLINE_TAGS.has(name) && !match[3]) return `<${match[1]}${name}>`
        return escape(tag)
      }
      case 'TaskMarker': {
        const done = /x/i.test(this.slice(node.from, node.to))
        return `<span class="task">${done ? '☑' : '☐'}</span> `
      }
      default:
        return this.inline(node)
    }
  }

  private blocks(node: SyntaxNode): string {
    return children(node)
      .map((child) => this.block(child))
      .join('')
  }

  private block(node: SyntaxNode): string {
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name)
    if (heading) {
      const level = heading[1]
      return `<h${level}>${this.inline(node).trim()}</h${level}>\n`
    }
    switch (node.name) {
      case 'Paragraph':
        return `<p>${this.inline(node).trim()}</p>\n`
      case 'Blockquote':
        return `<blockquote>${this.blocks(node)}</blockquote>\n`
      case 'BulletList':
        return `<ul>${this.blocks(node)}</ul>\n`
      case 'OrderedList': {
        const mark = node.getChild('ListItem')?.getChild('ListMark')
        const start = mark ? parseInt(this.slice(mark.from, mark.to), 10) : 1
        return `<ol${start !== 1 && Number.isFinite(start) ? ` start="${start}"` : ''}>${this.blocks(node)}</ol>\n`
      }
      case 'ListItem':
        return `<li>${this.blocks(node)}</li>`
      case 'Task':
        return `<p class="task-line">${this.inline(node).trim()}</p>`
      case 'FencedCode':
      case 'CodeBlock':
        return this.code(node)
      case 'HorizontalRule':
        return '<hr>\n'
      case 'Table':
        return this.table(node)
      case 'HTMLBlock':
        return this.html(this.slice(node.from, node.to))
      case 'ListMark':
      case 'QuoteMark':
      case 'LinkReference':
      case 'CommentBlock':
      case 'ProcessingInstructionBlock':
        return ''
      default:
        return `<p>${this.inline(node).trim()}</p>\n`
    }
  }

  private code(node: SyntaxNode): string {
    const info = node.getChild('CodeInfo')
    const language = info ? this.slice(info.from, info.to).trim().split(/\s/)[0]!.toLowerCase() : ''
    // Each line's text ends with its line break; a list's or a quote's marks lie between them.
    const text = children(node)
      .filter((child) => child.name === 'CodeText')
      .map((child) => this.slice(child.from, child.to))
      .join('')
      .replace(/\n$/, '')
    if (language === 'diff') {
      const lines = text.split('\n').map((line) => {
        const kind = line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('+++') || line.startsWith('---')
            ? 'file'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : 'same'
        return `<span class="d-${kind}">${escape(line) || ' '}</span>`
      })
      // Each line is a block of its own, which ends its line.
      return `<pre class="diff"><code>${lines.join('')}</code></pre>\n`
    }
    return `<pre><code>${escape(text)}</code></pre>\n`
  }

  private table(node: SyntaxNode): string {
    const row = (part: SyntaxNode, cell: 'th' | 'td'): string =>
      `<tr>${children(part)
        .filter((child) => child.name === 'TableCell')
        .map((child) => `<${cell}>${this.inline(child).trim()}</${cell}>`)
        .join('')}</tr>`
    const header = node.getChild('TableHeader')
    const rows = children(node).filter((child) => child.name === 'TableRow')
    return `<table>${header ? `<thead>${row(header, 'th')}</thead>` : ''}<tbody>${rows
      .map((part) => row(part, 'td'))
      .join('')}</tbody></table>\n`
  }

  /** The export's folds become boxes; any other raw HTML shows as its text. */
  private html(source: string): string {
    let out = ''
    for (const line of source.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (/^<details(?:\s+open)?>$/i.test(trimmed)) {
        this.openFolds++
        out += '<div class="fold">'
        continue
      }
      const summary = /^<summary>(.*)<\/summary>$/i.exec(trimmed)
      if (summary) {
        const text = decodeEntities(summary[1]!.replace(/<[^>]*>/g, ''))
        out += `<div class="fold-title">${escape(text)}</div>`
        continue
      }
      if (/^<\/details>$/i.test(trimmed)) {
        if (this.openFolds > 0) {
          this.openFolds--
          out += '</div>\n'
        }
        continue
      }
      out += `<p class="raw">${escape(line)}</p>\n`
    }
    return out
  }

  render(): string {
    const body = this.blocks(markdown.parse(this.text).topNode)
    return body + '</div>'.repeat(this.openFolds)
  }
}

/** The Markdown's body as HTML. */
export function markdownHtml(text: string): string {
  return new Renderer(text).render()
}

const STYLE = `
@page { size: A4; margin: 16mm 15mm 18mm; }
* { box-sizing: border-box; }
html { color-scheme: light; }
body { margin: 0; background: #fff; color: #1f2328; font: 10.5pt/1.55 "Segoe UI", -apple-system,
  "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans", sans-serif;
  overflow-wrap: anywhere; }
h1 { font-size: 20pt; line-height: 1.25; margin: 0 0 8pt; }
h2 { font-size: 13.5pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 0.5pt solid #d8dee4; }
h3 { font-size: 12pt; margin: 14pt 0 5pt; }
h4, h5, h6 { font-size: 11pt; margin: 12pt 0 4pt; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; }
p { margin: 0 0 7pt; }
ul, ol { margin: 0 0 7pt; padding-left: 18pt; }
li > p { margin: 0 0 2pt; }
li { margin: 1pt 0; }
hr { border: 0; border-top: 0.5pt solid #d8dee4; margin: 12pt 0; }
a { color: #0969da; text-decoration: none; }
code { font: 9pt/1.45 "Cascadia Code", Consolas, "SFMono-Regular", Menlo, monospace;
  background: #f3f4f6; border-radius: 3pt; padding: 0.5pt 3pt; }
pre { margin: 0 0 8pt; padding: 7pt 9pt; background: #f6f8fa; border: 0.5pt solid #e1e4e8;
  border-radius: 5pt; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 8.5pt/1.45 "Cascadia Code", Consolas, "SFMono-Regular", Menlo, monospace; }
pre code { background: none; padding: 0; border-radius: 0; font: inherit; }
pre.diff code span { display: block; margin: 0 -9pt; padding: 0 9pt; }
.d-add { background: #e6ffec; color: #116329; }
.d-del { background: #ffebe9; color: #82071e; }
.d-hunk { color: #6639ba; }
.d-file { color: #57606a; font-weight: 600; }
blockquote { margin: 0 0 8pt; padding: 1pt 0 1pt 10pt; border-left: 2.5pt solid #d0d7de; color: #424a53; }
blockquote > :last-child { margin-bottom: 0; }
table { border-collapse: collapse; margin: 0 0 8pt; font-size: 9.5pt; }
th, td { border: 0.5pt solid #d0d7de; padding: 3pt 6pt; text-align: left; vertical-align: top; }
th { background: #f6f8fa; }
img { max-width: 100%; max-height: 220mm; border: 0.5pt solid #e1e4e8; border-radius: 4pt;
  break-inside: avoid; display: block; margin: 4pt 0 8pt; }
.fold { margin: 0 0 8pt; padding: 6pt 9pt 2pt; border: 0.5pt solid #e1e4e8; border-radius: 5pt;
  background: #fbfbfc; }
.fold-title { font-weight: 600; font-size: 9.5pt; color: #57606a; margin-bottom: 5pt; }
.task { font-family: "Segoe UI Symbol", sans-serif; }
p.raw { font: 9pt/1.45 "Cascadia Code", Consolas, monospace; color: #57606a; }
`

/** A whole page to print: the body, its title, and a stylesheet in light colors. */
export function exportPage(title: string, markdownText: string): string {
  return `<!doctype html>
<html lang="und">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${markdownHtml(markdownText)}
</body>
</html>
`
}
