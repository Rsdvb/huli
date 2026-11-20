// Huli: a session as Markdown, for Export… in a session's menu. Pure: the renderer reads the
// thread and its pictures, then main masks secrets the way the logs do and writes the files
// (src/main/session-export/). Pictures are named here and linked as `EXPORT_ASSET` + name, which
// main points at the folder they land in.

import type { ContentRef, ThreadEntry, ToolEntry, UserContent } from './thread'

/** What a picture's link starts with until main knows the folder it goes in. */
export const EXPORT_ASSET = 'kite-export-asset:'

/** An exported picture's name: `image-001.png`. */
export const EXPORT_IMAGE_NAME = /^image-\d{3,5}\.(?:png|jpg|gif|webp|avif|bmp|svg)$/

export const EXPORT_FORMATS = ['md', 'zip', 'pdf'] as const
/** Markdown with its pictures in a folder beside it, the same in a zip, or a PDF. */
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** What the page hands main to save: the Markdown and the pictures it links, by name. */
export interface SessionExportRequest {
  format: ExportFormat
  /** The session's title, which names the file the save dialog suggests. */
  title: string
  markdown: string
  images: { name: string; data: Uint8Array }[]
}

export interface ExportOptions {
  /** The agent's thinking, folded. */
  thoughts: boolean
  /** Each tool call's whole input and output, folded, beside its one-line summary. */
  tools: boolean
  /** The sub-agents' own threads, after the line that names each. */
  subagents: boolean
}

export type ExportImageSource =
  { kind: 'data'; data: string } | { kind: 'blob'; sessionId: string; hash: string }

export interface ExportImage {
  name: string
  mimeType: string
  source: ExportImageSource
}

export interface ExportSession {
  sessionId: string
  title: string
  /** The agent's name, as the app shows it. */
  agent: string
  model: string | null
  project: string | null
  /** The folder the agent worked in, which the paths it names are shown relative to. */
  root: string | null
  createdAt: number
  updatedAt: number
  entries: readonly ThreadEntry[]
}

/** The copy the export writes, in the user's language. */
export type ExportKey =
  | 'agent'
  | 'model'
  | 'project'
  | 'started'
  | 'updated'
  | 'exported'
  | 'you'
  | 'fromSession'
  | 'thinking'
  | 'details'
  | 'input'
  | 'output'
  | 'status.pending'
  | 'status.in_progress'
  | 'status.completed'
  | 'status.failed'
  | 'status.cancelled'
  | 'denied'
  | 'plan'
  | 'planApproved'
  | 'planDeclined'
  | 'note'
  | 'question'
  | 'answer'
  | 'noAnswer'
  | 'todo'
  | 'subagent'
  | 'compacted'
  | 'attached'
  | 'commit'
  | 'pushed'
  | 'branch'
  | 'pullRequest'
  | 'artifact'
  | 'memory'
  | 'takeover'
  | 'otherSession'
  | 'linesMore'
  | 'image'
  | 'media'

export interface ExportText {
  t(key: ExportKey, values?: Record<string, string | number>): string
  time(ms: number): string
}

const MAX_DIFF_LINES = 400
const MAX_OUTPUT_LINES = 1000
const MAX_SUBAGENT_DEPTH = 3
// A longest common subsequence past this many cells is skipped: the lines show as replaced.
const MAX_LCS_CELLS = 4_000_000

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}

