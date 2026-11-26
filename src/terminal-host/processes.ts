// Huli: which shells have a program running under them, read from one listing of the system's
// processes. A shell with none is idle at its prompt; a dev server, a watcher or a build is a
// child of it. The foreground process alone would miss a job sent to the background, and Windows
// reports none.

import { execFile } from 'node:child_process'
import path from 'node:path'
import type { Platform } from '@shared/platform'

export interface ProcessRow {
  pid: number
  ppid: number
  /** Milliseconds since the epoch; from `ps`, to within a second. */
  startedAt: number
  /** The program's file name, without its folder. */
  name: string
}

/** How far a child's start may seem to come before its parent's: `ps` reports whole seconds. */
const START_SLACK_MS = 2_000

/**
 * Children a shell keeps while it sits at its prompt, which run nothing of the user's: the git
 * status daemon of zsh's powerlevel10k and gitstatus prompts.
 */
const PROMPT_HELPERS = /^gitstatusd/i

/** `ps -A -o pid=,ppid=,etime=,comm=`, where etime is `[[dd-]hh:]mm:ss`. */
export function parsePs(text: string, now: number): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const [, pid, ppid, days, hours, minutes, seconds, command] = match
    const elapsed =
      ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      startedAt: now - elapsed * 1000,
      name: path.posix.basename(command!),
    })
  }
  return rows
}

// Windows file times count 100 ns intervals from 1601.
const FILETIME_EPOCH_MS = 11_644_473_600_000

/** The PowerShell listing below: pid, parent pid, creation time as a file time, and name. */
export function parseCim(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const fileTime = Number(match[3])
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAt: fileTime > 0 ? Math.round(fileTime / 10_000) - FILETIME_EPOCH_MS : 0,
      name: match[4]!,
    })
  }
  return rows
}

/**
 * The earliest started process running under the shell `shellPid`, its whole tree followed, or
 * null when it sits idle. Windows keeps a dead parent's pid on its children, so a process that
 * started before the shell names its pid only because the pid was reused, and is not followed.
 */
export function runningUnder(rows: readonly ProcessRow[], shellPid: number): ProcessRow | null {
  const shell = rows.find((row) => row.pid === shellPid)
  if (!shell) return null
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list) list.push(row)
    else children.set(row.ppid, [row])
  }
  let earliest: ProcessRow | null = null
  const seen = new Set<number>([shell.pid])
  const queue = [shell]
  for (let parent = queue.shift(); parent; parent = queue.shift()) {
    for (const child of children.get(parent.pid) ?? []) {
      if (seen.has(child.pid) || child.startedAt < parent.startedAt - START_SLACK_MS) continue
      seen.add(child.pid)
      queue.push(child)
      if (parent === shell && PROMPT_HELPERS.test(child.name)) continue
      if (!earliest || child.startedAt < earliest.startedAt) earliest = child
    }
  }
  return earliest
}

// Windows has no `ps`; the processes' parents, creation times and names come from CIM.
const CIM_SCRIPT =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ' +
  "ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, " +
  '$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }), $_.Name }'

function run(file: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        ...(env ? { env } : {}),
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

/** Every process of the system, by one run of `ps`, or of a CIM query on Windows. */
export async function listProcesses(platform: Platform, timeoutMs: number): Promise<ProcessRow[]> {
  if (platform !== 'win32') {
    const text = await run('ps', ['-A', '-o', 'pid=,ppid=,etime=,comm='], timeoutMs, {
      ...process.env,
      LC_ALL: 'C',
    })
    return parsePs(text, Date.now())
  }
  const root = process.env.SystemRoot
  const powershell = root
    ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  const encoded = Buffer.from(CIM_SCRIPT, 'utf16le').toString('base64')
  const text = await run(
    powershell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    timeoutMs,
  )
  return parseCim(text)
}
