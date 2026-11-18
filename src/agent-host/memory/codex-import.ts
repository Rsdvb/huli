// Huli: Codex's own memory, read for import into Kettu's beside Claude Code's (claude-import.ts).
// Kettu turns Codex's memories off in the sessions it runs, so what Codex learned before stays in
// `$CODEX_HOME/memories`. Only the curated files are read: MEMORY.md, whose task groups each become
// an entry placed by the folder they apply to, and memory_summary.md, whose profile, preferences and
// tips become global ones. raw_memories.md and rollout_summaries/ are the per-session notes those
// were made from, extensions/ holds notes already merged into them, and skills/ are skills, not
// memory. `memories_v2`, a newer layout with only a summary, is read when `memories` has none. The
// files are only read, never changed. Huli's own; see tools/huli/README.md.

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  MEMORY_BODY_CHARS,
  MEMORY_DESCRIPTION_CHARS,
  MEMORY_TITLE_CHARS,
  type MemoryDraft,
} from '@shared/memory'
import type { LogFn } from '../storage'
import { cut, normalizeBody, oneLine } from './entry-file'
import { secretKind } from './secrets'

/** A file larger than this is no memory file Codex wrote, and is passed over. */
const MAX_FILE_BYTES = 1024 * 1024

/** An entry of Codex's memory, shaped to fit Kettu's limits. */
export interface CodexMemory {
  /** Names it among its folder's entries: its file and its heading. */
  file: string
  draft: MemoryDraft
  aboutUser: boolean
  modifiedAt: number
  /** The folders Codex says it applies to, most specific first; none for a general one. */
  projects: string[]
}

/** A heading's section: its title, and the lines under it up to the next of its level or above. */
interface Section {
  title: string
  lines: string[]
}

function sections(lines: readonly string[], level: number): Section[] {
  const out: Section[] = []
  const heading = new RegExp(`^#{1,${level}}\\s+(.+?)\\s*$`)
  const own = new RegExp(`^#{${level}}\\s+(.+?)\\s*$`)
  let current: Section | null = null
  for (const line of lines) {
    if (heading.test(line)) {
      const match = own.exec(line)
      current = match ? { title: match[1]!, lines: [] } : null
      if (current) out.push(current)
      continue
    }
    current?.lines.push(line)
  }
  return out
}

/** Lines without the subsections under the headings `drop` matches. */
function without(lines: readonly string[], drop: RegExp): string[] {
  const out: string[] = []
  let dropping: number | null = null
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      if (dropping !== null && level <= dropping) dropping = null
      if (dropping === null && drop.test(heading[2]!)) {
        dropping = level
        continue
      }
    }
    if (dropping === null) out.push(line)
  }
  return out
}

