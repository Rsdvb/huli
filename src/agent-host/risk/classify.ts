// A permission request's risk, from what it does: deterministic string work, so the same request
// always gets the same level, and nothing runs until a request comes. Whatever it cannot read for
// certain goes higher, never lower.

import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { AutoApprove } from '@shared/risk'
import type { ToolEntry } from '@shared/thread'
import { commandVerdict } from './command'
import { placeOf, type Place, type PlaceContext } from './places'
import type { ShellKind } from './shell-words'
import { high, low, medium, readVerdict, worst, writeVerdict, type Verdict } from './verdict'

export type { RiskReason, Verdict } from './verdict'
export type { ShellKind } from './shell-words'

/** What a request does, as its agent's driver or the request's tool entry tells it. */
export type RiskSubject =
  | {
      kind: 'command'
      command: string
      /** The shell that runs it; where not known, it is read as each one it could be. */
      shell?: ShellKind
      /** The folder it runs in, when the agent names one. */
      cwd?: string
    }
  /** Reads or searches these files or folders. */
  | { kind: 'read'; paths: readonly string[] }
  /** Writes these files. */
  | { kind: 'edit'; paths: readonly string[] }
  | { kind: 'delete'; paths: readonly string[] }
  | { kind: 'move'; paths: readonly string[] }
  | { kind: 'fetch'; url?: string }
  /** A search whose reach is not known, such as one on the web or with no folder. */
  | { kind: 'search' }
  | { kind: 'mcp'; server: string; tool: string }
  /** Wider sandbox rights for a while, as Codex asks. */
  | { kind: 'grant'; network: boolean; reads: readonly string[]; writes: readonly string[] }
  /** Input to type into a command that runs already. */
  | { kind: 'input' }
  | { kind: 'other'; name?: string }

export interface RiskContext {
  platform: Platform
  /** The folder the session works in, which relative paths resolve against. */
  cwd: string
  /** The folders that count as the project: the session's worktree and its project. */
  roots: readonly string[]
}

export interface Assessment extends Verdict {
  /** The request only edits files inside the project, outside its tools' and agents' settings. */
  projectEdit: boolean
}

/**
 * Files inside a project whose change reaches past it: what agents, editors, hooks and CI may run
 * or allow. An edit of one is never answered by itself.
 */
const CONFIG_PATH =
  /(?:^|[\\/])(?:\.claude|\.codex|\.gemini|\.cursor|\.vscode|\.idea|\.husky|\.githooks|\.devcontainer|\.github[\\/]workflows)(?:[\\/]|$)|(?:^|[\\/])(?:\.mcp\.json|\.pnpmfile\.cjs|\.yarnrc(?:\.yml)?|\.npmrc|\.envrc|\.gitattributes|\.gitmodules|\.lfsconfig)$/i

function relativeTo(roots: readonly string[], file: string, platform: Platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix
  for (const root of roots) {
    const relative = api.relative(root, file)
    if (relative && !relative.startsWith('..') && !api.isAbsolute(relative)) return relative
  }
  return file
}

/** The shells a command may run in when its agent does not say. */
function shellsFor(platform: Platform, shell: ShellKind | undefined): ShellKind[] {
  if (shell) return [shell]
  return platform === 'win32' ? ['posix', 'powershell', 'cmd'] : ['posix']
}

/** MCP tools whose name says they delete, send, pay or run something. */
const MCP_DANGER =
  /(?:^|[_\-.])(?:delete|remove|drop|destroy|kill|purge|truncate|wipe|erase|send|publish|push|deploy|pay|transfer|buy|sell|order|trade|execute|exec|shell|eval|run_command|run_script)(?:$|[_\-.])/i

