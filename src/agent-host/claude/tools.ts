// How a Claude Code tool call shows in a thread: its title, kind, locations and content, from
// the tool's name and input, then from its result.

import path from 'node:path'
import type { ContentRef, ToolContent, ToolEntry, ToolKind } from '@shared/thread'
import { t } from '../i18n'
import { blockRef as otherRef, blockText as otherText } from '../mcp-content'
import { resultMarkdown } from '../result-text'
import { toLf } from '../session-updates'
import type { ContentBlock, ToolResultBlock } from './sdk'

export interface ToolView {
  title: string
  toolKind: ToolKind
  locations: ToolEntry['locations']
  content: ToolContent[]
  question?: string
}

/** One of the questions AskUserQuestion puts to the user, with the answers it offers. */
export interface AskedQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

type Input = Record<string, unknown>

function asInput(input: unknown): Input {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Input)
    : {}
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** A path relative to the session's folder when it lies inside it. */
export function displayPath(file: string, cwd: string): string {
  const root = path.resolve(cwd)
  const resolved = path.resolve(file)
  return resolved === root || resolved.startsWith(root + path.sep)
    ? path.relative(root, resolved)
    : file
}

/** Text in a fence longer than any it holds, so it shows as written. */
export function fenced(body: string, info = ''): string {
  let fence = '```'
  for (const [run] of body.matchAll(/^`{3,}/gm)) {
    while (run.length >= fence.length) fence += '`'
  }
  return `${fence}${info}\n${body}${body.endsWith('\n') ? '' : '\n'}${fence}`
}

const markdown = (value: string): ToolContent => ({ type: 'markdown', markdown: toLf(value) })

function grepTitle(input: Input): string {
  let label = 'grep'
  if (input['-i']) label += ' -i'
  if (input['-n']) label += ' -n'
  for (const flag of ['-A', '-B', '-C']) {
    if (input[flag] !== undefined) label += ` ${flag} ${String(input[flag])}`
  }
  if (input.output_mode === 'files_with_matches') label += ' -l'
  else if (input.output_mode === 'count') label += ' -c'
  if (input.head_limit !== undefined) label += ` | head -${String(input.head_limit)}`
  if (text(input.glob)) label += ` --include="${String(input.glob)}"`
  if (text(input.type)) label += ` --type=${String(input.type)}`
  if (input.multiline) label += ' -P'
  if (text(input.pattern)) label += ` "${String(input.pattern)}"`
  if (text(input.path)) label += ` ${String(input.path)}`
  return label
}

/** AskUserQuestion's questions, or null when its input holds none that can be answered. */
export function askedQuestions(raw: unknown): AskedQuestion[] | null {
  const questions = asInput(raw).questions
  if (!Array.isArray(questions) || questions.length === 0) return null
  const asked: AskedQuestion[] = []
  for (const item of questions) {
    const fields = asInput(item)
    const question = text(fields.question)
    const options = Array.isArray(fields.options)
      ? fields.options
          .map((option) => asInput(option))
          .filter((option) => text(option.label))
          .map((option) => ({
            label: String(option.label),
            description: text(option.description) ?? '',
          }))
      : []
    if (!question || options.length === 0) return null
    asked.push({
      question,
      header: text(fields.header) ?? '',
      multiSelect: fields.multiSelect === true,
      options,
    })
  }
  return asked
}

/** What a tool call shows from its input. */
export function toolView(name: string, raw: unknown, cwd: string): ToolView {
  const input = asInput(raw)
  const view = (
    title: string,
    toolKind: ToolKind,
    extra: Partial<Omit<ToolView, 'title' | 'toolKind'>> = {},
  ): ToolView => ({ title, toolKind, locations: [], content: [], ...extra })
  const file = text(input.file_path) ?? text(input.path)
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return view(text(input.command) ?? t('claude.tool.terminal'), 'execute')
    case 'Read': {
      const offset = typeof input.offset === 'number' ? input.offset : null
      const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : null
      const range =
        limit !== null
          ? t('claude.tool.lines', { from: offset ?? 1, to: (offset ?? 1) + limit - 1 })
          : offset
            ? t('claude.tool.fromLine', { line: offset })
            : ''
      const shown = file ? displayPath(file, cwd) : t('claude.tool.file')
      return view(t('claude.tool.read', { path: shown, range }), 'read', {
        locations: file ? [{ path: file, line: offset ?? 1 }] : [],
      })
    }
    case 'Write': {
      const content = text(input.content) ?? text(input.file_text) ?? ''
      const title = file
        ? t('claude.tool.writePath', { path: displayPath(file, cwd) })
        : t('claude.tool.write')
      return view(title, 'edit', {
        locations: file ? [{ path: file }] : [],
        content: file ? [{ type: 'diff', path: file, oldText: null, newText: toLf(content) }] : [],
      })
    }
    case 'Edit': {
      const oldText = typeof input.old_string === 'string' ? toLf(input.old_string) : ''
      const newText = typeof input.new_string === 'string' ? toLf(input.new_string) : ''
      const title = file
        ? t('claude.tool.editPath', { path: displayPath(file, cwd) })
        : t('claude.tool.edit')
      return view(title, 'edit', {
        locations: file ? [{ path: file }] : [],
        content: file ? [{ type: 'diff', path: file, oldText, newText }] : [],
      })
    }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits.map(asInput) : []
      const title = file
        ? t('claude.tool.editPath', { path: displayPath(file, cwd) })
        : t('claude.tool.edit')
      return view(title, 'edit', {
        locations: file ? [{ path: file }] : [],
        content: file
          ? edits.map((one) => ({
              type: 'diff' as const,
              path: file,
              oldText: typeof one.old_string === 'string' ? toLf(one.old_string) : '',
              newText: typeof one.new_string === 'string' ? toLf(one.new_string) : '',
            }))
          : [],
      })
    }
    case 'NotebookEdit': {
      const notebook = text(input.notebook_path)
      const title = notebook
        ? t('claude.tool.editPath', { path: displayPath(notebook, cwd) })
        : t('claude.tool.editNotebook')
      // Huli: the cell's new source, which its result sets beside the old one.
      const source = typeof input.new_source === 'string' ? toLf(input.new_source) : ''
      const deletes = input.edit_mode === 'delete'
      return view(title, 'edit', {
        locations: notebook ? [{ path: notebook }] : [],
        content:
          notebook && !deletes
            ? [{ type: 'diff', path: notebook, oldText: '', newText: source }]
            : [],
      })
    }
    case 'SendUserFile': {
      const files = [
        text(input.file_path),
        text(input.path),
        ...(Array.isArray(input.files) ? input.files : []).map((one) =>
          typeof one === 'string' ? one : text(asInput(one).path),
        ),
      ].filter((one): one is string => typeof one === 'string' && one !== '')
      const first = files[0]
      return view(
        first
          ? t('claude.tool.sendFile', { path: displayPath(first, cwd) })
          : t('claude.tool.sendFiles'),
        'other',
        { locations: files.map((one) => ({ path: one })) },
      )
    }
    case 'Glob': {
      const pattern = text(input.pattern)
      const where = text(input.path)
      const title =
        pattern && where
          ? t('claude.tool.findIn', { pattern, path: where })
          : pattern
            ? t('claude.tool.findPattern', { pattern })
            : where
              ? t('claude.tool.findPath', { path: where })
              : t('claude.tool.find')
      return view(title, 'search', {
        locations: where ? [{ path: where }] : [],
      })
    }
    case 'Grep':
      return view(grepTitle(input), 'search')
    case 'WebFetch': {
      const url = text(input.url)
      return view(url ? t('claude.tool.fetchUrl', { url }) : t('claude.tool.fetch'), 'fetch', {
        content: text(input.prompt) ? [markdown(String(input.prompt))] : [],
      })
    }
    // Huli: the API's own tools, which Claude runs on Anthropic's side.
    case 'web_search':
      return toolView('WebSearch', input, cwd)
    case 'web_fetch':
      return toolView('WebFetch', input, cwd)
    case 'code_execution':
    case 'bash_code_execution':
      return view(
        text(input.command) ?? text(input.code) ?? t('claude.tool.codeExecution'),
        'execute',
      )
    case 'WebSearch': {
      const query = text(input.query)
      return view(
        query ? t('claude.tool.searchQuery', { query }) : t('claude.tool.webSearch'),
        'fetch',
      )
    }
    case 'Agent':
    case 'Task':
      return view(text(input.description) ?? t('claude.tool.task'), 'think', {
        content: text(input.prompt) ? [markdown(String(input.prompt))] : [],
      })
    case 'ExitPlanMode':
      return view(t('claude.tool.approvePlan'), 'switch_mode', {
        content: text(input.plan) ? [markdown(String(input.plan))] : [],
      })
    case 'EnterPlanMode':
      return view(t('claude.tool.plan'), 'switch_mode')
    case 'AskUserQuestion': {
      const first = askedQuestions(input)?.[0]
      return first
        ? view(first.header || first.question, 'other', { question: first.question })
        : view(t('claude.tool.question'), 'other')
    }
    case 'Skill': {
      const skill = text(input.skill)
      return view(
        skill ? t('claude.tool.loadSkillNamed', { skill }) : t('claude.tool.loadSkill'),
        'other',
      )
    }
    default:
      return view(name || t('claude.tool.tool'), 'other')
  }
}