function plainPath(value: string): string {
  const trimmed = value.trim().replace(/^`|`$/g, '')
  if (trimmed.startsWith('\\\\?\\UNC\\')) return `\\\\${trimmed.slice(8)}`
  if (trimmed.startsWith('\\\\?\\')) return trimmed.slice(4)
  return trimmed
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

/** `applies_to: cwd=C:\a / project=D:\b; reuse_rule=…`: D:\b, then C:\a. */
export function appliesTo(line: string): string[] {
  const head = line.replace(/^applies_to:\s*/i, '').split(';')[0] ?? ''
  const found: { key: string; value: string }[] = []
  for (const part of head.split(/\s+\/\s+/)) {
    const match = /^\s*(cwd|project)\s*=\s*(.+?)\s*$/i.exec(part)
    if (match) found.push({ key: match[1]!.toLowerCase(), value: plainPath(match[2]!) })
  }
  return found
    .sort((a, b) => (a.key === b.key ? 0 : a.key === 'project' ? -1 : 1))
    .map((item) => item.value)
    .filter((value) => ABSOLUTE.test(value))
}

/** The body, cut to fit with a note that says where the whole text is. */
function fitted(body: string, source: string): string {
  if (Array.from(body).length <= MEMORY_BODY_CHARS) return body
  const note = `\n\n(Cut to fit Kettu's memory on import; the whole text is in ${source}.)`
  return `${cut(body, MEMORY_BODY_CHARS - Array.from(note).length)}${note}`
}

interface Parsed {
  heading: string
  title: string
  description: string
  body: string
  aboutUser: boolean
  projects: string[]
}

/** MEMORY.md's `# Task Group:` sections, without the lists of Codex's own rollout files. */
export function parseTaskGroups(text: string): Parsed[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  return sections(lines, 1).flatMap((section): Parsed[] => {
    const title = oneLine(section.title.replace(/^Task Group:\s*/i, ''))
    if (title === '') return []
    let description = ''
    let projects: string[] = []
    const kept = without(section.lines, /^rollout_summary_files$/i).filter((line) => {
      if (/^scope:/i.test(line)) {
        description = oneLine(line.replace(/^scope:\s*/i, ''))
        return false
      }
      if (/^applies_to:/i.test(line)) projects = appliesTo(line)
      return true
    })
    const body = normalizeBody(kept.join('\n'))
    if (body === '' && description === '') return []
    return [{ heading: section.title, title, description, body, aboutUser: false, projects }]
  })
}

const PLACEHOLDER = /^no\b.*\bsupported by the available sources\.?$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** `rollout_summaries/x.md — Text. thread_id=…` as `Text.` */
function topicLine(line: string): string {
  return line
    .replace(/rollout_summaries\/\S+\.md\s*(?:—|-|:)\s*/g, '')
    .replace(/\s*\bthread_id=[\w-]+/g, '')
}

/** The folders a topic's lines name as its project or workspace. */
function topicProjects(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    for (const match of line.matchAll(/\b(?:Project|Workspace|cwd)\s*[:=]\s*`([^`]+)`/gi)) {
      const value = plainPath(match[1]!)
      if (ABSOLUTE.test(value) && !out.includes(value)) out.push(value)
    }
  }
  return out
}

/**
 * memory_summary.md's sections about the user and general tips, each one entry. Its index of what
 * is in memory is read only with `topics`, for a layout without MEMORY.md, whose topics it then is.
 */
export function parseSummary(text: string, topics: boolean): Parsed[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  return sections(lines, 2).flatMap((section): Parsed[] => {
    const name = oneLine(section.title)
    if (/^what'?s in memory$/i.test(name)) {
      if (!topics) return []
      return sections(section.lines, 4)
        .concat(sections(section.lines, 3))
        .flatMap((topic): Parsed[] => {
          // A level-3 topic's dated subsections are part of it; a level-4 one is a topic of its own.
          const title = oneLine(topic.title)
          if (DATE.test(title) || /^older memory topics$/i.test(title)) return []
          const body = normalizeBody(
            topic.lines
              .filter((line) => !/^#{1,6}\s+\d{4}-\d{2}-\d{2}\s*$/.test(line))
              .map(topicLine)
              .join('\n'),
          )
          if (body === '') return []
          return [
            {
              heading: `${section.title}/${topic.title}`,
              title,
              description: '',
              body,
              aboutUser: false,
              projects: topicProjects(topic.lines),
            },
          ]
        })
    }
    const body = normalizeBody(section.lines.join('\n'))
    if (body === '' || PLACEHOLDER.test(oneLine(body))) return []
    return [
      {
        heading: section.title,
        title: `${name} (Codex)`,
        description: '',
        body,
        aboutUser: /\buser\b/i.test(name),
        projects: [],
      },
    ]
  })
}

async function readSmall(file: string, log: LogFn): Promise<{ text: string; at: number } | null> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return null
    if (info.size > MAX_FILE_BYTES) {
      log('warn', `Passed over ${file} for import: it is larger than Codex's memory files`)
      return null
    }
    return { text: await readFile(file, 'utf8'), at: info.mtimeMs }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log('warn', `Could not read Codex memory ${file}: ${(error as Error).message}`)
    }
    return null
  }
}

/** What Codex's memory under `home` holds; a missing folder holds nothing. */
export async function readCodexMemory(home: string, log: LogFn): Promise<CodexMemory[]> {
  let folder = 'memories'
  let handbook = await readSmall(path.join(home, folder, 'MEMORY.md'), log)
  let summary = await readSmall(path.join(home, folder, 'memory_summary.md'), log)
  if (!handbook && !summary) {
    folder = 'memories_v2'
    handbook = await readSmall(path.join(home, folder, 'MEMORY.md'), log)
    summary = await readSmall(path.join(home, folder, 'memory_summary.md'), log)
  }
  const out: CodexMemory[] = []
  const add = (file: string, at: number, parsed: Parsed[]): void => {
    const full = path.join(home, folder, file)
    for (const item of parsed) {
      const draft: MemoryDraft = {
        title: cut(item.title, MEMORY_TITLE_CHARS),
        description: cut(item.description, MEMORY_DESCRIPTION_CHARS),
        body: fitted(item.body, full),
      }
      const secret = secretKind(`${draft.title}\n${draft.description}\n${draft.body}`)
      if (secret !== null) {
        log(
          'warn',
          `Passed over "${item.heading}" in ${full} for import: it seems to hold ${secret}`,
        )
        continue
      }
      out.push({
        file: `${folder}/${file}#${item.heading}`,
        draft,
        aboutUser: item.aboutUser,
        modifiedAt: at,
        projects: item.projects,
      })
    }
  }
  if (summary) add('memory_summary.md', summary.at, parseSummary(summary.text, !handbook))
  if (handbook) add('MEMORY.md', handbook.at, parseTaskGroups(handbook.text))
  return out
}
