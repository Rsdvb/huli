// Huli: an exported session's Markdown as a page to print, for its PDF. The Markdown is walked
// with @lezer/markdown, as the document type's Word export does, and every piece of text is
// escaped: raw HTML shows as text, but for the folds the export writes itself and a few plain
// inline tags. Links go to http(s) only, and pictures only to the export's own files, so the
// page, which runs no script, reaches nothing outside. Maths is drawn by KaTeX into HTML, by the
// conversation's rules (the renderer's markdown/remark.ts and maths.ts): `$$...$$` in a line, on
// lines of its own for a display, and ```math fences; a single `$` by Pandoc's rule, so prices stay
// text; `\(...\)` and `\[...\]` within a line; a `\[...\]` on lines of its own as a display.

import { GFM, parser, type InlineContext, type MarkdownConfig } from '@lezer/markdown'
import katex from 'katex'
import { EXPORT_IMAGE_NAME } from '@shared/session-export'
// The conversation's own pass, pure text to text, so a `\[...\]` display reads the same here.
import { fenceBracketMath } from '../../renderer/src/features/session/markdown/maths'

const DOLLAR = 36
const BACKSLASH = 92
const BACKTICK = 96
const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13
const isDigit = (code: number): boolean => code >= 48 && code <= 57

/** `$$...$$`, the conversation's maths (remark-math without its single dollar). */
const MathSyntax: MarkdownConfig = {
  defineNodes: ['InlineMath', 'MathMark'],
  parseInline: [
    {
      name: 'InlineMath',
      before: 'InlineCode',
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== DOLLAR || cx.char(pos + 1) !== DOLLAR || cx.char(pos + 2) === DOLLAR) {
          return -1
        }
        const close = cx.slice(pos + 2, cx.end).indexOf('$$')
        if (close <= 0) return -1
        const end = pos + 2 + close
        return cx.addElement(
          cx.elt('InlineMath', pos, end + 2, [
            cx.elt('MathMark', pos, pos + 2),
            cx.elt('MathMark', end, end + 2),
          ]),
        )
      },
    },
    {
      // `$tex$` by Pandoc's rule, as the conversation reads it: the opening `$` before a non-space,
      // the closing one after a non-space and before no digit, and no code span in between.
      name: 'SingleMath',
      before: 'InlineCode',
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== DOLLAR) return -1
        const first = cx.char(pos + 1)
        if (first === DOLLAR || first === BACKTICK || first < 0 || isSpace(first)) return -1
        let afterSpace = false
        for (let i = pos + 1; i < cx.end; i++) {
          const code = cx.char(i)
          if (code === BACKTICK) return -1
          if (code === BACKSLASH) {
            const escaped = cx.char(i + 1)
            if (escaped === BACKTICK) return -1
            afterSpace = false
            if (escaped !== 10 && escaped !== 13) i++
            continue
          }
          if (code === DOLLAR) {
            if (afterSpace || isDigit(cx.char(i + 1))) return -1
            return cx.addElement(
              cx.elt('InlineMath', pos, i + 1, [
                cx.elt('MathMark', pos, pos + 1),
                cx.elt('MathMark', i, i + 1),
              ]),
            )
          }
          // A line may not start with the `$` that would close it.
          if (code === 10 && cx.char(i + 1) === DOLLAR) return -1
          afterSpace = isSpace(code)
        }
        return -1
      },
    },
    {
      // `\(tex\)` or `\[tex\]` within a line, read before `\(` would be an escaped parenthesis.
      name: 'BracketMath',
      before: 'Escape',
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== BACKSLASH) return -1
        const opener = cx.char(pos + 1)
        if (opener !== 40 && opener !== 91) return -1
        const closer = opener === 40 ? 41 : 93
        let empty = true
        for (let i = pos + 2; i < cx.end; i++) {
          const code = cx.char(i)
          if (code === BACKTICK) return -1
          if (code === 10 || code === 13) continue
          if (code === BACKSLASH) {
            const after = cx.char(i + 1)
            if (after === closer) {
              if (empty) return -1
              return cx.addElement(
                cx.elt('InlineMath', pos, i + 2, [
                  cx.elt('MathMark', pos, pos + 2),
                  cx.elt('MathMark', i, i + 2),
                ]),
              )
            }
            // Not the end: the backslash and what it escapes are part of the formula.
            empty = false
            if (after !== BACKTICK && after !== 10 && after !== 13 && after >= 0) i++
            continue
          }
          empty = false
        }
        return -1
      },
    },
  ],
}

const markdown = parser.configure([GFM, MathSyntax])
type SyntaxNode = ReturnType<typeof markdown.parse>['topNode']

// As the conversation draws maths (the renderer's markdown/tex.ts): nothing that reaches outside
// the formula, such as `\href`, and no size or expansion that grows without bound. HTML alone,
// so the PDF's text carries no hidden MathML copy of each formula.
const TEX_OPTIONS = {
  throwOnError: true,
  trust: false,
  strict: 'ignore',
  output: 'html',
  maxSize: 20,
  maxExpand: 1000,
} as const

// A formula's marks on lines of their own, which set it apart as a display.
const OPENS_LINE = /^[ \t]*\n/
const CLOSES_LINE = /\n[ \t]*$/

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

/**
 * How a page shows the export: printed, its folds as boxes and its pictures the files beside it,
 * or Huli: as one web page, its folds closed and its pictures held in it, by name.
 */
export type PageMode = { kind: 'print' } | { kind: 'web'; images: Readonly<Record<string, string>> }

const PRINT: PageMode = { kind: 'print' }

