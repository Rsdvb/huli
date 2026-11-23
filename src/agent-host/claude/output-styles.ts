// Huli: Claude Code's output styles: the ones it builds in, and the user's own Markdown files in
// the `output-styles` folder of its configuration folder, read only, each by the `name` and
// `description` of its frontmatter or else its file name, as Claude Code lists them.

import { open, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { OutputStyleInfo } from '@shared/agent-host'
import { t } from '../i18n'

/** Claude Code 2.1's built-in styles, in its own order; `default` is no style at all. */
export const BUILT_IN_STYLES = [
  'default',
  'Proactive',
  'Concise',
  'Explanatory',
  'Learning',
] as const

const BUILT_IN = new Set<string>(BUILT_IN_STYLES)
const MAX_FILES = 200
/** Enough of a file for its frontmatter; the style's prompt after it is not needed. */
const HEAD_BYTES = 8192
const MAX_NAME_CHARS = 100

export function isBuiltInStyle(name: string): boolean {
  return BUILT_IN.has(name)
}

/** A style's name as menus show it: a built-in one's in the interface's language. */
export function styleName(name: string): string {
  return isBuiltInStyle(name)
    ? t(`claude.outputStyle.${name as (typeof BUILT_IN_STYLES)[number]}.name`)
    : name
}

/** What a built-in style does, in the interface's language. */
export function styleDescription(name: string): string | undefined {
  return isBuiltInStyle(name)
    ? t(`claude.outputStyle.${name as (typeof BUILT_IN_STYLES)[number]}.description`)
    : undefined
}

/** A frontmatter field's value, unquoted; null when the head has none. */
function field(head: string, key: string): string | null {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(head)
  const value = match?.[1]
    ?.trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim()
  return value ? value : null
}

/** One file's style, or null when it is not one Claude Code would list. */
async function readStyle(file: string): Promise<OutputStyleInfo | null> {
  let text: string
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const name = field(front, 'name') ?? path.basename(file, path.extname(file))
  if (name.length === 0 || name.length > MAX_NAME_CHARS || /\p{Cc}/u.test(name)) return null
  const description = field(front, 'description')
  return { name, label: name, description, builtIn: false }
}

/** The built-in styles, then the user's own from `folder`, sorted by name, without repeats. */
export async function readOutputStyles(folder: string): Promise<OutputStyleInfo[]> {
  const builtIn: OutputStyleInfo[] = BUILT_IN_STYLES.map((name) => ({
    name,
    label: styleName(name),
    description: styleDescription(name) ?? null,
    builtIn: true,
  }))
  let files: string[]
  try {
    files = (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
      .map((name) => path.join(folder, name))
      .slice(0, MAX_FILES)
  } catch {
    return builtIn
  }
  const own = new Map<string, OutputStyleInfo>()
  for (const style of await Promise.all(files.map(readStyle))) {
    if (style && !isBuiltInStyle(style.name) && !own.has(style.name)) own.set(style.name, style)
  }
  return [...builtIn, ...[...own.values()].sort((a, b) => a.name.localeCompare(b.name))]
}
