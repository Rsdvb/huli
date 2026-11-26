// Huli: agents' terminals that sit idle. An agent's command runs in an interactive shell, which
// stays open after the command ends (on Windows it never exits by itself), so the terminals an
// agent opened pile up until their session is archived. The terminal host closes those that sit
// idle, as Settings › Terminal says, and notes what they last printed in the session's thread.

import type { BusyTerminal } from './host-control'

/** The choices of Settings › Terminal › Close idle agent terminals, in minutes; 0 is off. */
export const IDLE_TERMINAL_MINUTES = [0, 5, 10, 30] as const
export type IdleTerminalMinutes = (typeof IDLE_TERMINAL_MINUTES)[number]
export const DEFAULT_IDLE_TERMINAL_MINUTES: IdleTerminalMinutes = 10

export function isIdleTerminalMinutes(value: unknown): value is IdleTerminalMinutes {
  return (IDLE_TERMINAL_MINUTES as readonly unknown[]).includes(value)
}

/** Above this many agent terminals on a host, a new one checks for idle ones at once. */
export const AGENT_TERMINAL_CAP = 20

/**
 * How long an agent's terminal must have printed nothing before Close idle agent terminals in
 * the tab list closes it, whatever the setting: long enough that a command just typed has shown.
 */
export const MANUAL_IDLE_MS = 60_000

/** A terminal the host closed as idle, as the thread of its session notes it. */
export interface ClosedTerminal {
  /** The tab's name, or the command it ran. */
  title: string
  /** How long it had printed nothing. */
  idleMs: number
  /** The end of its output, as plain text. */
  output: string
}

export const MAX_CLOSED_TERMINALS = 50
export const MAX_CLOSED_TITLE = 200
export const MAX_CLOSED_OUTPUT = 2_000
/** How many of a closed terminal's last lines the thread keeps. */
export const CLOSED_OUTPUT_LINES = 8

/**
 * The closed terminals in a message from another process, or null when it is not a list of them
 * within the limits.
 */
export function parseClosedTerminals(value: unknown): ClosedTerminal[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CLOSED_TERMINALS) {
    return null
  }
  const closed: ClosedTerminal[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const { title, idleMs, output } = item as Record<string, unknown>
    if (typeof title !== 'string' || title.length === 0 || title.length > MAX_CLOSED_TITLE) {
      return null
    }
    if (typeof idleMs !== 'number' || !Number.isSafeInteger(idleMs) || idleMs < 0) return null
    if (typeof output !== 'string' || output.length > MAX_CLOSED_OUTPUT) return null
    closed.push({ title, idleMs, output })
  }
  return closed
}

/** A string cut to `max` characters from its end, which is the part a terminal last printed. */
export function keepEnd(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text
}

const OPENERS: readonly unknown[] = ['user', 'agent', 'reply']

/**
 * The terminals running a command in the terminal host's answer, each with the fields it names
 * correctly; one without its id, project or title is left out.
 */
export function parseBusyTerminals(value: unknown): BusyTerminal[] {
  if (!Array.isArray(value)) return []
  const terminals: BusyTerminal[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const { id, projectPath, title, sessionId, name, folder, opener, since } = item as Record<
      string,
      unknown
    >
    if (typeof id !== 'string' || typeof projectPath !== 'string' || typeof title !== 'string') {
      continue
    }
    terminals.push({
      id,
      projectPath,
      title,
      ...(typeof sessionId === 'string' || sessionId === null ? { sessionId } : {}),
      ...(typeof name === 'string' || name === null ? { name } : {}),
      ...(typeof folder === 'string' ? { folder } : {}),
      ...(OPENERS.includes(opener) ? { opener: opener as BusyTerminal['opener'] } : {}),
      ...((typeof since === 'number' && Number.isFinite(since)) || since === null ? { since } : {}),
    })
  }
  return terminals
}