export function assessRisk(subject: RiskSubject, ctx: RiskContext): Assessment {
  const places: PlaceContext = {
    platform: ctx.platform,
    cwd: ctx.cwd,
    roots: ctx.roots,
    // A path the agent names to a tool is a file path, read as the platform's.
    shell: ctx.platform === 'win32' ? 'cmd' : 'posix',
  }
  const at = (file: string): Place => placeOf(file, places)
  // A path inside the project as relative to it, as the card names it.
  const shown = (file: string): string => relativeTo(ctx.roots, file, ctx.platform)
  const verdict = ((): Verdict => {
    switch (subject.kind) {
      case 'command':
        return commandVerdict(subject.command, shellsFor(ctx.platform, subject.shell), {
          platform: ctx.platform,
          cwd: subject.cwd || ctx.cwd,
          roots: ctx.roots,
        })
      case 'read':
        if (subject.paths.length === 0) return medium('unclearScope')
        return subject.paths.reduce<Verdict>(
          (out, file) => worst(out, readVerdict(at(file), shown(file))),
          low('readProject'),
        )
      case 'edit':
      case 'move': {
        if (subject.paths.length === 0) return high('unknown')
        let out: Verdict = medium('editProject')
        for (const file of subject.paths) {
          const place = at(file)
          // A setting of a tool or agent says so over a plain edit at the same level.
          if (place === 'project' && CONFIG_PATH.test(shown(file))) {
            if (out.reason === 'editProject') out = medium('editConfig', shown(file))
          } else out = worst(out, writeVerdict(place, shown(file)))
        }
        return out
      }
      case 'delete':
        return high('delete', subject.paths[0] === undefined ? undefined : shown(subject.paths[0]))
      case 'fetch':
        return medium('network', subject.url ? hostOf(subject.url) : undefined)
      case 'search':
        return medium('unclearScope')
      case 'mcp': {
        const name = `${subject.server}/${subject.tool}`
        return MCP_DANGER.test(subject.tool) ? high('mcpDanger', name) : medium('mcp', name)
      }
      case 'grant': {
        let out = subject.network ? medium('network') : medium('grant')
        for (const file of subject.reads) out = worst(out, readVerdict(at(file), shown(file)))
        for (const file of subject.writes) out = worst(out, writeVerdict(at(file), shown(file)))
        return worst(out, medium('grant'))
      }
      case 'input':
        return high('input')
      case 'other':
        return high('unknown', subject.name)
    }
  })()
  const projectEdit =
    subject.kind === 'edit' &&
    verdict.level === 'medium' &&
    subject.paths.length > 0 &&
    subject.paths.every((file) => at(file) === 'project' && !CONFIG_PATH.test(shown(file)))
  return { ...verdict, projectEdit }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** The command a tool entry shows, when its input is one rather than the JSON of an input. */
function entryCommand(entry: ToolEntry): string | null {
  const raw = entry.rawInput
  if (raw === undefined || raw.trim() === '') return null
  return /^\s*[[{]/.test(raw) ? null : raw
}

/**
 * What a request does, read from the tool entry it belongs to, for an agent whose driver says no
 * more: its kind as the agent gave it, the command it shows, and the paths it names.
 */
export function entrySubject(entry: ToolEntry): RiskSubject {
  const paths = [
    ...new Set([
      ...entry.locations.map((location) => location.path),
      ...entry.content.flatMap((content) => (content.type === 'diff' ? [content.path] : [])),
    ]),
  ]
  switch (entry.toolKind) {
    case 'execute': {
      const command = entryCommand(entry)
      return command === null ? { kind: 'other', name: entry.title } : { kind: 'command', command }
    }
    case 'read':
      return { kind: 'read', paths }
    case 'search':
      return paths.length > 0 ? { kind: 'read', paths } : { kind: 'search' }
    case 'edit':
      return { kind: 'edit', paths }
    case 'delete':
      return { kind: 'delete', paths }
    case 'move':
      return { kind: 'move', paths }
    case 'fetch':
      return { kind: 'fetch' }
    default:
      return { kind: 'other', name: entry.title }
  }
}

/**
 * Whether the host answers a request by itself, allowing it once: only with the setting on, and
 * then only a low one, or with `edits` also an edit inside the project. Never a medium or high
 * one otherwise.
 */
export function autoApproves(
  setting: AutoApprove,
  risk: Pick<Assessment, 'level' | 'projectEdit'>,
) {
  if (setting === 'off') return false
  if (risk.level === 'low') return true
  return setting === 'edits' && risk.level === 'medium' && risk.projectEdit
}
