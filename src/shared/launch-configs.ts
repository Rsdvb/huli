// Huli: Claude Code's launch configurations, `.claude/launch.json` in a project, which name the
// project's dev servers: a command (`runtimeExecutable` and `runtimeArgs`) and the port it serves
// on. Kite offers them as presets in the browser pane and the phone's dev servers: Start runs the
// command in a terminal of the session, and the page opens at the port.

export interface LaunchConfig {
  name: string
  /** The command line a terminal runs. */
  command: string
  port: number | null
  /** The address to open; null to open the port on localhost. */
  url: string | null
}

export const LAUNCH_FILE = '.claude/launch.json'
export const MAX_LAUNCH_CONFIGS = 20
const MAX_NAME = 100
const MAX_PART = 500
const MAX_ARGS = 50
const MAX_COMMAND = 2_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One line of text of at most `max` characters, trimmed; null for anything else. */
function line(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  // eslint-disable-next-line no-control-regex
  if (text === '' || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return null
  return text
}

/** An argument as a shell reads it back: quoted when it holds a space or a shell character. */
export function shellWord(word: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(word)) return word
  return `"${word.replace(/(["\\$`])/g, '\\$1')}"`
}

/** A local address a preset may open: http(s) on this computer only. */
function localUrl(value: unknown): string | null {
  const text = line(value, 2_000)
  const url = text ? URL.parse(text) : null
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const local =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  return local ? url.href : null
}

/**
 * The configurations a launch.json holds, each checked: a name, a command, and a port or a local
 * address. One that does not fit is left out, and at most MAX_LAUNCH_CONFIGS are kept.
 */
export function parseLaunchConfigs(raw: unknown): LaunchConfig[] {
  if (!isRecord(raw) || !Array.isArray(raw.configurations)) return []
  const configs: LaunchConfig[] = []
  for (const item of raw.configurations) {
    if (configs.length >= MAX_LAUNCH_CONFIGS) break
    if (!isRecord(item)) continue
    const name = line(item.name, MAX_NAME)
    if (!name) continue
    let command: string | null
    const executable = line(item.runtimeExecutable, MAX_PART)
    if (executable) {
      const args = Array.isArray(item.runtimeArgs) ? item.runtimeArgs.slice(0, MAX_ARGS) : []
      const words = args.map((arg) => line(arg, MAX_PART))
      if (words.some((word) => word === null)) continue
      command = [executable, ...(words as string[])].map(shellWord).join(' ')
    } else {
      command = line(item.command, MAX_COMMAND)
    }
    if (!command || command.length > MAX_COMMAND) continue
    const port =
      typeof item.port === 'number' &&
      Number.isInteger(item.port) &&
      item.port > 0 &&
      item.port < 65_536
        ? item.port
        : null
    const url = localUrl(item.url)
    if (port === null && url === null) continue
    configs.push({ name, command, port, url })
  }
  return configs
}

/** The address a preset opens. */
export function launchUrl(config: LaunchConfig): string {
  return config.url ?? `http://localhost:${config.port}/`
}

/** A host's answer to `sessions.launchConfigs`, checked; empty for an older host or anything else. */
export function parseLaunchAnswer(value: unknown): LaunchConfig[] {
  if (!isRecord(value) || !Array.isArray(value.configs)) return []
  return value.configs
    .filter(
      (config): config is LaunchConfig =>
        isRecord(config) &&
        line(config.name, MAX_NAME) !== null &&
        line(config.command, MAX_COMMAND) !== null &&
        (config.port === null ||
          (typeof config.port === 'number' &&
            Number.isInteger(config.port) &&
            config.port > 0 &&
            config.port < 65_536)) &&
        (config.url === null || localUrl(config.url) !== null),
    )
    .slice(0, MAX_LAUNCH_CONFIGS)
}