/** Text for an HTML element's content, as `<summary>` takes it. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Text that reads as itself inside Markdown's inline text. */
export function escapeInline(text: string): string {
  return text.replace(/[\\`*_[\]<>#|~]/g, (char) => `\\${char}`)
}

/**
 * A tool's title as inline Markdown: its code spans kept, as titles mark commands and paths with
 * them, and everything else read as itself.
 */
export function inlineTitle(text: string): string {
  return text
    .split(/(`+[^`]*`+)/)
    .map((part, index) => (index % 2 === 1 ? part : escapeInline(part)))
    .join('')
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
// A terminal's control sequences: CSI ones, as colors, and OSC ones, as links and titles.
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g')

/** Text without a terminal's color and cursor codes, which only a terminal reads. */
export function plainText(text: string): string {
  return text.replace(CSI, '').replace(OSC, '')
}

/** A path inside `root` as relative to it, with `/`; any other as it is. */
export function relativePath(path: string, root: string | null): string {
  if (!root) return path
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(root)
  const normal = (value: string): string =>
    windows ? value.replace(/\\/g, '/').toLowerCase() : value
  const base = normal(root).replace(/\/+$/, '')
  if (!normal(path).startsWith(`${base}/`)) return path
  return path.slice(base.length + 1).replace(/\\/g, '/')
}

/** Markdown cut after `max` lines, a code block it cuts through closed again. */
function cutMarkdown(text: string, max: number, more: (count: number) => string): string {
  const lines = text.split('\n')
  if (lines.length <= max) return text
  let fence: string | null = null
  for (const line of lines.slice(0, max)) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (!mark) continue
    if (fence === null) fence = mark
    else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
  }
  const kept = lines.slice(0, max).join('\n')
  return `${kept}${fence ? `\n${fence}` : ''}\n\n${more(lines.length - max)}`
}

/** One line of at most `max` characters. */
function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A fenced block whose fence no backtick run inside it can close. */
export function fenced(text: string, info = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${info}\n${text.replace(/\n$/, '')}\n${fence}`
}

function quoted(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
}

function cut(text: string, max: number, more: (count: number) => string): string {
  const lines = text.split('\n')
  if (lines.length <= max) return text
  return `${lines.slice(0, max).join('\n')}\n${more(lines.length - max)}`
}

function linesOf(text: string): string[] {
  if (text === '') return []
  const all = text.split('\n')
  if (all.at(-1) === '') all.pop()
  return all
}

type DiffLine = { kind: ' ' | '-' | '+'; text: string; old: number; new: number }

/** The change's lines in order: kept, removed and added, numbered in the old and new text. */
function diffLines(before: string[], after: string[]): DiffLine[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++
  }
  const a = before.slice(start, before.length - end)
  const b = after.slice(start, after.length - end)
  const out: DiffLine[] = []
  let oldAt = 1
  let newAt = 1
  const keep = (text: string) => out.push({ kind: ' ', text, old: oldAt++, new: newAt++ })
  const remove = (text: string) => out.push({ kind: '-', text, old: oldAt++, new: newAt })
  const add = (text: string) => out.push({ kind: '+', text, old: oldAt, new: newAt++ })
  before.slice(0, start).forEach(keep)
  if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) {
    a.forEach(remove)
    b.forEach(add)
  } else {
    const width = b.length + 1
    const table = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        keep(a[i]!)
        i++
        j++
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) remove(a[i++]!)
      else add(b[j++]!)
    }
    while (i < a.length) remove(a[i++]!)
    while (j < b.length) add(b[j++]!)
  }
  before.slice(before.length - end).forEach(keep)
  return out
}

/** A unified diff of the change, with three lines of context, and its counts. */
export function unifiedDiff(
  path: string,
  oldText: string | null,
  newText: string,
): { text: string; added: number; removed: number } {
  const lines = diffLines(oldText === null ? [] : linesOf(oldText), linesOf(newText))
  const added = lines.filter((line) => line.kind === '+').length
  const removed = lines.filter((line) => line.kind === '-').length
  const header = [`--- ${oldText === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`]
  const changed = lines.flatMap((line, index) => (line.kind === ' ' ? [] : [index]))
  const hunks: string[] = []
  let at = 0
  while (at < changed.length) {
    const first = Math.max(0, changed[at]! - 3)
    let last = Math.min(lines.length - 1, changed[at]! + 3)
    while (at + 1 < changed.length && changed[at + 1]! - 3 <= last + 1) {
      at++
      last = Math.min(lines.length - 1, changed[at]! + 3)
    }
    at++
    const part = lines.slice(first, last + 1)
    const oldCount = part.filter((line) => line.kind !== '+').length
    const newCount = part.filter((line) => line.kind !== '-').length
    const oldStart = oldCount === 0 ? part[0]!.old - 1 : part.find((l) => l.kind !== '+')!.old
    const newStart = newCount === 0 ? part[0]!.new - 1 : part.find((l) => l.kind !== '-')!.new
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const line of part) hunks.push(`${line.kind}${line.text}`)
  }
  return { text: [...header, ...hunks].join('\n'), added, removed }
}

class Writer {
  private readonly blocks: string[] = []
  private list: string[] = []
  readonly images: ExportImage[] = []
  private readonly named = new Map<string, string>()

  constructor(
    private readonly text: ExportText,
    private readonly options: ExportOptions,
    private readonly children: ReadonlyMap<string, ExportSession>,
  ) {}

  block(markdown: string): void {
    this.flush()
    if (markdown.trim()) this.blocks.push(markdown.trim())
  }

  item(markdown: string): void {
    this.list.push(`- ${markdown}`)
  }

  flush(): void {
    if (this.list.length > 0) this.blocks.push(this.list.join('\n'))
    this.list = []
  }

  done(): string {
    this.flush()
    return `${this.blocks.join('\n\n')}\n`
  }

  /** A folded block: its summary in one line, and what it holds under it. */
  details(summary: string, body: string): void {
    this.block(
      `<details>\n<summary>${escapeHtml(oneLine(summary))}</summary>\n\n${body.trim()}\n\n</details>`,
    )
  }

  /** A picture's link, the picture taken into the export once however often it shows. */
  image(ref: Extract<ContentRef, { kind: 'image' }>, sessionId: string): string {
    const source: ExportImageSource =
      'blob' in ref ? { kind: 'blob', sessionId, hash: ref.blob } : { kind: 'data', data: ref.data }
    const key =
      source.kind === 'blob'
        ? `blob:${source.hash}`
        : `data:${source.data.slice(0, 64)}${source.data.length}`
    let name = this.named.get(key)
    if (!name) {
      const extension = EXTENSIONS[ref.mimeType.toLowerCase()] ?? 'png'
      name = `image-${String(this.images.length + 1).padStart(3, '0')}.${extension}`
      this.named.set(key, name)
      this.images.push({ name, mimeType: ref.mimeType, source })
    }
    return `![${this.text.t('image')}](${EXPORT_ASSET}${name})`
  }

  /** What a message carries beside its text: pictures, links, files and media. */
  refs(refs: readonly ContentRef[], sessionId: string): string[] {
    const out: string[] = []
    for (const ref of refs) {
      switch (ref.kind) {
        case 'image':
          out.push(this.image(ref, sessionId))
          break
        case 'link':
          out.push(
            `[${escapeInline(ref.name || ref.uri)}](<${ref.uri.replace(/[<>\s]/g, encodeURIComponent)}>)`,
          )
          break
        case 'attachment': {
          const { attachment } = ref
          if (attachment.type === 'image' && attachment.blob) {
            out.push(
              this.image(
                {
                  kind: 'image',
                  mimeType: attachment.mimeType ?? 'image/png',
                  blob: attachment.blob,
                },
                sessionId,
              ),
            )
          } else {
            out.push(`*${this.text.t('attached', { name: escapeInline(attachment.name) })}*`)
          }
          break
        }
        case 'audio':
        case 'video':
          out.push(`*${this.text.t('media', { name: escapeInline(ref.name ?? ref.mimeType) })}*`)
          break
        case 'unsupported':
          out.push(`*${escapeInline(ref.label)}*`)
          break
      }
    }
    return out
  }

  userContent(content: readonly UserContent[], sessionId: string): string {
    const parts: string[] = []
    const refs: ContentRef[] = []
    for (const part of content) {
      if (part.type === 'text') parts.push(part.text)
      else refs.push(part.ref)
    }
    return [...parts, ...this.refs(refs, sessionId)].join('\n\n')
  }

  get t(): ExportText['t'] {
    return this.text.t
  }

  get show(): ExportOptions {
    return this.options
  }

  child(sessionId: string): ExportSession | undefined {
    return this.children.get(sessionId)
  }

  time(ms: number): string {
    return this.text.time(ms)
  }
}

function statusText(writer: Writer, entry: ToolEntry): string | null {
  const result = entry.permissionResult
  if (result && typeof result === 'object' && result.kind.startsWith('reject')) {
    return writer.t('denied')
  }
  return entry.status === 'completed' ? null : writer.t(`status.${entry.status}`)
}

function toolMarkdown(writer: Writer, entry: ToolEntry, session: ExportSession): void {
  const { sessionId } = session
  const result =
    entry.permissionResult && typeof entry.permissionResult === 'object'
      ? entry.permissionResult
      : null
  // A plan to approve: the plan itself, and what the user answered.
  if (entry.planVersion !== undefined || entry.permission?.plan) {
    const plan =
      entry.permission?.plan?.markdown ??
      entry.content.flatMap((c) => (c.type === 'markdown' ? [c.markdown] : [])).join('\n\n')
    const answer = result
      ? result.kind.startsWith('allow')
        ? writer.t('planApproved')
        : writer.t('planDeclined')
      : null
    writer.block(
      `**${writer.t('plan', { version: entry.planVersion ?? 1 })}**${answer ? ` · ${answer}` : ''}`,
    )
    if (plan.trim()) writer.block(quoted(plan.trim()))
    if (result?.note) writer.block(`*${writer.t('note')}:* ${escapeInline(result.note)}`)
    return
  }
  // A question to the user, or an MCP server's form, and the answers.
  const questions = result?.questions
  if (questions?.length || entry.question || entry.permission?.questions?.length) {
    const asked = questions?.length
      ? questions
      : (entry.permission?.questions ?? []).map((q) => ({ question: q.question, answered: false }))
    const pairs =
      asked.length > 0
        ? asked
        : [
            {
              question: entry.question ?? entry.title,
              answered: !!result?.name,
              answer: result?.name,
            },
          ]
    for (const pair of pairs) {
      const answer =
        'answer' in pair && pair.answered && pair.answer ? pair.answer : writer.t('noAnswer')
      writer.block(
        `**${writer.t('question')}:** ${escapeInline(pair.question)}\n\n**${writer.t('answer')}:** ${escapeInline(answer)}`,
      )
    }
    if (result?.note) writer.block(`*${writer.t('note')}:* ${escapeInline(result.note)}`)
    return
  }
  if (entry.elicitation) {
    const fields = result?.fields ?? []
    writer.block(
      [
        `**${escapeInline(entry.elicitation.server)}:** ${escapeInline(entry.title)}`,
        ...fields.map((field) => `- ${escapeInline(field.title)}: ${escapeInline(field.value)}`),
      ].join('\n\n'),
    )
    return
  }
  const status = statusText(writer, entry)
  const description = entry.description ? ` — ${escapeInline(oneLine(entry.description))}` : ''
  writer.item(
    `**${inlineTitle(oneLine(entry.title))}**${description}${status ? ` · *${status}*` : ''}`,
  )
  for (const part of entry.content) {
    if (part.type !== 'diff') continue
    const path = relativePath(part.path, session.root)
    const diff = unifiedDiff(path, part.oldText, part.newText)
    writer.block(
      `\`${path.replace(/`/g, '')}\` (+${diff.added} −${diff.removed})\n\n${fenced(
        cut(diff.text, MAX_DIFF_LINES, (count) => `… ${writer.t('linesMore', { count })}`),
        'diff',
      )}`,
    )
  }
  if (!writer.show.tools) return
  const body: string[] = []
  if (entry.rawInput?.trim()) {
    body.push(`**${writer.t('input')}**`, fenced(plainText(entry.rawInput.trim())))
  }
  const outputs = entry.content.flatMap((c) => (c.type === 'markdown' ? [c.markdown] : []))
  if (outputs.length > 0) {
    body.push(
      `**${writer.t('output')}**`,
      cutMarkdown(
        plainText(outputs.join('\n\n')),
        MAX_OUTPUT_LINES,
        (count) => `*… ${writer.t('linesMore', { count })}*`,
      ),
    )
  }
  const pictures = writer.refs(
    entry.content.flatMap((c) => (c.type === 'ref' ? [c.ref] : [])),
    sessionId,
  )
  body.push(...pictures)
  if (body.length > 0)
    writer.details(`${writer.t('details')}: ${oneLine(entry.title, 120)}`, body.join('\n\n'))
}

