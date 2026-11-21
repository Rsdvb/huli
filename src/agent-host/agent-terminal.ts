// Huli: an agent's own CLI in a terminal of Kite's: the line that starts its interactive UI, the
// line that resumes one of its sessions, and the same after a change of folder, to paste. Every
// line is built here from the program detection found and the arguments the agent's definition
// names, never from a client's words, and the terminal host runs only the lines `runnableLines`
// lists (`TerminalGrants` holds the resumes asked for).

import type { Platform } from '@shared/platform'
import type { AgentDefinition, CommandWords, Detection } from './catalog'
import { formatCommand } from './quote'

// A line goes into a shell as typed; a control character would act as a key there.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/
/** The ids the CLIs name sessions by: UUIDs, `ses_...`, `doubao-...` and the like. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

/** The program that runs the agent's CLI and what its start adds, before the UI's arguments. */
export interface TerminalProgram {
  command: string
  /** Arguments before the CLI's own, such as a package's entry module after Node.js. */
  args: string[]
  env: Record<string, string>
}

/**
 * Where the agent's CLI is, as detection found it; null for an agent without an interactive CLI,
 * or one not found or unable to run. The user's own CLI runs as found on PATH (npm's `.cmd` shim
 * on Windows, which PowerShell's execution policy lets run where the `.ps1` beside it is refused),
 * a package Kite installed as `node <entry>`, and a program as detection found it.
 */
export function terminalProgram(
  def: AgentDefinition,
  detection: Detection | null,
): TerminalProgram | null {
  if (!def.terminal || detection?.state !== 'available') return null
  if (def.cli) {
    const cli = detection.cli
    if (!cli || cli.problem) return null
    return { command: cli.launcher ?? cli.path, args: [], env: {} }
  }
  const { launch } = def
  const spec = detection.spec ?? detection.adapter?.fallback?.spec ?? null
  if (!spec) return null
  switch (launch.kind) {
    case 'package': {
      // `node <entry> <launch args>`; a library or a per-session router has no program to run.
      if (launch.library || launch.perSession) return null
      const extra = launch.args?.length ?? 0
      const entry = spec.args[0]
      if (entry === undefined || spec.args.length !== 1 + extra) return null
      return { command: spec.command, args: [entry], env: { ...launch.env } }
    }
    case 'binary':
      return launch.perSession ? null : { command: spec.command, args: [], env: {} }
    case 'node-script':
      return def.terminal.nodeOnPath
        ? { command: 'node', args: [launch.script], env: {} }
        : { command: spec.command, args: spec.args.slice(0, 1), env: { ...spec.env } }
    case 'uvx':
      return null
  }
}

/**
 * The words that start the CLI's UI, or resume the session `resumeId` names, with the variables
 * `env` adds (its configuration folder); null when the CLI resumes no session.
 */
export function terminalWords(
  def: AgentDefinition,
  program: TerminalProgram,
  env: Record<string, string>,
  resumeId?: string,
): CommandWords | null {
  const cli = def.terminal
  if (!cli) return null
  let args: readonly string[] = cli.args
  if (resumeId !== undefined) {
    if (!cli.resume || !validResumeId(resumeId)) return null
    args = cli.resume(resumeId)
  }
  return {
    command: program.command,
    args: [...program.args, ...args],
    env: { ...program.env, ...env },
  }
}

/** Whether a session id or session file may go into a line: one line, of the CLIs' id shapes. */
export function validResumeId(id: string): boolean {
  if (CONTROL.test(id)) return false
  // Pi resumes another folder's session by its file, an absolute path.
  return SESSION_ID.test(id) || /^(?:\/|[A-Za-z]:[\\/])/.test(id)
}

/** The words as one line for the host's terminal shell; null when it cannot be one line. */
export function terminalLine(words: CommandWords, platform: Platform): string | null {
  const line = formatCommand(words, platform)
  return CONTROL.test(line) ? null : line
}

/**
 * The line after a change to `folder`, to paste into any terminal of the host: PowerShell's on
 * Windows, which Kite's and Windows Terminal's shells are and whose 5.1 has no `&&`, POSIX's
 * elsewhere. The host's platform decides, never the look of the path.
 */
export function inFolder(folder: string, line: string, platform: Platform): string {
  if (platform === 'win32')
    return `Set-Location -LiteralPath '${folder.replace(/'/g, "''")}'; ${line}`
  return `cd '${folder.replace(/'/g, `'\\''`)}' && ${line}`
}

/** How long a resume asked to run stays runnable: it is typed once its new shell is ready. */
export const GRANT_MS = 2 * 60_000
const MAX_GRANTS = 32

/**
 * The resume lines a client asked to run, each runnable for `GRANT_MS`, the newest `MAX_GRANTS` of
 * them; `changed` hears each change, to tell the terminal host.
 */
export class TerminalGrants {
  private readonly until = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  grant(line: string): void {
    this.until.delete(line)
    this.until.set(line, this.now() + GRANT_MS)
    while (this.until.size > MAX_GRANTS) this.until.delete(this.until.keys().next().value!)
    this.arm()
    this.changed()
  }

  lines(): string[] {
    const now = this.now()
    return [...this.until].filter(([, until]) => until > now).map(([line]) => line)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.until.clear()
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.until.size === 0) return
    const next = Math.min(...this.until.values())
    this.timer = setTimeout(() => this.expire(), Math.max(0, next - this.now()))
    this.timer.unref?.()
  }

  private expire(): void {
    const now = this.now()
    let dropped = false
    for (const [line, until] of this.until) {
      if (until > now) continue
      this.until.delete(line)
      dropped = true
    }
    this.arm()
    if (dropped) this.changed()
  }
}
