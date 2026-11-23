// Huli: what the session board shows of a session's background processes, read when it asks and
// never on a timer: each running task's process tree, its CPU and memory, and the ports it
// listens on. One listing of the system's processes (`ps`, or CIM on Windows, as the process
// trees take) and one of the listening ports serve every task of the reading. A task the agent
// names no process for is found among the descendants of the process that runs its tools, by its
// command.

import path from 'node:path'
import type { Platform } from '@shared/platform'
import {
  MAX_TASK_PROCESSES,
  type TakenPort,
  type TaskPort,
  type TaskProcess,
} from '@shared/task-processes'
import { lastPort, type PortBlock } from '@shared/worktree-ports'
import type { ListeningPort } from '@shared/port-forwards'
import { listListeningPorts } from '../remote-host/listening-ports'
import { runTool, START_SLACK_MS } from './process-tree'
import type { AgentProcesses } from './connection'

/** A process with what the board shows of it. */
export interface ProcessStat {
  pid: number
  ppid: number
  /** Milliseconds since the epoch, to within a second; 0 when unknown. */
  startedAt: number
  /** Its command line; empty when the system would not say. */
  command: string
  /** Resident memory in bytes. */
  memory: number | null
  /** CPU use in percent of one core, as the system reports it; null where it reports time. */
  cpu: number | null
  /** CPU time used so far, in ms, where the system reports that instead. */
  cpuMs: number | null
}

/** How long one listing may take: a CIM query on a loaded Windows takes seconds. */
const LIST_MS = 30_000

// Windows file times count 100 ns intervals from 1601.
const FILETIME_EPOCH_MS = 11_644_473_600_000

// One tab-separated line a process: pid, parent, creation, working set, CPU time in 100 ns, and
// the command line last, with its own tabs and line breaks made spaces.
const CIM_SCRIPT =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,WorkingSetSize,' +
  'KernelModeTime,UserModeTime,CommandLine | ForEach-Object { "{0}`t{1}`t{2}`t{3}`t{4}`t{5}" -f ' +
  '$_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } ' +
  'else { 0 }), $_.WorkingSetSize, ($_.KernelModeTime + $_.UserModeTime), ' +
  "($_.CommandLine -replace '[\\t\\r\\n]', ' ') }"

/** The CIM listing above. */
export function parseCimStats(text: string): ProcessStat[] {
  const rows: ProcessStat[] = []
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split('\t')
    if (fields.length < 6) continue
    const [pid, ppid, created, working, cpu] = fields.map(Number)
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue
    const fileTime = Number.isFinite(created) ? created! : 0
    rows.push({
      pid: pid!,
      ppid: ppid!,
      startedAt: fileTime > 0 ? Math.round(fileTime / 10_000) - FILETIME_EPOCH_MS : 0,
      command: fields.slice(5).join('\t').trim(),
      memory: Number.isFinite(working) ? working! : null,
      cpu: null,
      cpuMs: Number.isFinite(cpu) ? cpu! / 10_000 : null,
    })
  }
  return rows
}

/** `ps -A -o pid=,ppid=,etime=,rss=,%cpu=,args=`, where etime is `[[dd-]hh:]mm:ss` and rss KiB. */
export function parsePsStats(text: string, now: number): ProcessStat[] {
  const rows: ProcessStat[] = []
  const pattern = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(\d+)\s+([\d.]+)\s*(.*)$/
  for (const line of text.split('\n')) {
    const match = pattern.exec(line)
    if (!match) continue
    const [, pid, ppid, days, hours, minutes, seconds, rss, cpu, args] = match
    const elapsed =
      ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      startedAt: now - elapsed * 1000,
      command: (args ?? '').trim(),
      memory: Number(rss) * 1024,
      cpu: Number(cpu),
      cpuMs: null,
    })
  }
  return rows
}

/** The system's processes with their stats; throws when the listing failed. */
export async function listProcessStats(platform: Platform): Promise<ProcessStat[]> {
  if (platform !== 'win32') {
    const text = await runTool('ps', ['-A', '-o', 'pid=,ppid=,etime=,rss=,%cpu=,args='], LIST_MS, {
      ...process.env,
      LC_ALL: 'C',
    })
    return parsePsStats(text, Date.now())
  }
  const root = process.env.SystemRoot
  const powershell = root
    ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  const encoded = Buffer.from(CIM_SCRIPT, 'utf16le').toString('base64')
  const text = await runTool(
    powershell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    LIST_MS,
  )
  return parseCimStats(text)
}

/** The processes under `pid`, itself first, by parent links; a reused pid is not followed. */
export function subtree(rows: readonly ProcessStat[], pid: number): ProcessStat[] {
  const children = new Map<number, ProcessStat[]>()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list) list.push(row)
    else children.set(row.ppid, [row])
  }
  const root = rows.find((row) => row.pid === pid)
  if (!root) return []
  const found = [root]
  const seen = new Set([root.pid])
  for (let i = 0; i < found.length; i++) {
    const parent = found[i]!
    for (const child of children.get(parent.pid) ?? []) {
      if (seen.has(child.pid) || child.pid === parent.pid) continue
      if (parent.startedAt > 0 && child.startedAt < parent.startedAt - START_SLACK_MS) continue
      seen.add(child.pid)
      found.push(child)
    }
  }
  return found
}

