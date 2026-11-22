// A secret an agent asks the user for through Kite's request_secrets tool: the fields its card
// shows, where the values go, and the checks the host and the clients share. Only names, labels
// and the target travel in the thread; a value goes from the card to its target and nowhere else.

/** An environment variable's name, as the card labels a field and the target receives it. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const MAX_SECRET_FIELDS = 8
export const MAX_SECRET_TITLE = 80
export const MAX_SECRET_LABEL = 80
export const MAX_SECRET_HINT = 200
export const MAX_SECRET_REASON = 600
export const MAX_SECRET_PATH = 200
export const MAX_SECRET_URL = 2048
/** The most a value may hold, in UTF-16 code units. */
export const MAX_SECRET_VALUE = 4096

/** One value the card asks for, by the variable it is delivered as. */
export interface SecretField {
  name: string
  label: string
  hint?: string
  /** Shown as typed, such as a user name; any other value is hidden until the user shows it. */
  plain?: true
  optional?: true
}

/**
 * Where the values go: the session's environment, which its later commands load, or a dotenv file
 * inside the session's folder, by its path from that folder with `/` between its parts.
 */
export type SecretTarget = { kind: 'env' } | { kind: 'file'; path: string }

/**
 * Names a secret may not take, since its file runs before every command: the shell's own, the
 * system's folders and the loaders a value there would hand the commands to.
 */
const RESERVED = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'PWD',
  'OLDPWD',
  'IFS',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'PROMPT_COMMAND',
  'BASH_ENV',
  'ENV',
  'CDPATH',
  'SHELLOPTS',
  'BASHOPTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'RUBYOPT',
  'CLAUDE_ENV_FILE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
])

/** Why a name cannot carry a secret, or null when it can. */
export function secretNameProblem(name: string): string | null {
  if (!SECRET_NAME.test(name)) {
    return 'must be a variable name: a letter or _, then letters, digits or _, at most 64'
  }
  const upper = name.toUpperCase()
  if (RESERVED.has(upper) || /^(LD_|DYLD_|BASH_FUNC_)/.test(upper)) {
    return 'is a name the shell or the system uses; pick a name of the tool’s own'
  }
  return null
}

// A dotenv file by its usual names: `.env`, `.env.local`, `.env.production.local`, `app.env`
// and Wrangler's `.dev.vars`.
const DOTENV_NAME = /^(?:\.env(?:\.[A-Za-z0-9_-]+)*|[A-Za-z0-9_-]+\.env|\.dev\.vars)$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * The path a file target names, from the session's folder with `/` between its parts, or why it
 * cannot be one: it stays inside the folder, outside `.git`, and names a dotenv file.
 */
export function secretPath(raw: string): { path: string } | { problem: string } {
  const text = raw.trim().replace(/\\/g, '/')
  if (text.length === 0 || text.length > MAX_SECRET_PATH || CONTROL.test(text)) {
    return { problem: `must be a path of 1 to ${MAX_SECRET_PATH} characters` }
  }
  if (text.startsWith('/') || text.startsWith('~') || /^[A-Za-z]:/.test(text)) {
    return { problem: 'must be relative to the session’s folder, such as .env.local' }
  }
  const parts = text.replace(/^\.\//, '').split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return { problem: 'must stay inside the session’s folder, without . or .. parts' }
  }
  if (parts.some((part) => part.toLowerCase() === '.git')) {
    return { problem: 'must not be inside .git' }
  }
  if (!DOTENV_NAME.test(parts[parts.length - 1]!)) {
    return { problem: 'must name a dotenv file, such as .env, .env.local or app.env' }
  }
  return { path: parts.join('/') }
}

/** Why a value cannot go, or null; the value is checked as the user typed it, then trimmed. */
export function secretValueProblem(value: string): 'empty' | 'long' | 'line' | null {
  const text = value.trim()
  if (text.length === 0) return 'empty'
  if (text.length > MAX_SECRET_VALUE) return 'long'
  // One line: a value with a line break would start another variable in its file.
  if (CONTROL.test(text)) return 'line'
  return null
}

/** A dotenv file's line for a value: bare when plain, else quoted so no reader expands it. */
export function dotenvLine(name: string, value: string): string | null {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(value)) return `${name}=${value}`
  if (!value.includes("'")) return `${name}='${value}'`
  // Double quotes keep a single quote; the readers expand `\n` and `${}` there, so neither may be.
  if (!/["\\$`]/.test(value)) return `${name}="${value}"`
  return null
}

/** The http(s) page a card may open for getting the value, or null for anything else. */
export function secretPageUrl(value: string): string | null {
  const text = value.trim()
  if (text.length === 0 || text.length > MAX_SECRET_URL) return null
  const url = URL.parse(text)
  return url && (url.protocol === 'https:' || url.protocol === 'http:') && url.host !== ''
    ? url.href
    : null
}
