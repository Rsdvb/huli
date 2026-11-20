// Shell quoting for commands shown to the user or typed into a terminal.

import type { Platform } from '@shared/platform'

// A leading `=` expands in zsh and `^` is a zsh glob operator, so neither is left bare.
const POSIX_SAFE = /^[A-Za-z0-9_\-+.,/:@%][A-Za-z0-9_\-+=.,/:@%]*$/
// cmd.exe treats these specially outside quotes; whitespace splits arguments.
const CMD_UNSAFE = /[\s&|<>()^"%!,;=]/
// PowerShell's argument mode: a comma makes an array, `@` splats, `#` comments, `$` expands, and
// quotes, braces, parentheses, `;`, `&`, `|`, `<`, `>` and backticks are its syntax.
const POWERSHELL_SAFE = /^[A-Za-z0-9_\-+./:\\=%~][A-Za-z0-9_\-+./:\\=%~@]*$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
// npm's shims come as `.ps1` beside `.cmd`, and PowerShell picks the script, which Windows
// PowerShell's default execution policy refuses to run.
const NODE_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'corepack'])

/** POSIX shells: single quotes, with embedded single quotes closed, escaped and reopened. */
export function quotePosix(arg: string): string {
  if (arg !== '' && POSIX_SAFE.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** cmd.exe: double quotes, with embedded double quotes doubled. Windows paths cannot hold `"`. */
export function quoteCmd(arg: string): string {
  if (arg !== '' && !CMD_UNSAFE.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/** PowerShell: single quotes, which expand nothing, with embedded single quotes doubled. */
export function quotePowerShell(arg: string): string {
  if (arg !== '' && POWERSHELL_SAFE.test(arg)) return arg
  return `'${arg.replace(/'/g, "''")}'`
}

export interface CommandLine {
  command: string
  args: readonly string[]
  env?: Readonly<Record<string, string>>
}

/**
 * The command as one line for the shell a terminal runs: POSIX on macOS and Linux, PowerShell on
 * Windows, where Kettu's terminal starts pwsh or Windows PowerShell and so does Windows Terminal.
 * The line also runs in PowerShell 5.1, which has no `&&`.
 */
export function formatCommand(line: CommandLine, platform: Platform): string {
  if (platform !== 'win32') {
    const words = [line.command, ...line.args].map(quotePosix).join(' ')
    const env = Object.entries(line.env ?? {})
    if (env.length === 0) return words
    return `${env.map(([name, value]) => `${name}=${quotePosix(value)}`).join(' ')} ${words}`
  }
  const program = NODE_SHIMS.has(line.command) ? `${line.command}.cmd` : line.command
  const quoted = quotePowerShell(program)
  // A quoted program is a string to PowerShell until the call operator runs it.
  const head = quoted === program ? program : `& ${quoted}`
  const words = [head, ...line.args.map(quotePowerShell)].join(' ')
  const env = Object.entries(line.env ?? {})
  if (env.length === 0) return words
  const sets = env.map(([name, value]) => {
    const variable = ENV_NAME.test(name)
      ? `$env:${name}`
      : `\${env:${name.replace(/[{}`]/g, '`$&')}}`
    return `${variable} = '${value.replace(/'/g, "''")}'`
  })
  return `${sets.join('; ')}; ${words}`
}
