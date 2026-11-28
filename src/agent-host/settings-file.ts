// Claude Code's settings file in an agent's folder: read as a JSON object and written back whole,
// so what a caller does not touch stays as the user left it.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from './i18n'
import { notifyStorageWrite } from './storage'

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Where `jsonErrorLine` found the text stop being JSON. */
class JsonStop {
  constructor(readonly at: number) {}
}

const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y
const ESCAPE = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y

/**
 * The line of `text`'s first JSON error, counting from 1, or null when it is valid JSON. Read
 * here rather than from `JSON.parse`'s message, which gives no place for an unexpected token.
 */
export function jsonErrorLine(text: string): number | null {
  let at = 0
  const fail = (): never => {
    throw new JsonStop(at)
  }
  const space = (): void => {
    while (at < text.length && ' \t\n\r'.includes(text[at]!)) at++
  }
  const string = (): void => {
    at++
    for (;;) {
      const c = text[at]
      if (c === undefined || c < ' ') fail()
      if (c === '"') {
        at++
        return
      }
      if (c === '\\') {
        ESCAPE.lastIndex = at
        if (!ESCAPE.test(text)) fail()
        at = ESCAPE.lastIndex
      } else at++
    }
  }
  const list = (close: string, item: () => void): void => {
    at++
    space()
    if (text[at] === close) {
      at++
      return
    }
    for (;;) {
      item()
      space()
      if (text[at] === ',') at++
      else if (text[at] === close) {
        at++
        return
      } else fail()
    }
  }
  const value = (): void => {
    space()
    const c = text[at]
    if (c === '{') {
      list('}', () => {
        space()
        if (text[at] !== '"') fail()
        string()
        space()
        if (text[at] !== ':') fail()
        at++
        value()
      })
    } else if (c === '[') list(']', value)
    else if (c === '"') string()
    else {
      LITERAL.lastIndex = at
      if (!LITERAL.test(text)) fail()
      at = LITERAL.lastIndex
    }
  }
  try {
    value()
    space()
    if (at < text.length) fail()
    return null
  } catch (error) {
    if (!(error instanceof JsonStop)) throw error
    return text.slice(0, error.at).split('\n').length
  }
}

/** Reads the settings file of `agent`, as the user's error names it; a missing file is empty. */
export async function readSettings(
  file: string,
  agent = 'Claude Code',
): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  // Windows editors may start the file with a byte order mark, which JSON.parse refuses.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Rewriting a file Kettu cannot read would lose what the user wrote in it.
    const line = jsonErrorLine(text)
    throw new Error(
      line === null
        ? t('settingsFile.notJson', { agent, file })
        : t('settingsFile.notJsonAt', { agent, file, line }),
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(t('settingsFile.notObject', { agent, file }))
  }
  return parsed as Record<string, unknown>
}

/** Writes the settings as JSON beside the file and renames it over. */
export async function writeSettings(
  file: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(settings, null, 2)}\n`)
}

/** Writes beside the file and renames it over, so a crash never leaves half a settings file. */
export async function writeTextAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.kettu-${process.pid}.tmp`
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(temp, text, { mode: 0o600 })
    await rename(temp, file)
    notifyStorageWrite(file, true)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    notifyStorageWrite(file, false, error)
    throw error
  }
}