/** The tools whose calls show as the session's plan instead of as tool calls. */
export const PLAN_TOOLS: ReadonlySet<string> = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
])

/** The tools that start a subagent, which shows as a session of its own. */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

function blockRef(block: ContentBlock): ContentRef | null {
  if (block.type !== 'image') return null
  const source = (block as { source?: { type?: string; media_type?: string; data?: string } })
    .source
  if (source?.type !== 'base64' || !source.media_type || !source.data) return null
  return { kind: 'image', mimeType: source.media_type, data: source.data }
}

/** The text and images of a tool result, as Claude Code sent them to the model. */
export function resultParts(result: ToolResultBlock): { text: string; refs: ContentRef[] } {
  const { content } = result
  if (typeof content === 'string') return { text: content, refs: [] }
  if (!Array.isArray(content)) return { text: '', refs: [] }
  const texts: string[] = []
  const refs: ContentRef[] = []
  for (const block of content) {
    if (block.type === 'text') texts.push((block as { text: string }).text)
    else {
      const ref = blockRef(block)
      if (ref) {
        refs.push(ref)
        continue
      }
      // Huli: a resource, a document, a search result, a tool a search found, a sound.
      const other = otherText(block)
      if (other !== null) texts.push(other)
      else {
        const shown = otherRef(block)
        if (shown) refs.push(shown)
      }
    }
  }
  return { text: texts.join('\n'), refs }
}

