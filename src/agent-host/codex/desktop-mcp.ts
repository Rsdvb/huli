// Huli: the MCP servers of the Codex desktop app (OpenAI.Codex from the Microsoft Store, Codex.app
// on macOS). The app writes them into the user's Codex configuration and its bundled plugins, and
// each either runs a program inside the app's own install folder, which every update of the app
// moves, or needs what only the app hands the Codex it runs: its browser-access pipe and its
// registered core. A Codex Kite starts can run none of them, so they failed at every start of a
// session. Kite's threads start them turned off through the thread's own configuration; the
// user's files stay as they are.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { compareVersions, isVersion } from '../versions'
import type { JsonValue } from './protocol'

/** One of the app's servers that a thread's configuration would start. */
export interface DesktopServer {
  name: string
  /** The plugin it comes with, as `<name>@<marketplace>`; null for one of the configuration's own. */
  plugin: string | null
  command: string
}

/** A server's declaration as Codex's configuration or a plugin's MCP file has it. */
type Declarations = Record<string, unknown>

// The rule, kept narrow: a command inside the app's install folder, the Store package's
// `WindowsApps\OpenAI.Codex_<version>_<arch>__<publisher>` or the macOS bundle's `Codex.app/Contents`,
// or a variable only the app sets.
const APP_FOLDER = /(?:^|\/)windowsapps\/openai\.codex_[^/]*\/|(?:^|\/)codex\.app\/contents\//
const APP_VARIABLE = /^(?:BROWSER_USE_ACCESS_\w+|CODEX_WINDOWS_REGISTERED_CORE)$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function variableName(entry: unknown): string {
  if (typeof entry === 'string') return entry
  return isObject(entry) && typeof entry.name === 'string' ? entry.name : ''
}

/** The server's command when it is one of the app's and would start; null otherwise. */
export function desktopCommand(declaration: unknown): string | null {
  if (!isObject(declaration) || declaration.enabled === false) return null
  const { command } = declaration
  if (typeof command !== 'string' || command.trim() === '') return null
  if (APP_FOLDER.test(command.replace(/\\/g, '/').toLowerCase())) return command
  const variables = Array.isArray(declaration.env_vars) ? declaration.env_vars : []
  return variables.some((entry) => APP_VARIABLE.test(variableName(entry))) ? command : null
}

/**
 * The app's servers among those `config/read` answers with and those of its enabled plugins, which
 * `plugin` reads; a plugin's server that the configuration names too, or turns off, is left out,
 * as Codex starts the configuration's own then.
 */
export async function desktopServers(
  config: Record<string, unknown>,
  plugin: (id: string) => Promise<Declarations>,
): Promise<DesktopServer[]> {
  const own = isObject(config.mcp_servers) ? config.mcp_servers : {}
  const found: DesktopServer[] = []
  for (const [name, declaration] of Object.entries(own)) {
    const command = desktopCommand(declaration)
    if (command !== null) found.push({ name, plugin: null, command })
  }
  const plugins = isObject(config.plugins) ? config.plugins : {}
  const enabled = Object.entries(plugins).filter(
    ([, settings]) => isObject(settings) && settings.enabled !== false,
  )
  const declared = await Promise.all(
    enabled.map(([id]) => plugin(id).catch((): Declarations => ({}))),
  )
  enabled.forEach(([id, settings], index) => {
    const policy = isObject(settings) && isObject(settings.mcp_servers) ? settings.mcp_servers : {}
    for (const [name, declaration] of Object.entries(declared[index] ?? {})) {
      if (name in own) continue
      const turned = policy[name]
      if (isObject(turned) && turned.enabled === false) continue
      const command = desktopCommand(declaration)
      if (command !== null) found.push({ name, plugin: id, command })
    }
  })
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The thread's configuration that starts the app's servers turned off, except those the user let
 * start in the session; null when none is left to turn off. A server of the configuration keeps
 * its command, so its entry stays whole should the user's file lose it before the thread starts.
 */
export function desktopConfig(
  servers: readonly DesktopServer[],
  allowed: ReadonlySet<string>,
): Record<string, JsonValue> | null {
  const own: Record<string, JsonValue> = {}
  const plugins: Record<string, { mcp_servers: Record<string, JsonValue> }> = {}
  for (const server of servers) {
    if (allowed.has(server.name)) continue
    if (server.plugin === null) {
      own[server.name] = { command: server.command, enabled: false }
    } else {
      const entry = (plugins[server.plugin] ??= { mcp_servers: {} })
      entry.mcp_servers[server.name] = { enabled: false }
    }
  }
  if (Object.keys(own).length === 0 && Object.keys(plugins).length === 0) return null
  return {
    ...(Object.keys(own).length > 0 ? { mcp_servers: own } : {}),
    ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
  }
}

// What Codex takes as a path segment of a plugin's cache: its rule for plugin versions.
const SEGMENT = /^[A-Za-z0-9._+-]+$/
const LOCAL_VERSION = 'local'

function segment(text: string): boolean {
  return SEGMENT.test(text) && text !== '.' && text !== '..'
}

/** The version of a plugin Codex runs among those its cache holds: `local`, else the highest. */
export function activeVersion(versions: readonly string[]): string | null {
  const valid = versions.filter(segment)
  if (valid.includes(LOCAL_VERSION)) return LOCAL_VERSION
  const order = (a: string, b: string) =>
    isVersion(a) && isVersion(b) ? compareVersions(a, b) : a < b ? -1 : a > b ? 1 : 0
  return [...valid].sort(order).at(-1) ?? null
}

/** A plugin MCP file's servers: under `mcpServers`, or the file's own keys. */
export function declaredServers(json: unknown): Declarations {
  if (!isObject(json)) return {}
  return isObject(json.mcpServers) ? json.mcpServers : json
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown
}

/**
 * The servers a plugin of Codex's own format declares, read from where Codex installed it:
 * `<codexHome>/plugins/cache/<marketplace>/<name>/<version>`. `cache` keeps each version's, which
 * Codex never changes in place. Nothing for an id or a file that is not as Codex writes them.
 */
export async function readPluginServers(
  codexHome: string,
  id: string,
  cache: Map<string, Promise<Declarations>>,
): Promise<Declarations> {
  const at = id.lastIndexOf('@')
  const name = id.slice(0, at)
  const marketplace = id.slice(at + 1)
  if (at <= 0 || !segment(name) || !segment(marketplace)) return {}
  const base = path.join(codexHome, 'plugins', 'cache', marketplace, name)
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => [])
  const version = activeVersion(entries.filter((e) => e.isDirectory()).map((e) => e.name))
  if (version === null) return {}
  const root = path.join(base, version)
  let read = cache.get(root)
  if (!read) {
    read = pluginServers(root)
    cache.set(root, read)
  }
  return read
}

async function pluginServers(root: string): Promise<Declarations> {
  const manifest = await readJson(path.join(root, '.codex-plugin', 'plugin.json')).catch(() => null)
  const declared = isObject(manifest) ? manifest.mcpServers : undefined
  if (isObject(declared)) return declaredServers(declared)
  const file = path.resolve(root, typeof declared === 'string' ? declared : '.mcp.json')
  const inside = path.relative(root, file)
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return {}
  return declaredServers(await readJson(file).catch(() => null))
}
