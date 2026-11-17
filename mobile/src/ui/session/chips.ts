// What in a sent prompt's text reads as a chip, as the desktop's composer/chips.ts finds them: the
// command it starts with, `@` mentions of attached or project files, and links. Chips are only how
// the text looks; the text is what was sent.

export interface MentionTarget {
  kind: 'file' | 'folder' | 'image'
  /** The attachment it stands for, when one has its name. */
  attachmentId?: string
  /** The path relative to the project, when the project has it. */
  path?: string
}

export type Chip =
  | ({
      kind: 'file' | 'folder' | 'image'
      from: number
      to: number
      label: string
      /** The lines it names, as `41–44`. */
      lines: string | null
    } & MentionTarget)
  | { kind: 'link'; from: number; to: number; url: string; host: string; path: string }

// A mention starts at a space, the start, or text outside ASCII such as Chinese, and ends at a
// space or CJK punctuation.
const MENTION =
  /(^|\s|[\x80-\uffff])[@＠]([^\s\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+)/g
const URL_TEXT = /https?:\/\/[^\s<>"'`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g
const TRAILING = /[.,;:!?)\]}>'"。，；：！？）、]+$/
const SENTENCE_END = /[.,;:!?>'"]/
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
const RANGE = /(?::(\d+)(?:[-–](\d+))?|#L(\d+)(?:-L?(\d+))?)$/

/** The length of the command the text starts with: `/` and one of the names, then a space. */
export function leadingCommand(text: string, names: readonly string[]): number {
  const match = /^\/(\S+)(?=[ \n]|$)/.exec(text)
  return match && names.includes(match[1]!) ? match[0].length : 0
}

/** A mention's name and the lines after it: `usage-store.ts:41-44` is the file and `41–44`. */
export function splitLines(token: string): { name: string; lines: string | null } {
  const match = RANGE.exec(token)
  if (!match || match.index === 0) return { name: token, lines: null }
  const start = match[1] ?? match[3]!
  const end = match[2] ?? match[4]
  const lines = end && end !== start ? `${start}–${end}` : start
  return { name: token.slice(0, match.index), lines }
}

const count = (text: string, char: string) => text.split(char).length - 1

function trimLink(url: string): string {
  let end = url.length
  for (;;) {
    const last = url[end - 1] ?? ''
    const kept = url.slice(0, end)
    if (SENTENCE_END.test(last)) end--
    else if (last in OPENER && count(kept, OPENER[last]!) < count(kept, last)) end--
    else return kept
  }
}

function linkParts(url: string): { host: string; path: string } | null {
  const match = /^https?:\/\/([^/?#]+)([\s\S]*)$/i.exec(url)
  if (!match || !match[1]) return null
  const path = match[2] ?? ''
  return { host: match[1], path: path === '/' ? '' : path }
}

function resolveMention(token: string, resolve: (token: string) => MentionTarget | null) {
  for (const candidate of new Set([token, token.replace(TRAILING, '')])) {
    if (!candidate) continue
    const { name, lines } = splitLines(candidate)
    const target = resolve(name)
    if (target) return { token: candidate, name, lines, target }
  }
  return null
}

/** Every mention and link in the text, in order. */
export function findChips(text: string, resolve: (token: string) => MentionTarget | null): Chip[] {
  const chips: Chip[] = []
  for (const match of text.matchAll(MENTION)) {
    const from = match.index + match[1]!.length
    const found = resolveMention(match[2]!, resolve)
    if (!found) continue
    const { token, name, lines, target } = found
    const label =
      target.kind === 'folder'
        ? name.endsWith('/')
          ? name
          : `${name}/`
        : name.slice(name.lastIndexOf('/') + 1)
    chips.push({ ...target, from, to: from + 1 + token.length, label, lines })
  }
  const taken = (from: number, to: number) => chips.some((c) => from < c.to && to > c.from)
  for (const match of text.matchAll(URL_TEXT)) {
    const url = trimLink(match[0])
    const parts = linkParts(url)
    const from = match.index
    const to = from + url.length
    if (parts && !taken(from, to)) chips.push({ kind: 'link', from, to, url, ...parts })
  }
  return chips.sort((a, b) => a.from - b.from)
}

/**
 * Resolves a mention against the attachments first, by the name it is written as, then against
 * the project's files and folders by path.
 */
export function mentionResolver(
  attachments: readonly { id: string; name: string; type: string }[],
  project: { files: ReadonlySet<string>; folders: ReadonlySet<string> } | null,
): (token: string) => MentionTarget | null {
  return (token) => {
    const item = attachments.find(
      (a) =>
        a.type !== 'text' &&
        ((a.type === 'folder' ? `${a.name}/` : a.name) === token || a.name === token),
    )
    if (item) {
      const kind = item.type === 'folder' ? 'folder' : item.type === 'image' ? 'image' : 'file'
      return { kind, attachmentId: item.id }
    }
    if (!project) return null
    const path = token.replace(/^\.\//, '')
    if (project.files.has(path)) return { kind: 'file', path }
    const folder = path.endsWith('/') ? path : `${path}/`
    if (project.folders.has(folder)) return { kind: 'folder', path: folder.slice(0, -1) }
    return null
  }
}