const REMINDER = /\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g

/**
 * What a finished tool call shows: its output, from the structured result where Claude Code
 * gives one, else from the text it sent the model. Null keeps what the call showed.
 */
export function resultContent(
  name: string,
  result: ToolResultBlock,
  structured: unknown,
  before: readonly ToolContent[],
): ToolContent[] | null {
  const { text: raw, refs } = resultParts(result)
  const error = result.is_error === true
  const body = toLf(raw.replace(REMINDER, '\n')).trim()
  const images: ToolContent[] = refs.map((ref) => ({ type: 'ref', ref }))
  const shaped = asInput(structured)
  if (name === 'Bash' || name === 'PowerShell') {
    let output = body
    if (typeof shaped.stdout === 'string' && typeof shaped.stderr === 'string') {
      output = [shaped.stdout, shaped.stderr].filter(Boolean).join('\n')
      if (shaped.interrupted === true) {
        output = [output, '[Command was aborted before completion]'].filter(Boolean).join('\n')
      }
    }
    output = toLf(output).replace(/\n+$/, '')
    return [...(output ? [markdown(fenced(output, 'console'))] : []), ...images]
  }
  if (error) return [...(body ? [markdown(fenced(body))] : []), ...images]
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return null
    case 'NotebookEdit': {
      const notebook = before.find((item) => item.type === 'diff')
      if (!notebook || notebook.type !== 'diff') return null
      const old = typeof shaped.old_source === 'string' ? toLf(shaped.old_source) : null
      const next =
        typeof shaped.new_source === 'string' ? toLf(shaped.new_source) : notebook.newText
      return [{ ...notebook, oldText: old ?? notebook.oldText ?? '', newText: next }]
    }
    case 'Write': {
      const original = shaped.originalFile
      if (typeof original !== 'string') return null
      return before.map((item) =>
        item.type === 'diff' ? { ...item, oldText: toLf(original) } : item,
      )
    }
    case 'ExitPlanMode':
    case 'EnterPlanMode':
      return null
    case 'Read': {
      const file = asInput(shaped.file)
      if (shaped.type === 'text' && typeof file.content === 'string' && file.content !== '') {
        const start = typeof file.startLine === 'number' ? file.startLine : 1
        const numbered = toLf(file.content)
          .replace(/\n$/, '')
          .split('\n')
          .map((line, i) => `${start + i}\t${line}`)
          .join('\n')
        return [markdown(fenced(numbered)), ...images]
      }
      return [...(body ? [markdown(fenced(body))] : []), ...images]
    }
    case 'Agent':
    case 'Task': {
      const report = shaped.content
      if (shaped.status === 'completed' && Array.isArray(report) && report.length > 0) {
        const texts = report.flatMap((block: unknown) =>
          typeof block === 'object' && block !== null && (block as ContentBlock).type === 'text'
            ? [(block as { text: string }).text]
            : [],
        )
        if (texts.length > 0) return [markdown(texts.join('\n\n'))]
      }
      return [...(body ? [markdown(body)] : []), ...images]
    }
    default: {
      // An MCP tool's JSON, a listing of files or a search's lines show as written.
      const shown = resultMarkdown(body)
      return [...(shown ? [markdown(shown)] : []), ...images]
    }
  }
}