/** Text without quotes, escapes and runs of spaces, for finding a command in a command line. */
function plain(text: string): string {
  return text
    .replace(/['"`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * The process among `rows` that runs `command`: the one nearest the root whose command line
 * holds it, as a shell that runs it does. Null when none, or the command is too short to tell.
 */
export function processOfCommand(
  rows: readonly ProcessStat[],
  command: string,
): ProcessStat | null {
  const wanted = plain(command).slice(0, 200)
  if (wanted.length < 3) return null
  const holding = rows.filter((row) => plain(row.command).includes(wanted))
  if (holding.length === 0) return null
  const pids = new Set(holding.map((row) => row.pid))
  return holding.find((row) => !pids.has(row.ppid)) ?? holding[0]!
}

// The CPU time of each process at its last reading, for its share since then.
const lastCpu = new Map<string, { cpuMs: number; at: number }>()
const CPU_KEPT = 4_000

/**
 * CPU use in percent of one core: as the system reports it, else from the CPU time used since the
 * last reading, else since the process started.
 */
function cpuOf(row: ProcessStat, now: number): number | null {
  if (row.cpu !== null) return row.cpu
  if (row.cpuMs === null) return null
  const key = `${row.pid}:${row.startedAt}`
  const before = lastCpu.get(key)
  lastCpu.delete(key)
  lastCpu.set(key, { cpuMs: row.cpuMs, at: now })
  if (lastCpu.size > CPU_KEPT) lastCpu.delete(lastCpu.keys().next().value!)
  const [used, over] = before
    ? [row.cpuMs - before.cpuMs, now - before.at]
    : [row.cpuMs, row.startedAt > 0 ? now - row.startedAt : 0]
  return over > 0 ? Math.max(0, (used / over) * 100) : null
}

const inBlock = (port: number, block: PortBlock): boolean =>
  port >= block.first && port <= lastPort(block)

export interface ReadInput {
  /** The running tasks, with the process and command the agent gave. */
  tasks: readonly { id: string; command?: string; pid?: number }[]
  /** What the agent itself read of its tasks' processes. */
  known: AgentProcesses['processes']
  /** The process that runs the session's tools; null when unknown. */
  root: number | null
  /** The block of ports the session holds. */
  block: PortBlock | null
  /** The blocks the other live sessions hold. */
  held: readonly PortBlock[]
}

export interface Reading {
  processes: TaskProcess[]
  taken: TakenPort[]
}

export interface ReadDeps {
  platform: Platform
  list?: (platform: Platform) => Promise<ProcessStat[]>
  ports?: () => Promise<ListeningPort[] | null>
  now?: () => number
}

/** Reads the tasks' processes and ports; what could not be read is left unknown. */
export async function readTaskProcesses(input: ReadInput, deps: ReadDeps): Promise<Reading> {
  const list = deps.list ?? listProcessStats
  const ports =
    deps.ports ?? (() => listListeningPorts({ folders: [], skipPids: new Set([process.pid]) }))
  const tasks = input.tasks.slice(0, MAX_TASK_PROCESSES)
  const needsTree = tasks.length > 0 || input.block !== null
  const [rows, listening] = await Promise.all([
    needsTree ? list(deps.platform).catch(() => [] as ProcessStat[]) : [],
    ports().catch(() => null),
  ])
  const now = deps.now?.() ?? Date.now()
  const session = input.root !== null ? subtree(rows, input.root) : []
  const sessionPids = new Set(session.map((row) => row.pid))
  const portsByPid = new Map<number, number[]>()
  for (const entry of listening ?? []) {
    if (entry.pid === null) continue
    portsByPid.set(entry.pid, [...(portsByPid.get(entry.pid) ?? []), entry.port])
  }
  const portOf = (port: number): TaskPort => {
    const outside = input.block !== null && !inBlock(port, input.block)
    return { port, outside, collides: outside && input.held.some((block) => inBlock(port, block)) }
  }
  const known = new Map(input.known.map((entry) => [entry.taskId, entry]))
  const processes: TaskProcess[] = []
  for (const task of tasks) {
    const agent = known.get(task.id)
    const pid = agent?.pid ?? task.pid ?? null
    const head =
      pid !== null
        ? (rows.find((row) => row.pid === pid) ?? null)
        : task.command
          ? processOfCommand(session, task.command)
          : null
    const tree = head ? subtree(rows, head.pid) : []
    for (const row of tree) sessionPids.add(row.pid)
    const cpus = tree.map((row) => cpuOf(row, now))
    const memories = tree.map((row) => row.memory)
    const taskPorts = [...new Set(tree.flatMap((row) => portsByPid.get(row.pid) ?? []))]
      .sort((a, b) => a - b)
      .map(portOf)
    processes.push({
      taskId: task.id,
      pid: pid ?? head?.pid ?? null,
      cpu:
        agent?.cpu ??
        (cpus.some((cpu) => cpu !== null)
          ? cpus.reduce<number>((sum, cpu) => sum + (cpu ?? 0), 0)
          : null),
      memory:
        agent?.memory ??
        (memories.some((memory) => memory !== null)
          ? memories.reduce<number>((sum, memory) => sum + (memory ?? 0), 0)
          : null),
      ports: taskPorts,
    })
  }
  const taken: TakenPort[] = []
  if (input.block !== null) {
    for (const entry of listening ?? []) {
      if (!inBlock(entry.port, input.block)) continue
      if (entry.pid !== null && sessionPids.has(entry.pid)) continue
      taken.push({ port: entry.port, pid: entry.pid, process: entry.process })
    }
  }
  return { processes, taken }
}