function entriesMarkdown(
  writer: Writer,
  session: ExportSession,
  level: number,
  depth: number,
): void {
  const heading = '#'.repeat(Math.min(level, 6))
  let speaker: 'user' | 'agent' | null = null
  const speak = (who: 'user' | 'agent', name: string, at?: number) => {
    if (speaker === who) return
    speaker = who
    writer.block(`${heading} ${escapeInline(name)}${at ? ` · ${writer.time(at)}` : ''}`)
  }
  for (const entry of session.entries) {
    switch (entry.kind) {
      case 'user': {
        // The answer a card already shows, such as a plan's approval, is no message of the user's.
        if (entry.approval) break
        speaker = null
        speak('user', entry.from ? writer.t('fromSession') : writer.t('you'), entry.at)
        writer.block(writer.userContent(entry.content, session.sessionId))
        break
      }
      case 'session_message':
        speaker = null
        speak('user', writer.t('otherSession'))
        writer.block(writer.userContent(entry.content, session.sessionId))
        break
      case 'agent': {
        speak('agent', session.agent, entry.at)
        const refs = writer.refs(entry.attachments, session.sessionId)
        writer.block([entry.markdown.trim(), ...refs].join('\n\n'))
        break
      }
      case 'thought':
        if (!writer.show.thoughts || !entry.markdown.trim()) break
        speak('agent', session.agent)
        writer.details(writer.t('thinking'), entry.markdown)
        break
      case 'tool':
        speak('agent', session.agent)
        toolMarkdown(writer, entry, session)
        break
      case 'plan':
        if (entry.items.length === 0) break
        speak('agent', session.agent)
        writer.block(
          [
            `**${writer.t('todo')}**`,
            '',
            ...entry.items.map(
              (item) =>
                `- [${item.status === 'completed' ? 'x' : ' '}] ${escapeInline(oneLine(item.content, 500))}`,
            ),
          ].join('\n'),
        )
        break
      case 'subagent': {
        const child = writer.child(entry.sessionId)
        const title = child?.title ?? entry.sessionId
        speak('agent', session.agent)
        writer.block(`**${writer.t('subagent', { title: escapeInline(title) })}**`)
        if (child && writer.show.subagents && depth < MAX_SUBAGENT_DEPTH) {
          entriesMarkdown(writer, child, level + 1, depth + 1)
          speaker = null
        }
        break
      }
      case 'notice':
        writer.block(
          quoted(
            `**${escapeInline(entry.title)}**${entry.description ? `\n\n${entry.description}` : ''}`,
          ),
        )
        break
      case 'compaction':
        if (entry.status !== 'completed') break
        if (entry.summary.trim()) writer.details(writer.t('compacted'), entry.summary)
        else writer.block(`*${writer.t('compacted')}*`)
        break
      case 'git':
        switch (entry.event) {
          case 'commit':
            for (const commit of entry.commits) {
              writer.item(
                `*${writer.t('commit')}* \`${commit.oid.slice(0, 7)}\` ${escapeInline(commit.subject)}`,
              )
            }
            break
          case 'push':
            writer.item(
              `*${writer.t('pushed', { count: entry.count, upstream: escapeInline(entry.upstream) })}*`,
            )
            break
          case 'branch':
            writer.item(`*${writer.t('branch', { branch: escapeInline(entry.branch) })}*`)
            break
          case 'pull_request':
            writer.item(`*${writer.t('pullRequest')}* <${entry.url}>`)
            break
        }
        break
      case 'artifact':
        writer.item(
          `*${writer.t('artifact', { title: escapeInline(entry.title), version: entry.version ?? '-' })}*`,
        )
        break
      case 'memory':
        writer.item(`*${writer.t('memory', { title: escapeInline(entry.title) })}*`)
        break
      case 'takeover':
        speaker = null
        writer.block(`*${writer.t('takeover', { agent: escapeInline(entry.agentId) })}*`)
        break
      default:
        // Kettu's own records of a turn: sites, devices, apps, hooks, reports and the like.
        break
    }
  }
}

/** The session, and its sub-agents' sessions by id, as Markdown and the pictures it links. */
export function sessionMarkdown(input: {
  session: ExportSession
  children?: ReadonlyMap<string, ExportSession>
  options: ExportOptions
  text: ExportText
  exportedAt: number
}): { markdown: string; images: ExportImage[] } {
  const { session, options, text } = input
  const writer = new Writer(text, options, input.children ?? new Map())
  writer.block(`# ${escapeInline(session.title)}`)
  const facts = [
    [text.t('agent'), escapeInline(session.agent)],
    ...(session.model ? [[text.t('model'), escapeInline(session.model)]] : []),
    ...(session.project ? [[text.t('project'), `\`${session.project.replace(/`/g, '')}\``]] : []),
    [text.t('started'), text.time(session.createdAt)],
    [text.t('updated'), text.time(session.updatedAt)],
    [text.t('exported'), text.time(input.exportedAt)],
  ]
  for (const [name, value] of facts) writer.item(`**${name}:** ${value}`)
  writer.block('---')
  entriesMarkdown(writer, session, 2, 0)
  return { markdown: writer.done(), images: writer.images }
}
