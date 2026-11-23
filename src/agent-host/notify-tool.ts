// Huli: the notify tool of the artifacts service. An agent tells the user something they asked to
// hear about, or that long work finished, as a desktop notification and a phone push: the host
// raises it as the session's attention, so the app's notification settings and each phone's muted
// sessions decide where it shows, as for a turn that ended. The text is plain and short, and a
// session may send only a few a minute and an hour.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Caller } from './artifacts/tools'

export const NOTIFY_TOOL = 'notify'
export const NOTE_TITLE_CHARS = 80
export const NOTE_BODY_CHARS = 300

/** How many notes one session may send within each window. */
export const NOTE_LIMITS: readonly { windowMs: number; max: number }[] = [
  { windowMs: 60_000, max: 3 },
  { windowMs: 60 * 60_000, max: 30 },
]

export const NOTIFY_TOOLS: Tool[] = [
  {
    name: NOTIFY_TOOL,
    title: 'Notify the user',
    description:
      'Shows the user a desktop notification and a phone push from this session. Use it only ' +
      'when the user asked to be told about something, or when long work they are waiting for ' +
      'finishes; never for progress updates or questions. Plain text, no Markdown. A session ' +
      'may send 3 a minute and 30 an hour.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: NOTE_TITLE_CHARS,
          description: 'One short line, such as "Build finished".',
        },
        body: {
          type: 'string',
          maxLength: NOTE_BODY_CHARS,
          description: 'A sentence or two of detail.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]

export function isNotifyToolName(name: string): boolean {
  return name === NOTIFY_TOOL
}

// Control characters, and the marks that reorder or hide text, as a notification would show them.
const HIDDEN_RANGES: readonly [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
]
const HIDDEN = new RegExp(
  `[${HIDDEN_RANGES.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`,
  'g',
)

/** Text as a notification shows it: one line of plain characters, at most `max` of them. */
export function plainNote(text: string, max: number): string {
  const line = text.replace(HIDDEN, '').replace(/\s+/g, ' ').trim()
  const chars = [...line]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line
}

export interface Note {
  title: string
  body: string
}

export class NotifyToolError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'limited',
    message: string,
  ) {
    super(message)
    this.name = 'NotifyToolError'
  }
}

/** The note a call carries, checked and made plain; a title or body too long is cut. */
export function parseNote(input: unknown): Note {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new NotifyToolError('invalid', 'The arguments must be an object with a title.')
  }
  const fields = input as Record<string, unknown>
  const unknown = Object.keys(fields).find((key) => key !== 'title' && key !== 'body')
  if (unknown !== undefined) throw new NotifyToolError('invalid', `Unknown argument ${unknown}.`)
  if (typeof fields.title !== 'string') {
    throw new NotifyToolError('invalid', 'title must be a string.')
  }
  if (fields.body !== undefined && typeof fields.body !== 'string') {
    throw new NotifyToolError('invalid', 'body must be a string.')
  }
  const title = plainNote(fields.title, NOTE_TITLE_CHARS)
  if (title === '') throw new NotifyToolError('invalid', 'title must not be empty.')
  return { title, body: plainNote(fields.body ?? '', NOTE_BODY_CHARS) }
}

/**
 * The notes each session sent within the longest window, newest last. Nothing runs between calls:
 * each one drops what has aged out, and the sessions with nothing left.
 */
export class NoteLimiter {
  private readonly sent = new Map<string, number[]>()
  private readonly longest: number

  constructor(
    private readonly limits = NOTE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.longest = Math.max(...limits.map((limit) => limit.windowMs))
  }

  /** Counts a note of the session's when it is within every limit; else how long until it is. */
  take(sessionId: string): { ok: true } | { ok: false; retryMs: number } {
    const now = this.now()
    for (const [id, times] of this.sent) {
      const kept = times.filter((at) => now - at < this.longest)
      if (kept.length === 0) this.sent.delete(id)
      else if (kept.length !== times.length) this.sent.set(id, kept)
    }
    const times = this.sent.get(sessionId) ?? []
    let retryMs = 0
    for (const { windowMs, max } of this.limits) {
      const inWindow = times.filter((at) => now - at < windowMs)
      if (inWindow.length >= max) {
        retryMs = Math.max(retryMs, inWindow[inWindow.length - max]! + windowMs - now)
      }
    }
    if (retryMs > 0) return { ok: false, retryMs }
    this.sent.set(sessionId, [...times, now])
    return { ok: true }
  }
}

export interface NotifyToolsDeps {
  /** Raises the note as the session's attention; `none` for a session Kettu does not hold. */
  notify(sessionId: string, note: Note): 'sent' | 'none'
  now?: () => number
}

export class NotifyTools {
  private readonly limiter: NoteLimiter

  constructor(private readonly deps: NotifyToolsDeps) {
    this.limiter = new NoteLimiter(NOTE_LIMITS, deps.now)
  }

  /** Serves a call; a refusal becomes a tool error whose text says why. */
  call(caller: Caller, name: string, input: unknown): CallToolResult {
    if (name !== NOTIFY_TOOL) throw new Error(`Unknown tool ${name}`)
    try {
      const note = parseNote(input)
      const taken = this.limiter.take(caller.sessionId)
      if (!taken.ok) {
        const seconds = Math.ceil(taken.retryMs / 1000)
        throw new NotifyToolError(
          'limited',
          `This session sent too many notifications. Wait ${seconds} s, and send one only when ` +
            'the user asked to be told or long work finished.',
        )
      }
      if (this.deps.notify(caller.sessionId, note) === 'none') {
        throw new NotifyToolError('not_found', 'This session is not open, so it sends nothing.')
      }
      return {
        content: [
          {
            type: 'text',
            text: "Sent. It shows where the user's notification settings allow; do not send it again.",
          },
        ],
      }
    } catch (error) {
      if (!(error instanceof NotifyToolError)) throw error
      return {
        content: [{ type: 'text', text: error.message }],
        structuredContent: { code: error.code, message: error.message },
        isError: true,
      }
    }
  }
}
