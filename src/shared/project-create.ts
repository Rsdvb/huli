// Huli: a new project from Add project, a clone of a Git repository or an empty folder with Git.
// What the windows and the phone check as the user types; the agent host checks it all again, and
// the folder itself, before it runs anything.

/** The longest repository address taken. */
export const CLONE_URL_CHARS = 2_048
/** The longest folder name taken for a new project. */
export const PROJECT_NAME_CHARS = 100
/** A clone's id, which the client makes, for its progress and to cancel it. */
export const CLONE_ID = /^[0-9a-f]{32}$/

/**
 * Why an address is refused: `empty`, `tooLong`, `malformed` (spaces, control characters or no
 * repository), `option` (starts with `-`), `local` (a folder or `file://`), `scheme` (anything but
 * `https://`, `ssh://` and `user@host:path`, such as `ext::` or `http://`) and `password` (a
 * password in the address, which belongs in the computer's Git sign-in instead).
 */
export type CloneUrlProblem =
  'empty' | 'tooLong' | 'malformed' | 'option' | 'local' | 'scheme' | 'password'

// A host name or address: letters, digits, dots and hyphens starting with a letter or digit, or an
// IPv6 address in brackets. Nothing ssh could read as an option.
const HOST = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])$/
const PORT = /^\d{1,5}$/
// A URL's user name, percent-encoded as RFC 3986 allows, never starting with `-`.
const USER = /^[A-Za-z0-9._~%!$&'()*+,;=][A-Za-z0-9._~%!$&'()*+,;=-]*$/
// The scp-like form: user@host:path, the user and host as above.
const SCP = /^([A-Za-z0-9._][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9.-]*):(.+)$/

/** Why git would not be given this address to clone; null when it may. */
export function cloneUrlProblem(url: string): CloneUrlProblem | null {
  if (url === '') return 'empty'
  if (url.length > CLONE_URL_CHARS) return 'tooLong'
  if (url.startsWith('-')) return 'option'
  // `<transport>::<address>` runs a remote helper, such as ext:: and fd::.
  if (url.includes('::')) return 'scheme'
  if (/[\s\p{Cc}]/u.test(url)) return 'malformed'
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/.exec(url)
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase()
    if (protocol === 'file') return 'local'
    if (protocol !== 'https' && protocol !== 'ssh') return 'scheme'
    const authority = scheme[2]!
    const at = authority.lastIndexOf('@')
    if (at >= 0) {
      const user = authority.slice(0, at)
      if (user.includes(':')) return 'password'
      if (!USER.test(user)) return 'malformed'
    }
    const hostPort = authority.slice(at + 1)
    const port = /^(.*?)(?::([^:\]]*))?$/.exec(hostPort)!
    if (!HOST.test(port[1]!) || (port[2] !== undefined && !PORT.test(port[2]))) return 'malformed'
    const rest = scheme[3]!
    if (!rest.startsWith('/')) return 'malformed'
    return repoPath(rest) === null ? 'malformed' : null
  }
  if (isLocalPath(url)) return 'local'
  const scp = SCP.exec(url)
  if (!scp) return 'scheme'
  const path = scp[3]!
  if (path.startsWith('-') || repoPath(path) === null) return 'malformed'
  return null
}

function isLocalPath(value: string): boolean {
  return (
    /^[A-Za-z]:/.test(value) ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('.') ||
    value.startsWith('~')
  )
}

/** The repository's last path segment without `.git`, or null when there is none. */
function repoPath(value: string): string | null {
  const bare = value.replace(/[?#].*$/, '').replace(/[\\/]+$/, '')
  const last = bare.split(/[\\/:]/).pop() ?? ''
  const name = last.replace(/\.git$/i, '')
  return name === '' || name === '.' || name === '..' ? null : name
}

/** The address as it may be shown or logged: no password or token in it. */
export function cloneUrlShown(url: string): string {
  return withoutUrlCredentials(url)
}

/**
 * The text with every URL's sign-in taken out: `user:password@` anywhere, and an HTTP(S) URL's
 * user too, which may be a token. An SSH user without a password stays, as it is no secret.
 */
export function withoutUrlCredentials(text: string): string {
  return text.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/?#]*)@/g,
    (whole, prefix: string, user: string) => {
      if (/^ssh:\/\//i.test(prefix) && !user.includes(':')) return whole
      return prefix
    },
  )
}

/** A folder name from the repository's address, for the user to change; `project` for none. */
export function cloneFolderName(url: string): string {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(.*)$/.exec(url.trim())
  const scp = scheme ? null : /^[^@\s]+@[^:\s]+:(.+)$/.exec(url.trim())
  const found = repoPath(scheme?.[1] ?? scp?.[1] ?? '')
  return safeProjectName(found ?? '')
}

/** The name made one a project folder may take, never empty. */
export function safeProjectName(value: string): string {
  let name = value
    .replace(/[<>:"/\\|?*\p{Cc}]+/gu, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, PROJECT_NAME_CHARS)
    .replace(/[\s.]+$/, '')
  if (name === '') name = 'project'
  return projectNameProblem(name) === 'reserved' ? `${name}-project` : name
}

/**
 * Why a folder name is refused: `empty`, `tooLong`, `chars` (a separator, `<>:"|?*` or a control
 * character), `dots` (`.` or `..`), `edge` (spaces around it or a dot at its end, which Windows
 * drops) and `reserved` (a name Windows keeps for a device, such as `con` or `nul.txt`). Every
 * platform refuses them alike, so a project can move between computers.
 */
export type ProjectNameProblem = 'empty' | 'tooLong' | 'chars' | 'dots' | 'edge' | 'reserved'

const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i

export function projectNameProblem(name: string): ProjectNameProblem | null {
  if (name === '') return 'empty'
  if (name.length > PROJECT_NAME_CHARS) return 'tooLong'
  if (/[<>:"/\\|?*\p{Cc}]/u.test(name)) return 'chars'
  if (name === '.' || name === '..') return 'dots'
  if (name.trim() !== name || name.endsWith('.')) return 'edge'
  if (RESERVED.test(name)) return 'reserved'
  return null
}

/** The `.gitignore` files a new empty project may start with. */
export const GITIGNORE_PRESETS = ['general', 'node', 'python', 'go', 'rust'] as const
export type GitignorePreset = (typeof GITIGNORE_PRESETS)[number]

export function isGitignorePreset(value: unknown): value is GitignorePreset {
  return (GITIGNORE_PRESETS as readonly unknown[]).includes(value)
}

/**
 * A folder a new project may go in, as the host offers them: `last` the one the user last chose,
 * `home` the home folder and `project` the folder an existing project is in. A paired device
 * chooses among these alone.
 */
export interface ProjectPlace {
  path: string
  kind: 'last' | 'home' | 'project'
}

export interface ProjectPlaces {
  places: ProjectPlace[]
  /** The folder the user last made a project in, when it is still there. */
  last: string | null
}

/** The most places listed: the latest projects' folders first. */
export const MAX_PROJECT_PLACES = 12

export interface ProjectCloneParams {
  cloneId: string
  url: string
  /** The folder the clone goes in, one of `projects.places` for a paired device. */
  parent: string
  name: string
}

export interface ProjectCreateParams {
  parent: string
  name: string
  readme: boolean
  gitignore: GitignorePreset | null
}

/** What git says it is doing, as `--progress` names it. */
export type ClonePhase =
  'connecting' | 'counting' | 'compressing' | 'receiving' | 'resolving' | 'checkout'

export interface CloneProgress {
  cloneId: string
  phase: ClonePhase
  /** Of the phase, 0 to 100; null while git gives none. */
  percent: number | null
}