/** Huli: a result block of a tool the API runs itself, such as `web_search_tool_result`. */
export interface ServerToolResult {
  type: string
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

/** Huli: whether a block of an assistant message is the result of one of the API's own tools. */
export function isServerToolResult(block: ContentBlock): block is ServerToolResult {
  return (
    block.type !== 'tool_result' &&
    block.type.endsWith('_tool_result') &&
    typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
  )
}

/**
 * Huli: what a call of one of the API's own tools shows once its result block came: the pages a
 * search found, the page a fetch read, what code printed and its exit code, an MCP tool's text.
 */
export function serverResultView(block: ServerToolResult): {
  failed: boolean
  content: ToolContent[]
  exitCode?: number
} {
  const value = block.content
  const fields = asInput(value)
  const error = typeof fields.type === 'string' && fields.type.endsWith('_error')
  if (error) {
    const code = text(fields.error_code) ?? text(fields.error_message) ?? ''
    return { failed: true, content: code ? [markdown(fenced(code))] : [] }
  }
  if (block.type === 'web_search_tool_result' && Array.isArray(value)) {
    const lines = value.flatMap((item) => {
      const result = asInput(item)
      const url = text(result.url)
      if (!url) return []
      const title = (text(result.title) ?? url).replace(/[[\]]/g, '')
      return [`- [${title}](${url})`]
    })
    return { failed: false, content: lines.length > 0 ? [markdown(lines.join('\n'))] : [] }
  }
  if (block.type === 'web_fetch_tool_result') {
    const url = text(fields.url)
    const title = text(asInput(fields.content).title)
    return { failed: false, content: url ? [markdown(`[${title ?? url}](${url})`)] : [] }
  }
  if (typeof fields.stdout === 'string' || typeof fields.stderr === 'string') {
    const printed = [fields.stdout, fields.stderr].filter(
      (part) => typeof part === 'string' && part !== '',
    )
    const code = typeof fields.return_code === 'number' ? fields.return_code : undefined
    return {
      failed: code !== undefined && code !== 0,
      content: printed.length > 0 ? [markdown(fenced(toLf(printed.join('\n')), 'console'))] : [],
      ...(code !== undefined ? { exitCode: code } : {}),
    }
  }
  const texts =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.flatMap((item) =>
            asInput(item).type === 'text' ? [String(asInput(item).text)] : [],
          )
        : []
  const shown = resultMarkdown(toLf(texts.join('\n')))
  return { failed: block.is_error === true, content: shown ? [markdown(shown)] : [] }
}

/** The tool the turn's own work keeps running after its call ended. */
export function startsBackgroundWork(name: string, input: unknown): boolean {
  const fields = asInput(input)
  if (name === 'Monitor') return true
  return fields.run_in_background === true && typeof fields.command === 'string'
}
