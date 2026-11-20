// Huli: takes top-level keys out of an agent's JSON file and keeps every other byte of it, since
// such a file, as Claude Code's `.claude.json`, holds the user's configuration beside its ids and
// account. The file is replaced whole, through a file beside it, or not at all.

import { randomBytes } from 'node:crypto'
import { lstat, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface Member {
  key: string
  /** Where the member's key begins and its value ends. */
  start: number
  end: number
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])
const BOM = String.fromCharCode(0xfeff)

/** The members of the top-level object in `text`, in order; null when it is not one. */
function members(text: string): Member[] | null {
  let i = 0
  const skip = (): void => {
    while (i < text.length && (WHITESPACE.has(text[i]!) || (i === 0 && text[i] === BOM))) i++
  }
  const stringEnd = (from: number): number => {
    let j = from + 1
    while (j < text.length) {
      const char = text[j]
      if (char === '\\') j += 2
      else if (char === '"') return j + 1
      else j++
    }
    return -1
  }
  const valueEnd = (from: number): number => {
    const first = text[from]
    if (first === '"') return stringEnd(from)
    if (first === '{' || first === '[') {
      let depth = 0
      let j = from
      while (j < text.length) {
        const char = text[j]
        if (char === '"') {
          j = stringEnd(j)
          if (j < 0) return -1
          continue
        }
        if (char === '{' || char === '[') depth++
        else if (char === '}' || char === ']') {
          depth--
          if (depth === 0) return j + 1
        }
        j++
      }
      return -1
    }
    let j = from
    while (j < text.length && !WHITESPACE.has(text[j]!) && !',}]'.includes(text[j]!)) j++
    return j === from ? -1 : j
  }
  skip()
  if (text[i] !== '{') return null
  i++
  const found: Member[] = []
  skip()
  if (text[i] === '}') return found
  while (i < text.length) {
    skip()
    if (text[i] !== '"') return null
    const start = i
    const keyEnd = stringEnd(i)
    if (keyEnd < 0) return null
    const key = JSON.parse(text.slice(start, keyEnd)) as string
    i = keyEnd
    skip()
    if (text[i] !== ':') return null
    i++
    skip()
    const end = valueEnd(i)
    if (end < 0) return null
    found.push({ key, start, end })
    i = end
    skip()
    if (text[i] === ',') {
      i++
      continue
    }
    if (text[i] === '}') return found
    return null
  }
  return null
}

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Which of `keys` the JSON object in `text` has; null when the text is no JSON object. */
export function presentKeys(text: string, keys: readonly string[]): string[] | null {
  const parsed = parsedObject(text)
  if (!parsed) return null
  return keys.filter((key) => Object.hasOwn(parsed, key))
}

/**
 * `text` without the top-level `keys`, every other byte as it was: the members kept keep the
 * separators that followed them, and the last one kept the text that closed the object. Throws
 * when the text is no JSON object, so nothing is written over a file that did not parse.
 */
export function removeJsonKeys(
  text: string,
  keys: readonly string[],
): { text: string; removed: string[] } {
  const parsed = parsedObject(text)
  const list = parsed ? members(text) : null
  if (!parsed || !list) throw new Error('it is not a JSON object')
  const drop = new Set(keys)
  const kept = list.filter((member) => !drop.has(member.key))
  const removed = [...new Set(list.filter((m) => drop.has(m.key)).map((m) => m.key))]
  if (removed.length === 0) return { text, removed }
  const last = list[list.length - 1]!
  let out = text.slice(0, list[0]!.start)
  kept.forEach((member, index) => {
    out += text.slice(member.start, member.end)
    if (index === kept.length - 1) return
    const next = list[list.indexOf(member) + 1]!
    out += text.slice(member.end, next.start)
  })
  out += text.slice(last.end)
  const expected = Object.fromEntries(Object.entries(parsed).filter(([key]) => !drop.has(key)))
  if (JSON.stringify(parsedObject(out)) !== JSON.stringify(expected)) {
    throw new Error('it could not be changed without changing the rest')
  }
  return { text: out, removed }
}

/**
 * Takes `keys` out of the JSON file, written to a file beside it and moved over it, so the file
 * is never half written. A link is followed, so the file it points at changes and the link stays.
 * Returns the keys it had; throws, changing nothing, when it is no JSON object or changed meanwhile.
 */
export async function editJsonKeys(file: string, keys: readonly string[]): Promise<string[]> {
  const target = (await lstat(file)).isSymbolicLink() ? await realpath(file) : file
  const before = await stat(target)
  const text = await readFile(target, 'utf8')
  const { text: next, removed } = removeJsonKeys(text, keys)
  if (removed.length === 0) return removed
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString('hex')}.kite-reset`,
  )
  await writeFile(temp, next, { encoding: 'utf8', mode: before.mode & 0o777, flag: 'wx' })
  try {
    const now = await stat(target)
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
      throw new Error('it changed while Kite read it')
    }
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  return removed
}
