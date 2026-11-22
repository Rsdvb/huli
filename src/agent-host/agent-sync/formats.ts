// Huli: how each agent writes an MCP server in its own file, as its docs give the fields (Claude
// Code's, Codex's, Gemini CLI's, OpenCode's and the others' MCP pages, checked 2026-11), and the
// one shape Agent sync converts through. A server copied to an agent of the same format goes
// over as it is; to another it goes through that shape, and the fields it cannot carry are named.

import type { SyncFormat, SyncTransport } from '@shared/agent-sync'

/** A server in the shape every format converts through. */
export interface NeutralServer {
  transport: SyncTransport
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string | null
  url: string
  headers: Record<string, string>
  enabled: boolean
}

/** A native entry read: the server, the native fields it leaves out, or why it cannot be read. */
export type ReadServer =
  | { ok: true; server: NeutralServer; extras: string[] }
  | { ok: false; reason: 'unknown-transport' | 'not-object' }

export interface FormatCodec {
  kind: 'json' | 'toml'
  transports: readonly SyncTransport[]
  /** A remote server is only its URL, the agent finding out whether it speaks SSE. */
  remoteAuto: boolean
  read(entry: unknown): ReadServer
  write(server: NeutralServer): Record<string, unknown>
  /** The fields of `server` this format cannot carry. */
  loses(server: NeutralServer): string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item)
  }
  return out
}

const empty = (map: Record<string, string>): boolean => Object.keys(map).length === 0

function base(transport: SyncTransport): NeutralServer {
  return {
    transport,
    command: '',
    args: [],
    env: {},
    cwd: null,
    url: '',
    headers: {},
    enabled: true,
  }
}

/** The native fields beyond `known`, which the shape does not carry. */
function extrasOf(entry: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(entry).filter((key) => !known.includes(key))
}

function lossOf(
  server: NeutralServer,
  takes: { cwd: boolean; disabled: boolean; headers: boolean },
): string[] {
  const lost: string[] = []
  if (server.transport === 'stdio' && server.cwd && !takes.cwd) lost.push('cwd')
  if (!server.enabled && !takes.disabled) lost.push('enabled')
  if (server.transport !== 'stdio' && !empty(server.headers) && !takes.headers) lost.push('headers')
  return lost
}

/**
 * The formats that keep `mcpServers` with a `type` per server: Claude Code, Copilot CLI, Droid,
 * Qoder CLI and Pi, each with its own names for a transport and its own extra fields.
 */
function typed(options: {
  stdio: string
  transports: readonly SyncTransport[]
  /** The type an entry with a URL and no type has; null when it is no server then. */
  untypedUrl: SyncTransport | null
  cwd: boolean
  disabled: boolean
  /** Fields every written entry carries, as Copilot's `tools`. */
  fixed?: Record<string, unknown>
}): FormatCodec {
  const known = [
    'type',
    'command',
    'args',
    'env',
    'url',
    'headers',
    ...(options.cwd ? ['cwd'] : []),
    ...(options.disabled ? ['disabled'] : []),
    ...Object.keys(options.fixed ?? {}),
  ]
  return {
    kind: 'json',
    transports: options.transports,
    remoteAuto: false,
    read(entry) {
      if (!isRecord(entry)) return { ok: false, reason: 'not-object' }
      const type = text(entry.type).toLowerCase()
      let transport: SyncTransport | null
      if (type === '' || type === 'stdio' || type === 'local') {
        transport = type === '' && entry.command === undefined ? options.untypedUrl : 'stdio'
      } else if (type === 'http' || type === 'streamable-http' || type === 'streamablehttp') {
        transport = 'http'
      } else if (type === 'sse') {
        transport = 'sse'
      } else {
        transport = null
      }
      if (transport === null) return { ok: false, reason: 'unknown-transport' }
      const server = base(transport)
      if (transport === 'stdio') {
        server.command = text(entry.command)
        server.args = strings(entry.args)
        server.env = stringMap(entry.env)
        server.cwd = options.cwd && typeof entry.cwd === 'string' ? entry.cwd : null
      } else {
        server.url = text(entry.url)
        server.headers = stringMap(entry.headers)
      }
      if (transport !== 'stdio' && server.url === '')
        return { ok: false, reason: 'unknown-transport' }
      if (options.disabled) server.enabled = entry.disabled !== true
      return { ok: true, server, extras: extrasOf(entry, known) }
    },
    write(server) {
      const out: Record<string, unknown> =
        server.transport === 'stdio'
          ? {
              type: options.stdio,
              command: server.command,
              args: [...server.args],
              env: { ...server.env },
              ...(options.cwd && server.cwd ? { cwd: server.cwd } : {}),
            }
          : {
              type: server.transport,
              url: server.url,
              ...(empty(server.headers) ? {} : { headers: { ...server.headers } }),
            }
      if (options.disabled && !server.enabled) out.disabled = true
      return { ...out, ...options.fixed }
    },
    loses: (server) =>
      lossOf(server, { cwd: options.cwd, disabled: options.disabled, headers: true }),
  }
}

