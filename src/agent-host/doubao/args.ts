// The command lines Kettu runs Doubao CLI with. Its native options, such as `-C`, must come before
// the first business argument, and the prompt always goes on stdin (`-p -`), never on the command
// line, where cmd.exe would read it when the npm launcher runs.

/** Doubao CLI's permission modes, from the narrowest. */
export const MODES = ['ask_always', 'ask_risky', 'always_allow'] as const
export type Mode = (typeof MODES)[number]

export const DEFAULT_MODE: Mode = 'ask_always'

export function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value)
}

/** The reasoning levels `--effort` takes; each model offers some of them. */
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** The largest prompt `-p -` reads from stdin, in bytes of UTF-8. */
export const PROMPT_BYTES = 1024 * 1024

// Conversation ids are numbers; models and cursors are words of letters, digits and dashes that
// start with neither a dash nor a dot. Each is checked, so that nothing a listing or a stored
// record holds can read as an option.
const ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/
const MODEL = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/
const CURSOR = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,511}$/

export function isConversationId(value: string): boolean {
  return ID.test(value)
}

export interface TurnOptions {
  /** The folder the session runs in, which is also its workspace. */
  cwd: string
  /** The conversation to continue, or null for a new one. */
  resume: string | null
  model: string | null
  effort: string | null
  mode: Mode
}

function checked(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new Error(`Doubao CLI was given an unusable ${what}`)
  return value
}

/** One turn: the prompt comes on stdin, and its events as stream-json on stdout. */
export function turnArgs(options: TurnOptions): string[] {
  const args = ['-C', options.cwd]
  if (options.resume !== null) args.push('--resume', checked(options.resume, ID, 'session id'))
  args.push('-p', '-', '--output-format', 'stream-json')
  if (options.model !== null) args.push('--model', checked(options.model, MODEL, 'model'))
  if (options.effort !== null) {
    if (!(EFFORTS as readonly string[]).includes(options.effort)) {
      throw new Error('Doubao CLI was given an unusable reasoning level')
    }
    args.push('--effort', options.effort)
  }
  args.push('--permission-mode', options.mode)
  return args
}

/** Every unarchived conversation of the account, from every folder and device. */
export const LIST_ALL_ARGS: readonly string[] = ['--list', '--all', '--json']

/** One page of the most recent conversations. */
export function listArgs(limit: number, cursor: string | null): string[] {
  const args = ['--list', '--limit', String(Math.max(1, Math.floor(limit))), '--json']
  if (cursor !== null) args.push('--cursor', checked(cursor, CURSOR, 'cursor'))
  return args
}

/** A conversation's history as `[{query, response}]`. */
export function exportArgs(conversation: string): string[] {
  return ['--export', checked(conversation, ID, 'session id')]
}

export const MODEL_LIST_ARGS: readonly string[] = ['model', 'list', '--json']
export const AUTH_STATUS_ARGS: readonly string[] = ['auth', 'status']
/** The terminal's QR code needs 60 columns; the picture's path comes as `QR_IMAGE=<path>`. */
export const LOGIN_ARGS: readonly string[] = ['login', '--qr=png']
export const LOGOUT_ARGS: readonly string[] = ['logout']

/**
 * Variables every run gets: the npm launcher, when it is what runs because the native program is
 * missing, never asks the network for an update or stops to offer one on stdin.
 */
export const RUN_ENV: Readonly<Record<string, string>> = { DOUBAO_CLI_NO_UPDATE_CHECK: '1' }