class Renderer {
  private openFolds = 0
  /** Whether a formula was drawn, so the page needs KaTeX's styles. */
  math = false

  constructor(
    private readonly text: string,
    private readonly mode: PageMode = PRINT,
  ) {}

  /** A picture's source: one of the export's own files, or in a web page the data it holds. */
  private imageSource(target: string): string | null {
    const name = safeImage(target)
    if (!name || this.mode.kind === 'print') return name
    const data = this.mode.images[name]
    return data && /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=]+$/.test(data)
      ? data
      : null
  }

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
      case 'MathMark':
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
          const source = this.imageSource(target)
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
      case 'InlineMath': {
        // The source between the marks, a quote's marks on its lines left out. Only `$$` on lines
        // of their own make a display; a `\[...\]` on lines of its own was made one before parsing.
        const parts = children(node)
        const open = parts[0]!
        const close = parts.at(-1)!
        let tex = ''
        let at = open.to
        for (const child of parts.slice(1, -1)) {
          tex += this.slice(at, child.from)
          at = child.to
        }
        tex += this.slice(at, close.from)
        const fenced = this.slice(open.from, open.to) === '$$'
        return this.tex(tex, fenced && OPENS_LINE.test(tex) && CLOSES_LINE.test(tex))
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
    if (language === 'math') return `<div class="math">${this.tex(text, true)}</div>\n`
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

  /** KaTeX's drawing of a formula, or its source as code where KaTeX cannot read it. */
  private tex(source: string, display: boolean): string {
    const tex = source.trim()
    try {
      const html = katex.renderToString(tex, { ...TEX_OPTIONS, displayMode: display })
      this.math = true
      return html
    } catch {
      return display ? `<pre><code>${escape(tex)}</code></pre>` : `<code>${escape(tex)}</code>`
    }
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
      const web = this.mode.kind === 'web'
      if (/^<details(?:\s+open)?>$/i.test(trimmed)) {
        this.openFolds++
        out += web ? '<details class="fold">' : '<div class="fold">'
        continue
      }
      const summary = /^<summary>(.*)<\/summary>$/i.exec(trimmed)
      if (summary) {
        const text = decodeEntities(summary[1]!.replace(/<[^>]*>/g, ''))
        out += web
          ? `<summary class="fold-title">${escape(text)}</summary>`
          : `<div class="fold-title">${escape(text)}</div>`
        continue
      }
      if (/^<\/details>$/i.test(trimmed)) {
        if (this.openFolds > 0) {
          this.openFolds--
          out += web ? '</details>\n' : '</div>\n'
        }
        continue
      }
      out += `<p class="raw">${escape(line)}</p>\n`
    }
    return out
  }

  render(): string {
    const body = this.blocks(markdown.parse(this.text).topNode)
    return body + (this.mode.kind === 'web' ? '</details>' : '</div>').repeat(this.openFolds)
  }
}

/** The Markdown's body as HTML, and whether it draws a formula. */
export function renderMarkdown(
  text: string,
  mode: PageMode = PRINT,
): { html: string; math: boolean } {
  const renderer = new Renderer(fenceBracketMath(text, false), mode)
  const html = renderer.render()
  return { html, math: renderer.math }
}

/** The Markdown's body as HTML. */
export function markdownHtml(text: string): string {
  return renderMarkdown(text).html
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
.katex-display, div.math { break-inside: avoid; }
div.math > .katex-display { margin: 0 0 8pt; }
`

// Huli: the web page's own rules over the print's: a column to read in, the folds that open, and
// dark colors when the reader's system is dark.
const WEB_STYLE = `
html { color-scheme: light dark; }
body { max-width: 860px; margin: 0 auto; padding: 32px 24px 64px; font-size: 15px; }
code, pre { font-size: 13px; }
details.fold > summary { cursor: pointer; margin-bottom: 0; list-style-position: inside; }
details.fold[open] > summary { margin-bottom: 6px; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #e6edf3; }
  h2, hr { border-color: #30363d; }
  a { color: #58a6ff; }
  code { background: #1f242c; }
  pre, .fold { background: #161b22; border-color: #30363d; }
  th { background: #161b22; }
  th, td { border-color: #30363d; }
  blockquote { border-color: #3d444d; color: #9198a1; }
  .fold-title, .d-file, p.raw { color: #9198a1; }
  .d-add { background: #12261e; color: #3fb950; }
  .d-del { background: #2d1214; color: #f85149; }
  .d-hunk { color: #a371f7; }
  img { border-color: #30363d; }
}
`

/**
 * A whole page: the body, its title, and a stylesheet in light colors, with KaTeX's styles and
 * fonts (`mathStyle`) when it draws a formula. Huli: a web page holds its pictures and opens its
 * folds by a click, and reads in the reader's own colors; it runs no script either way.
 */
export function exportPage(
  title: string,
  markdownText: string,
  mathStyle: () => string = () => '',
  mode: PageMode = PRINT,
): string {
  const body = renderMarkdown(markdownText, mode)
  const math = body.math ? `<style>${mathStyle()}</style>\n` : ''
  const web = mode.kind === 'web'
  const images = web ? 'data:' : 'file: data:'
  return `<!doctype html>
<html lang="und">
<head>
<meta charset="utf-8">
${web ? '<meta name="viewport" content="width=device-width, initial-scale=1">\n' : ''}<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; font-src data:">
<title>${escape(title)}</title>
<style>${STYLE}${web ? WEB_STYLE : ''}</style>
${math}</head>
<body>
${body.html}
</body>
</html>
`
}