/** Cursor and Amp: `mcpServers` with no type, a URL standing for a remote server. */
function untyped(transports: readonly SyncTransport[]): FormatCodec {
  return {
    kind: 'json',
    transports,
    remoteAuto: true,
    read(entry) {
      if (!isRecord(entry)) return { ok: false, reason: 'not-object' }
      const type = text(entry.type)
      if (typeof entry.command === 'string' && (type === '' || type === 'stdio')) {
        const server = base('stdio')
        server.command = entry.command
        server.args = strings(entry.args)
        server.env = stringMap(entry.env)
        return { ok: true, server, extras: extrasOf(entry, ['type', 'command', 'args', 'env']) }
      }
      if (typeof entry.url === 'string') {
        const server = base(type === 'sse' ? 'sse' : 'http')
        server.url = entry.url
        server.headers = stringMap(entry.headers)
        return { ok: true, server, extras: extrasOf(entry, ['type', 'url', 'headers']) }
      }
      return { ok: false, reason: 'unknown-transport' }
    },
    write(server) {
      if (server.transport === 'stdio') {
        return {
          command: server.command,
          args: [...server.args],
          ...(empty(server.env) ? {} : { env: { ...server.env } }),
        }
      }
      return {
        url: server.url,
        ...(empty(server.headers) ? {} : { headers: { ...server.headers } }),
      }
    },
    loses: (server) => lossOf(server, { cwd: false, disabled: false, headers: true }),
  }
}

/** Gemini CLI and Qwen Code: `httpUrl` for streamable HTTP, `url` for SSE unless typed. */
function geminiLike(typedUrl: boolean): FormatCodec {
  const known = ['command', 'args', 'env', 'cwd', 'url', 'httpUrl', 'headers', 'type']
  return {
    kind: 'json',
    transports: ['stdio', 'http', 'sse'],
    remoteAuto: false,
    read(entry) {
      if (!isRecord(entry)) return { ok: false, reason: 'not-object' }
      const extras = extrasOf(entry, known)
      if (typeof entry.command === 'string') {
        const server = base('stdio')
        server.command = entry.command
        server.args = strings(entry.args)
        server.env = stringMap(entry.env)
        server.cwd = typeof entry.cwd === 'string' ? entry.cwd : null
        return { ok: true, server, extras }
      }
      const type = text(entry.type)
      let server: NeutralServer
      if (typeof entry.httpUrl === 'string') {
        server = base('http')
        server.url = entry.httpUrl
      } else if (typeof entry.url === 'string') {
        // Gemini CLI tries streamable HTTP first for an untyped URL; Qwen Code takes it as SSE.
        server = base(type === 'sse' || (!typedUrl && type !== 'http') ? 'sse' : 'http')
        server.url = entry.url
      } else {
        return { ok: false, reason: 'unknown-transport' }
      }
      server.headers = stringMap(entry.headers)
      return { ok: true, server, extras }
    },
    write(server) {
      if (server.transport === 'stdio') {
        return {
          command: server.command,
          args: [...server.args],
          ...(empty(server.env) ? {} : { env: { ...server.env } }),
          ...(server.cwd ? { cwd: server.cwd } : {}),
        }
      }
      const headers = empty(server.headers) ? {} : { headers: { ...server.headers } }
      if (server.transport === 'http') {
        return typedUrl
          ? { url: server.url, type: 'http', ...headers }
          : { httpUrl: server.url, ...headers }
      }
      return typedUrl
        ? { url: server.url, type: 'sse', ...headers }
        : { url: server.url, ...headers }
    },
    loses: (server) => lossOf(server, { cwd: true, disabled: false, headers: true }),
  }
}

/**
 * OpenCode and Kilo: `local` with the command as one array and `environment`, or `remote`. Kilo
 * and OpenCode's older form switch a server with `enabled`, OpenCode's `mcp.servers` with
 * `disabled`.
 */
