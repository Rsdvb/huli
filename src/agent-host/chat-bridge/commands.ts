// Huli: what a chat message asks of the bridge. A message that starts with `/` (or the `／` and
// `、` a Chinese keyboard types for it) and names a command is one; `//` sends the rest to the
// agent as written, for the agent's own slash commands; anything else is a message for the
// session. See tools/huli/README.md (Chat apps).

export type ChatCommand =
  | { kind: 'help' }
  | { kind: 'list' }
  /** `/s 3`: the third session of the last list; `/s` alone says which one is chosen. */
  | { kind: 'select'; index: number | null }
  /** `/new 2 1`: a new session in project 2 with agent 1; words name them too. */
  | { kind: 'new'; project: string | null; agent: string | null }
  | { kind: 'stop' }
  /** `/now text`: into the running turn now, steered where the agent can. */
  | { kind: 'now'; text: string }
  | { kind: 'allow' }
  | { kind: 'deny' }
  /** `/2`, `/1 3`, `/2 do it this way`: options of the request in front, and a note. */
  | { kind: 'pick'; choices: number[]; note: string }
  /** `/get 1`: the first artifact the last finished turn made, as a file. */
  | { kind: 'get'; index: number }
  | { kind: 'status' }
  | { kind: 'unknown'; name: string }
  | { kind: 'text'; text: string }

const NAMES: Readonly<Record<string, ChatCommand['kind']>> = {
  help: 'help',
  h: 'help',
  start: 'help',
  list: 'list',
  ls: 'list',
  l: 'list',
  s: 'select',
  session: 'select',
  new: 'new',
  stop: 'stop',
  now: 'now',
  y: 'allow',
  yes: 'allow',
  allow: 'allow',
  n: 'deny',
  no: 'deny',
  deny: 'deny',
  get: 'get',
  status: 'status',
}

const PREFIX = /^[/／、]/
const MAX_CHOICES = 20
const MAX_INDEX = 999

function index(word: string | undefined): number | null {
  if (word === undefined || !/^\d{1,3}$/.test(word)) return null
  const value = Number(word)
  return value >= 1 && value <= MAX_INDEX ? value : null
}

/**
 * The choices at the start of `rest`, `1 3` or `1,3`, and what follows them as the note; null
 * when it does not start with one.
 */
function choicesOf(rest: string): { choices: number[]; note: string } | null {
  const match =
    /^(\d{1,3}(?:[,、]\d{1,3})*(?:\s+\d{1,3}(?:[,、]\d{1,3})*)*)(?=\s|$)([\s\S]*)$/.exec(rest)
  if (!match) return null
  const choices = match[1]!.split(/[\s,、]+/).map(Number)
  if (choices.length > MAX_CHOICES || choices.some((n) => n < 1)) return null
  return { choices: [...new Set(choices)], note: match[2]!.trim() }
}

/** What the message asks; its text is as the platform gave it, with the bot's mention removed. */
export function parseCommand(raw: string): ChatCommand {
  const text = raw.trim()
  if (text.startsWith('//')) return { kind: 'text', text: text.slice(1) }
  if (!PREFIX.test(text)) return { kind: 'text', text }
  // Full-width digits and letters from a Chinese keyboard read as their ASCII forms.
  const body = text.slice(1).normalize('NFKC')
  const picked = choicesOf(body)
  if (picked) return { kind: 'pick', ...picked }
  const match = /^([A-Za-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(body)
  if (!match) {
    // A `、` that starts an ordinary sentence is no command.
    return text.startsWith('/')
      ? { kind: 'unknown', name: body.split(/\s/)[0] ?? '' }
      : { kind: 'text', text }
  }
  const name = match[1]!.toLowerCase()
  const rest = (match[2] ?? '').trim()
  const kind = NAMES[name]
  if (!kind) {
    return text.startsWith('/') ? { kind: 'unknown', name } : { kind: 'text', text }
  }
  const words = rest.split(/\s+/).filter(Boolean)
  switch (kind) {
    case 'select':
      return { kind, index: index(words[0]) }
    case 'new':
      return { kind, project: words[0] ?? null, agent: words.slice(1).join(' ') || null }
    case 'now':
      // The words after the command, with their own line breaks.
      return { kind, text: (match[2] ?? '').trim() }
    case 'get': {
      const n = index(words[0])
      return n === null ? { kind: 'unknown', name } : { kind, index: n }
    }
    case 'help':
    case 'list':
    case 'stop':
    case 'allow':
    case 'deny':
    case 'status':
      return { kind }
    default:
      return { kind: 'unknown', name }
  }
}
