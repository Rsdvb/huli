// Huli: what the device tools read beyond agent-device, with the platforms' own tools: an app's
// crash reports since it started (Android's crash log buffer, the iOS simulators' reports on this
// Mac) and its CPU use over one second. Every command is built here from checked values: the
// device's serial or UDID, an app id the agent host checked, and process ids read back as numbers.

import { open, readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Env } from '../agent-host/find-command'
import { run } from './discovery'

/** One crash of the app, short enough for an agent to read. */
export interface CrashReport {
  time: string
  /** What crashed it: an exception, a signal, a termination reason. */
  summary: string
  /** The report's lines that matter: the exception and the top frames. */
  excerpt: string
  /** The report's file, for an iOS simulator's. */
  file?: string
}

const MAX_CRASHES = 5
const MAX_EXCERPT = 4000
const MAX_EXCERPT_LINES = 40
/** How far a device's clock may run behind this computer's, for the reports since a launch. */
const CLOCK_SLACK_MS = 2000

function capped(lines: string[]): string {
  const kept = lines.slice(0, MAX_EXCERPT_LINES).join('\n')
  return kept.length > MAX_EXCERPT ? `${kept.slice(0, MAX_EXCERPT)}…` : kept
}

// A line of `logcat -v epoch`: seconds.millis, pid, tid, level, then "tag: message".
const LOGCAT_LINE = /^\s*(\d+)\.(\d{3})\s+(\d+)\s+\d+\s+[VDIWEFA]\s+(.*)$/

/** The crashes of `app` in the text of Android's crash buffer, since `sinceMs`, newest last. */
export function androidCrashes(text: string, app: string, sinceMs: number): CrashReport[] {
  const groups: { pid: string; at: number; lines: string[] }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = LOGCAT_LINE.exec(raw)
    if (!line) continue
    const at = Number(line[1]) * 1000 + Number(line[2])
    const pid = line[3]!
    const message = line[4]!.replace(/^[^:]*:\s?/, '')
    const last = groups.at(-1)
    if (last && last.pid === pid && at - last.at < 5000) last.lines.push(message)
    else groups.push({ pid, at, lines: [message] })
  }
  const named = [`Process: ${app},`, `>>> ${app} <<<`, `Cmdline: ${app}`]
  return groups
    .filter((group) => group.at >= sinceMs - CLOCK_SLACK_MS)
    .filter((group) => group.lines.some((line) => named.some((name) => line.includes(name))))
    .slice(-MAX_CRASHES)
    .map((group) => {
      const summary =
        group.lines.find((line) => /^[\w.$]+(?:Exception|Error)\b/.test(line.trim())) ??
        group.lines.find((line) => /\bsignal \d+ \(SIG\w+\)/.test(line)) ??
        group.lines[0] ??
        ''
      return {
        time: new Date(group.at).toISOString(),
        summary: summary.trim(),
        excerpt: capped(group.lines),
      }
    })
}

/** Reads Android's crash buffer through adb and keeps the crashes of `app` since `sinceMs`. */
export async function readAndroidCrashes(
  adb: string,
  serial: string,
  app: string,
  sinceMs: number,
  env: Env,
): Promise<CrashReport[]> {
  const out = await run(
    adb,
    ['-s', serial, 'logcat', '-b', 'crash', '-d', '-v', 'epoch', '-t', '2000'],
    env,
  )
  return androidCrashes(out, app, sinceMs)
}

interface IpsFrame {
  imageIndex?: number
  symbol?: string
  imageOffset?: number
}

interface IpsBody {
  procPath?: string
  exception?: { type?: string; signal?: string; subtype?: string }
  termination?: { indicator?: string; reason?: string }
  faultingThread?: number
  threads?: { frames?: IpsFrame[]; name?: string; queue?: string }[]
  usedImages?: { name?: string }[]
  asi?: Record<string, string[]>
}

/**
 * One iOS simulator crash report, an `.ips` file: a header line of JSON, then the report's JSON.
 * Null when it is another app's, or from another simulator or the Mac itself.
 */
export function iosCrash(
  text: string,
  app: string,
  udid: string,
): Omit<CrashReport, 'file'> | null {
  const newline = text.indexOf('\n')
  if (newline < 0) return null
  let header: { bundleID?: string; timestamp?: string }
  let body: IpsBody
  try {
    header = JSON.parse(text.slice(0, newline)) as typeof header
    body = JSON.parse(text.slice(newline + 1)) as IpsBody
  } catch {
    return null
  }
  if (header.bundleID !== app) return null
  if (body.procPath && !body.procPath.includes(udid)) return null
  const exception = body.exception
  const summary = [
    exception?.type && `${exception.type}${exception.signal ? ` (${exception.signal})` : ''}`,
    exception?.subtype,
    body.termination?.indicator ?? body.termination?.reason,
  ]
    .filter(Boolean)
    .join(', ')
  const thread = body.threads?.[body.faultingThread ?? 0]
  const frames = (thread?.frames ?? []).slice(0, 15).map((frame, index) => {
    const image = body.usedImages?.[frame.imageIndex ?? -1]?.name ?? '???'
    const where = frame.symbol ?? `0x${(frame.imageOffset ?? 0).toString(16)}`
    return `${index}  ${image}  ${where}`
  })
  const reasons = Object.values(body.asi ?? {}).flat()
  return {
    time: header.timestamp ?? '',
    summary: summary || 'Crash',
    excerpt: capped([...reasons, ...(thread?.queue ? [`Queue: ${thread.queue}`] : []), ...frames]),
  }
}