function opencodeLike(form: 'enabled' | 'disabled'): FormatCodec {
  const known = ['type', 'command', 'environment', 'url', 'headers', 'cwd', 'enabled', 'disabled']
  return {
    kind: 'json',
    transports: ['stdio', 'http', 'sse'],
    remoteAuto: true,
    read(entry) {
      if (!isRecord(entry)) return { ok: false, reason: 'not-object' }
      let server: NeutralServer
      if (entry.type === 'local') {
        const command = strings(entry.command)
        server = base('stdio')
        server.command = command[0] ?? ''
        server.args = command.slice(1)
        server.env = stringMap(entry.environment)
        server.cwd = form === 'disabled' && typeof entry.cwd === 'string' ? entry.cwd : null
      } else if (entry.type === 'remote') {
        server = base('http')
        server.url = text(entry.url)
        server.headers = stringMap(entry.headers)
      } else {
        return { ok: false, reason: 'unknown-transport' }
      }
      server.enabled = form === 'enabled' ? entry.enabled !== false : entry.disabled !== true
      const extras = extrasOf(entry, known).concat(
        form === 'enabled' && typeof entry.cwd === 'string' ? ['cwd'] : [],
      )
      return { ok: true, server, extras }
    },
    write(server) {
      const out: Record<string, unknown> =
        server.transport === 'stdio'
          ? {
              type: 'local',
              command: [server.command, ...server.args],
              ...(empty(server.env) ? {} : { environment: { ...server.env } }),
              ...(form === 'disabled' && server.cwd ? { cwd: server.cwd } : {}),
            }
          : {
              type: 'remote',
              url: server.url,
              ...(empty(server.headers) ? {} : { headers: { ...server.headers } }),
            }
      if (form === 'enabled') out.enabled = server.enabled
      else if (!server.enabled) out.disabled = true
      return out
    },
    loses: (server) => lossOf(server, { cwd: form === 'disabled', disabled: true, headers: true }),
  }
}

/** Codex: `[mcp_servers.<name>]` in config.toml, with no SSE. */
const codex: FormatCodec = {
  kind: 'toml',
  transports: ['stdio', 'http'],
  remoteAuto: false,
  read(entry) {
    if (!isRecord(entry)) return { ok: false, reason: 'not-object' }
    let server: NeutralServer
    let known: string[]
    if (typeof entry.command === 'string') {
      server = base('stdio')
      server.command = entry.command
      server.args = strings(entry.args)
      server.env = stringMap(entry.env)
      server.cwd = typeof entry.cwd === 'string' ? entry.cwd : null
      known = ['command', 'args', 'env', 'cwd', 'enabled']
    } else if (typeof entry.url === 'string') {
      server = base('http')
      server.url = entry.url
      server.headers = stringMap(entry.http_headers)
      known = ['url', 'http_headers', 'enabled']
    } else {
      return { ok: false, reason: 'unknown-transport' }
    }
    server.enabled = entry.enabled !== false
    return { ok: true, server, extras: extrasOf(entry, known) }
  },
  write(server) {
    const out: Record<string, unknown> =
      server.transport === 'stdio'
        ? {
            command: server.command,
            ...(server.args.length > 0 ? { args: [...server.args] } : {}),
            ...(server.cwd ? { cwd: server.cwd } : {}),
            ...(empty(server.env) ? {} : { env: { ...server.env } }),
          }
        : {
            url: server.url,
            ...(empty(server.headers) ? {} : { http_headers: { ...server.headers } }),
          }
    if (!server.enabled) out.enabled = false
    return out
  },
  loses: (server) => lossOf(server, { cwd: true, disabled: true, headers: true }),
}

export const CODECS: Record<SyncFormat, FormatCodec> = {
  claude: typed({
    stdio: 'stdio',
    transports: ['stdio', 'http', 'sse'],
    untypedUrl: null,
    cwd: false,
    disabled: false,
  }),
  codex,
  gemini: geminiLike(true),
  qwen: geminiLike(false),
  opencode: opencodeLike('enabled'),
  'opencode-v2': opencodeLike('disabled'),
  kilo: opencodeLike('enabled'),
  copilot: typed({
    stdio: 'local',
    transports: ['stdio', 'http', 'sse'],
    untypedUrl: 'http',
    cwd: false,
    disabled: false,
    fixed: { tools: ['*'] },
  }),
  cursor: untyped(['stdio', 'http', 'sse']),
  droid: typed({
    stdio: 'stdio',
    transports: ['stdio', 'http', 'sse'],
    untypedUrl: 'http',
    cwd: false,
    disabled: true,
  }),
  amp: untyped(['stdio', 'http']),
  pi: typed({
    stdio: 'stdio',
    transports: ['stdio', 'http'],
    untypedUrl: 'http',
    cwd: true,
    disabled: false,
  }),
  qoder: typed({
    stdio: 'stdio',
    transports: ['stdio', 'http', 'sse'],
    untypedUrl: 'http',
    cwd: true,
    disabled: false,
  }),
}

/** The keys under which a format keeps its servers in its file. */
export function containerOf(format: SyncFormat): string[] {
  switch (format) {
    case 'codex':
      return ['mcp_servers']
    case 'opencode':
    case 'kilo':
      return ['mcp']
    case 'opencode-v2':
      return ['mcp', 'servers']
    case 'amp':
      return ['amp.mcpServers']
    default:
      return ['mcpServers']
  }
}

/** A stable text of the server, so two agents' copies can be told apart. */
export function fingerprint(server: NeutralServer): string {
  const sorted = (map: Record<string, string>) =>
    Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return JSON.stringify([
    server.transport,
    server.command,
    server.args,
    sorted(server.env),
    server.cwd,
    server.url,
    sorted(server.headers),
    server.enabled,
  ])
}
