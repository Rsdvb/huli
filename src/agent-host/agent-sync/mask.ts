// Huli: what keeps a server's secrets off the page. The values of env and headers never leave the
// host whole; what looks like a secret in a command line or a URL is masked too; and a preview's
// lines are masked by every secret value the files hold, as written in JSON or TOML.

import type { NeutralServer } from './formats'

const DOTS = '••••'
/** Names of keys whose values are secrets wherever they appear in a file. */
const SECRET_NAME = /(key|token|secret|passw(or)?d|auth|bearer|cookie|credential|session)/i
/** A flag whose next argument is a secret, or which carries one after `=`. */
const SECRET_FLAG = /^--?[\w-]*(key|token|secret|passw(or)?d|auth|bearer|credential)[\w-]*$/i

/** A secret as the page shows it: its last four characters at most, and only of a long one. */
export function maskValue(value: string): string {
  if (value === '') return ''
  return value.length >= 16 ? `${DOTS}${value.slice(-4)}` : DOTS
}

/** The URL with its password and query values masked. */
export function maskUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.password) parsed.password = 'xxxx'
  for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, 'xxxx')
  return parsed.toString().replace(/xxxx/g, DOTS)
}

/** The secrets in a command line: values after a secret flag, or after its `=`. */
function argSecrets(args: readonly string[]): string[] {
  const out: string[] = []
  args.forEach((arg, index) => {
    const eq = arg.indexOf('=')
    if (eq > 0 && SECRET_FLAG.test(arg.slice(0, eq))) out.push(arg.slice(eq + 1))
    else if (SECRET_FLAG.test(arg) && index + 1 < args.length) out.push(args[index + 1]!)
  })
  return out.filter((value) => value.length >= 4)
}

/** Every value of `server` the page must not show whole. */
export function secretsOf(server: NeutralServer): string[] {
  const out = [...Object.values(server.env), ...Object.values(server.headers)]
  out.push(...argSecrets(server.args))
  try {
    const url = new URL(server.url)
    if (url.password) out.push(decodeURIComponent(url.password), url.password)
    for (const value of url.searchParams.values()) out.push(value)
  } catch {
    // Not a URL: nothing in it to mask.
  }
  return out.filter((value) => value.length >= 4)
}

/** The command line or URL as the page shows it. */
export function targetOf(server: NeutralServer): string {
  if (server.transport !== 'stdio') return maskUrl(server.url)
  const secrets = new Set(argSecrets(server.args))
  const words = [server.command, ...server.args].map((word) => {
    for (const secret of secrets) if (word.includes(secret)) return word.split(secret).join(DOTS)
    return word
  })
  return words.map((word) => (/\s/.test(word) ? JSON.stringify(word) : word)).join(' ')
}

/** The forms a value takes in the files: as it is, and escaped in JSON and TOML strings. */
function forms(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1)
  return json === value ? [value] : [value, json]
}

/** A line of a file with the secrets in it masked. */
export function maskLine(line: string, secrets: readonly string[]): string {
  let out = line
  // The longest first, so a secret that holds another is masked whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    for (const form of forms(secret)) {
      if (form.length >= 4 && out.includes(form)) out = out.split(form).join(maskValue(secret))
    }
  }
  // A line that sets a secret-named key, as in JSON or TOML, whatever its value.
  return out.replace(
    /^(\s*"?([\w.-]+)"?\s*[:=]\s*)(["'])(.*)\3(\s*,?\s*)$/,
    (whole, lead: string, name: string, quote: string, value: string, tail: string) =>
      SECRET_NAME.test(name) && value !== '' && !value.startsWith(DOTS)
        ? `${lead}${quote}${maskValue(value)}${quote}${tail}`
        : whole,
  )
}

/** The values a JSON or TOML text sets under keys named like secrets, to mask beside a server's. */
export function namedSecrets(entries: readonly [string, unknown][]): string[] {
  const out: string[] = []
  const visit = (key: string, value: unknown): void => {
    if (typeof value === 'string') {
      if (SECRET_NAME.test(key) && value.length >= 4) out.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) visit(key, item)
    } else if (typeof value === 'object' && value !== null) {
      for (const [inner, item] of Object.entries(value)) visit(inner, item)
    }
  }
  for (const [key, value] of entries) visit(key, value)
  return out
}