/** The crash reports of `app` on the simulator `udid` since `sinceMs`, from this Mac's reports. */
export async function readIosSimulatorCrashes(
  udid: string,
  app: string,
  sinceMs: number,
): Promise<CrashReport[]> {
  const dir = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports')
  const names = await readdir(dir).catch(() => [] as string[])
  const recent: { file: string; at: number }[] = []
  for (const name of names) {
    if (!name.endsWith('.ips')) continue
    const file = path.join(dir, name)
    const info = await stat(file).catch(() => null)
    if (info?.isFile() && info.mtimeMs >= sinceMs - CLOCK_SLACK_MS && info.size < 4 * 1024 * 1024) {
      recent.push({ file, at: info.mtimeMs })
    }
  }
  recent.sort((a, b) => a.at - b.at)
  const crashes: CrashReport[] = []
  for (const { file } of recent.slice(-20)) {
    const crash = iosCrash(await readFile(file, 'utf8').catch(() => ''), app, udid)
    if (crash) crashes.push({ ...crash, file })
  }
  return crashes.slice(-MAX_CRASHES)
}

/** The last `count` lines of a log file, reading at most its last `maxBytes`. */
export async function tailLines(
  file: string,
  count: number,
  maxBytes = 512 * 1024,
): Promise<{ lines: string[]; truncated: boolean }> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    let lines = buffer.toString('utf8').split(/\r?\n/)
    // The first line of a window that starts inside the file is cut.
    if (length < size) lines = lines.slice(1)
    while (lines.length > 0 && lines.at(-1) === '') lines.pop()
    const kept = lines
      .slice(-count)
      .map((line) => (line.length > 2000 ? `${line.slice(0, 2000)}…` : line))
    return { lines: kept, truncated: length < size || lines.length > count }
  } finally {
    await handle.close()
  }
}

/** A sample of one process's CPU use: 100 is one core busy all the time. */
export interface CpuSample {
  pid: number
  percent: number
  sampleMs: number
}

const SAMPLE_MS = 1000

/** The user and system clock ticks of a `/proc/<pid>/stat` line, past the name in parentheses. */
function statTicks(line: string): number | null {
  const fields = line.slice(line.lastIndexOf(')') + 2).split(' ')
  const user = Number(fields[11])
  const system = Number(fields[12])
  return Number.isFinite(user) && Number.isFinite(system) ? user + system : null
}

/**
 * The CPU an app's process used, from two readings of its `/proc/<pid>/stat` and the device's
 * uptime a second apart, in one shell command made of the pid alone.
 */
export async function androidCpu(
  adb: string,
  serial: string,
  app: string,
  env: Env,
): Promise<CpuSample | null> {
  const pids = await run(adb, ['-s', serial, 'shell', 'pidof', app], env).catch(() => '')
  const pid = Number(/\d+/.exec(pids)?.[0])
  if (!Number.isInteger(pid) || pid <= 0) return null
  const read = `cat /proc/${pid}/stat /proc/uptime`
  const out = await run(adb, ['-s', serial, 'shell', `${read}; sleep 1; ${read}`], env)
  const stats = out.split(/\r?\n/).filter((line) => line.startsWith(`${pid} (`))
  const uptimes = out
    .split(/\r?\n/)
    .map((line) => /^(\d+(?:\.\d+)?) \d+(?:\.\d+)?$/.exec(line.trim())?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
  const first = stats[0] ? statTicks(stats[0]) : null
  const second = stats[1] ? statTicks(stats[1]) : null
  if (first === null || second === null || uptimes.length < 2) return null
  const seconds = uptimes[1]! - uptimes[0]!
  if (seconds <= 0) return null
  // Linux counts these ticks at 100 a second for every program.
  const percent = ((second - first) / 100 / seconds) * 100
  return { pid, percent: Math.round(percent * 10) / 10, sampleMs: Math.round(seconds * 1000) }
}

/** `ps`'s cumulative CPU time, `[[dd-]hh:]mm:ss.ss`, in seconds. */
function cpuSeconds(text: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim())
  if (!match) return null
  const [, days, hours, minutes, seconds] = match
  return (
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  )
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * The CPU an app on an iOS simulator used, whose process runs on this Mac: its executable from
 * the app's container, its pid from `ps`, and its CPU time a second apart.
 */
export async function simulatorCpu(
  xcrun: string,
  udid: string,
  app: string,
  env: Env,
  signal: AbortSignal,
): Promise<CpuSample | null> {
  const container = (
    await run(xcrun, ['simctl', 'get_app_container', udid, app, 'app'], env)
  ).trim()
  if (!container.startsWith('/')) return null
  const executable = (
    await run(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', `${container}/Info.plist`],
      env,
    )
  ).trim()
  if (!executable || executable.includes('/')) return null
  const binary = `${container}/${executable}`
  const listed = await run('/bin/ps', ['-axo', 'pid=,command='], env)
  const row = listed
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .find((match) => match && (match[2] === binary || match[2]!.startsWith(`${binary} `)))
  const pid = Number(row?.[1])
  if (!Number.isInteger(pid) || pid <= 0) return null
  const time = async () => cpuSeconds(await run('/bin/ps', ['-o', 'time=', '-p', String(pid)], env))
  const first = await time()
  const started = Date.now()
  await sleep(SAMPLE_MS, signal)
  const second = await time()
  const elapsed = (Date.now() - started) / 1000
  if (first === null || second === null || elapsed <= 0) return null
  return {
    pid,
    percent: Math.round(((second - first) / elapsed) * 1000) / 10,
    sampleMs: Math.round(elapsed * 1000),
  }
}
