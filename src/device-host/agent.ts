// Agents' actions on devices, carried out by agent-device (MIT): one of its sessions per Kettu
// session and device, its state in Kettu's data folder, its update notice off. Kettu runs only the
// commands it builds here from checked arguments, the agent's words after `--`, where
// agent-device reads no flag.

import { execFile, spawn } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { copyFile, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Env } from '../agent-host/find-command'
import {
  MAX_DEVICE_RECORDING_MS,
  type DeviceAction,
  type DeviceActionResult,
} from '@shared/device-agent'
import { CaptureError, SessionFiles, exists } from './captures'
import {
  androidCpu,
  readAndroidCrashes,
  readIosSimulatorCrashes,
  simulatorCpu,
  tailLines,
  type CpuSample,
  type CrashReport,
} from './diagnostics'
import type { FoundDevice, Tools } from './discovery'
import { nodeCommand, packageRoot } from './runtime'

const COMMAND_TIMEOUT_MS = 180_000
const MAX_OUTPUT = 512 * 1024
const SPRINGBOARD = 'com.apple.springboard'
/** agent-device's own quiet window for `wait stable`, given when a timeout follows it. */
const STABLE_QUIET_MS = 500
/** The most a diagnostics answer carries, so one call cannot flood the agent's context. */
const MAX_ANSWER = 48 * 1024
/** The largest diff image a comparison shows inline; a larger one is only named. */
const MAX_INLINE_IMAGE = 4 * 1024 * 1024

export class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function cli(): string {
  return path.join(packageRoot('agent-device'), 'bin', 'agent-device.mjs')
}

interface Output {
  code: number | null
  stdout: string
  stderr: string
}

/** The Apple development team of the first development certificate in the keychain. */
async function developmentTeam(env: Env): Promise<string | null> {
  const pem = await new Promise<string>((resolve) =>
    execFile(
      '/usr/bin/security',
      ['find-certificate', '-a', '-c', 'Apple Development', '-p'],
      { env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (_, stdout) => resolve(String(stdout ?? '')),
    ),
  )
  for (const block of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ??
    []) {
    try {
      const subject = new X509Certificate(block).subject
      const team = /^OU=([A-Z0-9]{10})$/m.exec(subject)?.[1]
      if (team) return team
    } catch {
      // Not a certificate Node can read.
    }
  }
  return null
}

/** A screen recording one session runs on one device, by agent-device session name. */
interface Recording {
  sessionId: string
  deviceId: string
  device: FoundDevice
  files: SessionFiles
  path: string
  startedAt: number
  /** Stops it at its limit; cleared once it stops. */
  timer: ReturnType<typeof setTimeout>
  /** Set once it began to stop, settling with what record stop answered. */
  stopped?: Promise<DeviceActionResult>
  atLimit?: boolean
}

/** What agent-device's `--json` answers: its `data`, or its error. */
function parsed(out: Output): Record<string, unknown> | null {
  try {
    const value = JSON.parse(out.stdout) as { data?: unknown }
    return typeof value.data === 'object' && value.data !== null
      ? (value.data as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** A value as JSON text of at most `MAX_ANSWER` characters. */
function jsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 1)
  return text.length > MAX_ANSWER ? `${text.slice(0, MAX_ANSWER)}…` : text
}

function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export class AgentActions {
  private team: Promise<string | null> | null = null
  /** The sessions agent-device has open, so the first action on a device opens one. */
  private readonly opened = new Set<string>()
  /** The app each agent-device session launched last, and when, for its logs and samples. */
  private readonly apps = new Map<string, { app: string; launchedAt: number }>()
  private readonly recordings = new Map<string, Recording>()

  constructor(
    private readonly dataDir: string,
    private readonly env: () => Promise<Env>,
    private readonly tools: () => Promise<Tools>,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Carries out one action of a session's agent. `folder` is the folder the session works in,
   * the only place an action writes a file.
   */
  async run(
    sessionId: string,
    device: FoundDevice,
    action: DeviceAction,
    signal: AbortSignal,
    folder: string | null = null,
  ): Promise<DeviceActionResult> {
    const session = this.sessionName(sessionId, device)
    const selector = this.selector(device)
    if (action.type === 'launch') {
      const launchedAt = Date.now()
      const out = await this.cli(
        ['open', action.app, ...selector, '--session', session, '--relaunch'],
        signal,
        device,
      )
      this.opened.add(session)
      this.apps.set(session, { app: action.app, launchedAt })
      return { text: this.text(out) }
    }
    if (action.type === 'record_stop') return this.stopRecording(session)
    if (action.type === 'open_url') {
      const out = await this.cli(
        ['open', action.url, ...selector, '--session', session],
        signal,
        device,
      )
      this.opened.add(session)
      return { text: this.text(out) }
    }
    if (action.type === 'install') {
      const out = await this.cli(
        ['install', action.path, ...selector, '--session', session],
        signal,
        device,
      )
      return { text: this.text(out) }
    }
    await this.ensureSession(session, device, selector, signal)
    const digest = 'level' in action && action.level === 'digest' ? ['--level', 'digest'] : []
    switch (action.type) {
      case 'snapshot': {
        const read = ['snapshot', '-i', ...digest, '--session', session]
        let out = await this.cli(read, signal, device, true)
        // An iOS session follows one app; reading the screen with none open reads the home screen.
        if (
          out.code !== 0 &&
          /requires an active app session|No foreground app/.test(out.stdout + out.stderr)
        ) {
          await this.cli(['open', SPRINGBOARD, '--session', session], signal, device)
          out = await this.cli(read, signal, device)
        } else if (out.code !== 0) {
          throw this.failure(out)
        }
        return { text: this.text(out) }
      }
      case 'tap': {
        const target = 'ref' in action ? [action.ref] : [String(action.x), String(action.y)]
        const verb = action.long ? 'longpress' : 'press'
        return {
          text: this.text(
            await this.cli(
              [verb, '--settle', ...digest, '--session', session, '--', ...target],
              signal,
              device,
            ),
          ),
        }
      }
      case 'fill':
        return {
          text: this.text(
            await this.cli(
              ['fill', '--settle', ...digest, '--session', session, '--', action.ref, action.text],
              signal,
              device,
            ),
          ),
        }
      case 'type':
        return {
          text: this.text(
            await this.cli(['type', '--session', session, '--', action.text], signal, device),
          ),
        }
      case 'wait': {
        const timeout = action.timeoutMs === undefined ? [] : [String(action.timeoutMs)]
        const what =
          action.until === 'text'
            ? ['text', action.value!]
            : action.until === 'absent'
              ? ['absent', action.value!]
              : action.until === 'selector'
                ? [action.value!]
                : // A timeout comes after the quiet window, which then must be given.
                  [
                    'stable',
                    ...(action.quietMs !== undefined || action.timeoutMs !== undefined
                      ? [String(action.quietMs ?? STABLE_QUIET_MS)]
                      : []),
                  ]
        return {
          text: this.text(
            await this.cli(
              ['wait', '--session', session, '--', ...what, ...timeout],
              signal,
              device,
            ),
          ),
        }
      }
      case 'find': {
        const words = [
          ...(action.locator === 'any' ? [] : [action.locator]),
          action.query,
          ...(action.action === 'getText'
            ? ['get', 'text']
            : action.action === 'getAttrs'
              ? ['get', 'attrs']
              : [action.action]),
          ...(action.action === 'wait' && action.timeoutMs !== undefined
            ? [String(action.timeoutMs)]
            : []),
          ...(action.value === undefined ? [] : [action.value]),
        ]
        const pick = action.pick === undefined ? [] : [`--${action.pick}`]
        return {
          text: this.text(
            await this.cli(
              ['find', ...pick, ...digest, '--session', session, '--', ...words],
              signal,
              device,
            ),
          ),
        }
      }
      case 'is': {
        const out = await this.cli(
          [
            'is',
            '--session',
            session,
            '--',
            action.predicate,
            action.selector,
            ...(action.value === undefined ? [] : [action.value]),
          ],
          signal,
          device,
          true,
        )
        if (out.code === 0) return { text: `Yes. ${this.text(out)}` }
        // A check that does not hold is an answer, not a failure.
        const failed = this.failure(out)
        if (/\bis \w+ failed\b/.test(failed.message)) return { text: `No. ${failed.message}` }
        throw failed
      }
      case 'get':
        return {
          text: this.text(
            await this.cli(
              ['get', ...digest, '--session', session, '--', action.format, action.target],
              signal,
              device,
            ),
          ),
        }
      case 'alert':
        return {
          text: this.text(
            await this.cli(
              [
                'alert',
                '--session',
                session,
                '--',
                action.action,
                ...(action.timeoutMs === undefined ? [] : [String(action.timeoutMs)]),
              ],
              signal,
              device,
            ),
          ),
        }
      case 'keyboard':
        return {
          text: this.text(
            await this.cli(['keyboard', '--session', session, '--', action.action], signal, device),
          ),
        }
      case 'batch':
        return {
          text: this.text(
            await this.cli(
              [
                'batch',
                '--steps',
                JSON.stringify(action.steps),
                ...(action.stopOnError ? ['--on-error', 'stop'] : []),
                '--max-steps',
                String(action.steps.length),
                ...digest,
                '--session',
                session,
              ],
              signal,
              device,
            ),
          ),
        }
      case 'scroll':
        return {
          text: this.text(
            await this.cli(
              ['scroll', action.direction, '--settle', '--session', session],
              signal,
              device,
            ),
          ),
        }
      case 'swipe':
        return {
          text: this.text(
            await this.cli(
              [
                'gesture',
                'pan',
                String(action.from.x),
                String(action.from.y),
                String(action.to.x - action.from.x),
                String(action.to.y - action.from.y),
                '--session',
                session,
              ],
              signal,
              device,
            ),
          ),
        }
      case 'button': {
        const args =
          action.button === 'home'
            ? ['home']
            : action.button === 'back'
              ? ['back']
              : action.button === 'recents'
                ? ['app-switcher']
                : [
                    'hardware-button',
                    action.button === 'lock'
                      ? 'power'
                      : action.button === 'volumeUp'
                        ? 'volume-up'
                        : 'volume-down',
                  ]
        return { text: this.text(await this.cli([...args, '--session', session], signal, device)) }
      }
      case 'rotate':
        return {
          text: this.text(
            await this.cli(
              ['orientation', action.orientation.replace(/_/g, '-'), '--session', session],
              signal,
              device,
            ),
          ),
        }
      case 'terminate':
        return {
          text: this.text(
            await this.cli(['close', action.app, '--session', session], signal, device),
          ),
        }
      case 'logs':
        return this.logs(session, device, action, signal)
      case 'record_start':
        return this.startRecording(sessionId, session, device, action, folder, signal)
      case 'screenshot_compare':
        return this.compare(session, device, action, folder, signal)
      case 'network':
        return this.network(session, device, action, signal)
      case 'push': {
        if (device.platform === 'ios' && device.kind !== 'simulator') {
          throw new ActionError('unsupported', 'Test notifications go to iOS simulators only.')
        }
        const app = action.app ?? this.apps.get(session)?.app
        if (!app) {
          throw new ActionError(
            'no_app',
            'Name the app, or launch it with device_launch_app first.',
          )
        }
        const out = await this.cli(
          ['push', '--session', session, '--json', '--', app, JSON.stringify(action.payload)],
          signal,
          device,
        )
        const data = parsed(out) ?? {}
        return {
          text:
            typeof data.message === 'string' ? data.message : `Pushed a notification to ${app}.`,
          structured: { app, ...data },
        }
      }
      case 'perf':
        return this.perf(session, device, signal)
      case 'reset_app': {
        await this.cli(
          ['settings', '--session', session, '--', 'clear-app-state', action.app],
          signal,
          device,
        )
        let text = `Cleared the data of ${action.app}. Launch it again to see it as freshly installed.`
        if (action.keychain) {
          await this.cli(
            ['settings', '--session', session, '--', 'reset-keychain', 'clear'],
            signal,
            device,
          )
          text += ' The simulator’s whole keychain was reset too, for every app on it.'
        }
        return { text, structured: { app: action.app, cleared: true, keychain: action.keychain } }
      }
      case 'screenshot': {
        const out = await this.cli(['screenshot', '--session', session, '--json'], signal, device)
        const file = (JSON.parse(out.stdout) as { data?: { path?: string } }).data?.path
        if (!file) throw new ActionError('screenshot', 'No screenshot was saved')
        const png = await readFile(file)
        await rm(file, { force: true })
        return { text: 'Screenshot of the device.', image: png.toString('base64') }
      }
      case 'appearance':
        return {
          text: this.text(
            await this.cli(
              ['settings', 'appearance', action.mode, '--session', session],
              signal,
              device,
            ),
          ),
        }
      case 'location':
        return {
          text: this.text(
            await this.cli(
              [
                'settings',
                'location',
                'set',
                String(action.latitude),
                String(action.longitude),
                '--session',
                session,
              ],
              signal,
              device,
            ),
          ),
        }
      case 'permission':
        return {
          text: this.text(
            await this.cli(
              [
                'settings',
                '--app',
                action.app,
                '--session',
                session,
                '--',
                'permission',
                action.state,
                action.permission,
              ],
              signal,
              device,
            ),
          ),
        }
    }
  }

  /**
   * Stops the recordings `match` picks, as record stop would, for a session that ended, a device
   * that was closed or moved, or the host that quits; each video stays in its session's folder.
   */
  async stopRecordings(match: (sessionId: string, deviceId: string) => boolean): Promise<void> {
    await Promise.all(
      [...this.recordings].map(async ([session, recording]) => {
        if (!match(recording.sessionId, recording.deviceId)) return
        await this.finishRecording(session)?.catch(() => undefined)
        this.recordings.delete(session)
      }),
    )
  }

  private async logs(
    session: string,
    device: FoundDevice,
    action: Extract<DeviceAction, { type: 'logs' }>,
    signal: AbortSignal,
  ): Promise<DeviceActionResult> {
    const launched = this.apps.get(session) ?? null
    const out = await this.cli(
      ['logs', 'path', '--json', '--session', session],
      signal,
      device,
      true,
    )
    const info = parsed(out)
    const file = typeof info?.path === 'string' ? info.path : null
    const tail = file
      ? await tailLines(file, action.lines).catch(() => ({
          lines: [] as string[],
          truncated: false,
        }))
      : { lines: [] as string[], truncated: false }
    const notes: string[] = []
    let capture = 'active'
    if (info?.active !== true) {
      const started = await this.cli(['logs', 'start', '--session', session], signal, device, true)
      capture = started.code === 0 ? 'started' : 'failed'
      notes.push(
        started.code === 0
          ? 'Log capture started for the app open in this session. Read the logs again after the app has run.'
          : this.failure(started).message,
      )
    }
    let crashes: CrashReport[] = []
    let since: number | null = null
    if (action.crashes) {
      if (launched) {
        since = launched.launchedAt
        crashes = await this.crashes(device, launched.app, since).catch((error: unknown) => {
          notes.push(
            `Crash reports could not be read: ${error instanceof Error ? error.message : String(error)}`,
          )
          return []
        })
      } else {
        notes.push('Launch the app with device_launch_app to read its crash reports too.')
      }
    }
    // Keep the newest lines when the whole answer would be too long.
    let lines = tail.lines
    let truncated = tail.truncated
    const crashText = JSON.stringify(crashes).length
    while (lines.length > 0 && lines.join('\n').length + crashText > MAX_ANSWER) {
      lines = lines.slice(Math.ceil(lines.length / 4))
      truncated = true
    }
    const parts = [lines.length > 0 ? lines.join('\n') : 'No log lines yet.']
    if (action.crashes && launched) {
      parts.push(
        crashes.length === 0
          ? `No crash reports for ${launched.app} since it started.`
          : [
              `Crash reports for ${launched.app} since it started:`,
              ...crashes.map((crash) => `${crash.time} ${crash.summary}\n${crash.excerpt}`),
            ].join('\n\n'),
      )
    }
    parts.push(...notes)
    return {
      text: parts.join('\n\n'),
      structured: {
        app: launched?.app ?? null,
        capture,
        lines,
        truncated,
        ...(action.crashes
          ? { crashes, crashesSince: since && new Date(since).toISOString() }
          : {}),
        ...(notes.length ? { notes } : {}),
      },
    }
  }

  /** The app's crash reports since `since`, by the device's own means. */
  private async crashes(device: FoundDevice, app: string, since: number): Promise<CrashReport[]> {
    if (device.platform === 'android') {
      const { adb } = await this.tools()
      if (!adb) return []
      return readAndroidCrashes(adb, device.target, app, since, await this.env())
    }
    if (device.kind === 'simulator' && process.platform === 'darwin') {
      return readIosSimulatorCrashes(device.target, app, since)
    }
    throw new Error('A physical iPhone’s crash reports are in Xcode’s Devices window.')
  }

  private async startRecording(
    sessionId: string,
    session: string,
    device: FoundDevice,
    action: Extract<DeviceAction, { type: 'record_start' }>,
    folder: string | null,
    signal: AbortSignal,
  ): Promise<DeviceActionResult> {
    const running = this.recordings.get(session)
    if (running && !running.stopped) {
      throw new ActionError(
        'busy',
        'A recording already runs; stop it with device_record_stop first.',
      )
    }
    const files = await this.files(folder)
    const dir = await files.captures('recordings')
    const file = path.join(dir, `${action.name ?? stamp(new Date())}.mp4`)
    if (await exists(file)) {
      throw new ActionError(
        'exists',
        `${files.relative(file)} exists; give the recording another name.`,
      )
    }
    // The app's scope draws the touches; with no app launched, the whole screen is recorded.
    const scope = this.apps.has(session) ? [] : ['--scope', 'device']
    await this.cli(
      ['record', 'start', ...scope, '--session', session, '--json', '--', file],
      signal,
      device,
    )
    const timer = setTimeout(() => {
      const recording = this.recordings.get(session)
      if (recording) recording.atLimit = true
      void this.finishRecording(session)?.catch(() => undefined)
    }, MAX_DEVICE_RECORDING_MS)
    timer.unref?.()
    this.recordings.set(session, {
      sessionId,
      deviceId: device.id,
      device,
      files,
      path: file,
      startedAt: Date.now(),
      timer,
    })
    const minutes = MAX_DEVICE_RECORDING_MS / 60_000
    return {
      text: `Recording the screen into ${files.relative(file)}. It stops by itself after ${minutes} minutes; device_record_stop stops it sooner and shows it.`,
      structured: { recording: 'started', path: files.relative(file), limitSeconds: minutes * 60 },
    }
  }

  /** Stops the session's recording, once, and settles with the video it saved. */
  private finishRecording(session: string): Promise<DeviceActionResult> | null {
    const recording = this.recordings.get(session)
    if (!recording) return null
    recording.stopped ??= (async () => {
      clearTimeout(recording.timer)
      // Stopping is not the turn's to cancel: the video would be lost.
      const out = await this.cli(
        ['record', 'stop', '--session', session, '--json'],
        new AbortController().signal,
        recording.device,
      )
      const data = parsed(out) ?? {}
      const given = typeof data.outPath === 'string' ? data.outPath : recording.path
      const file = path.resolve(given)
      const size = (await stat(file).catch(() => null))?.size ?? null
      const duration =
        typeof data.durationMs === 'number' ? data.durationMs : Date.now() - recording.startedAt
      const chunks = Array.isArray(data.chunks)
        ? data.chunks
            .map((chunk) => (chunk as { path?: unknown }).path)
            .filter((chunk): chunk is string => typeof chunk === 'string')
            .map((chunk) => recording.files.relative(path.resolve(chunk)))
        : []
      const shown = recording.files.relative(file)
      const lines = [
        `${recording.atLimit ? 'The recording stopped at its limit and was saved' : 'Saved the recording'} to ${shown} (${clock(duration)}${size !== null ? `, ${megabytes(size)}` : ''}).`,
      ]
      if (chunks.length > 1) lines.push(`It came in ${chunks.length} parts: ${chunks.join(', ')}.`)
      if (typeof data.warning === 'string') lines.push(data.warning)
      return {
        text: lines.join('\n'),
        structured: {
          recording: 'stopped',
          path: shown,
          durationMs: duration,
          ...(size !== null ? { sizeBytes: size } : {}),
          ...(chunks.length > 1 ? { chunks } : {}),
          stoppedAtLimit: recording.atLimit === true,
        },
        ...(recording.files.holds(file) ? { file: { path: file, mimeType: 'video/mp4' } } : {}),
      }
    })()
    return recording.stopped
  }

  private async stopRecording(session: string): Promise<DeviceActionResult> {
    const stopping = this.finishRecording(session)
    if (!stopping) {
      throw new ActionError('not_recording', 'No recording runs on this device in this session.')
    }
    try {
      const result = await stopping
      this.recordings.delete(session)
      return result
    } catch (error) {
      // agent-device keeps what a second record stop reads back.
      const recording = this.recordings.get(session)
      if (recording) delete recording.stopped
      throw error
    }
  }

  private async compare(
    session: string,
    device: FoundDevice,
    action: Extract<DeviceAction, { type: 'screenshot_compare' }>,
    folder: string | null,
    signal: AbortSignal,
  ): Promise<DeviceActionResult> {
    const files = await this.files(folder)
    const shots = await files.captures('shots')
    const latest = path.join(shots, `${session}-latest.png`)
    const previous = path.join(shots, `${session}-previous.png`)
    const taken = path.join(shots, `${session}-new.png`)
    // A status bar that shows the time would differ in every shot.
    const steady =
      device.platform === 'android' || device.kind === 'simulator' ? ['--normalize-status-bar'] : []
    await this.cli(
      ['screenshot', ...steady, '--session', session, '--json', '--', taken],
      signal,
      device,
    )
    if (!(await exists(taken))) throw new ActionError('screenshot', 'No screenshot was saved')
    if (await exists(latest)) await rename(latest, previous)
    await rename(taken, latest)
    let baseline: string
    if (action.baseline !== undefined) {
      baseline = await files.file(action.baseline, true)
      if (!(await exists(baseline))) {
        await copyFile(latest, baseline)
        return {
          text: `Saved this shot as the baseline ${files.relative(baseline)}; nothing was compared yet.`,
          structured: { compared: false, baseline: files.relative(baseline), saved: true },
        }
      }
    } else if (await exists(previous)) {
      baseline = previous
    } else {
      return {
        text: 'Took the first shot; the next comparison compares with it.',
        structured: { compared: false, current: files.relative(latest) },
      }
    }
    const diff = path.join(await files.captures('diffs'), `${session}.png`)
    await rm(diff, { force: true })
    const out = await this.cli(
      [
        'diff',
        'screenshot',
        '--baseline',
        baseline,
        '--out',
        diff,
        ...(action.threshold === undefined ? [] : ['--threshold', String(action.threshold)]),
        '--session',
        session,
        '--json',
        '--',
        latest,
      ],
      signal,
      device,
    )
    const data = parsed(out) ?? {}
    if (action.update) await copyFile(latest, baseline)
    const regions = Array.isArray(data.regions)
      ? data.regions.slice(0, 8).map((region) => {
          const r = region as Record<string, unknown>
          return {
            rect: r.rect,
            differentPixels: r.differentPixels,
            location: r.location,
            change: r.dominantChange,
          }
        })
      : []
    const percent = typeof data.mismatchPercentage === 'number' ? data.mismatchPercentage : null
    const structured = {
      compared: true,
      match: data.match === true,
      mismatchPercent: percent,
      differentPixels: data.differentPixels,
      totalPixels: data.totalPixels,
      regions,
      baseline: files.relative(baseline),
      current: files.relative(latest),
      ...((await exists(diff)) ? { diff: files.relative(diff) } : {}),
      ...(action.update ? { baselineUpdated: true } : {}),
    }
    const diffSize = (await stat(diff).catch(() => null))?.size
    const image =
      diffSize !== undefined && diffSize <= MAX_INLINE_IMAGE
        ? (await readFile(diff)).toString('base64')
        : undefined
    const said =
      data.match === true
        ? 'The screen matches the baseline.'
        : `${percent ?? '?'}% of the pixels differ from the baseline.`
    return { text: `${said}\n${jsonText(structured)}`, structured, ...(image ? { image } : {}) }
  }

  private async network(
    session: string,
    device: FoundDevice,
    action: Extract<DeviceAction, { type: 'network' }>,
    signal: AbortSignal,
  ): Promise<DeviceActionResult> {
    const out = await this.cli(
      [
        'network',
        '--session',
        session,
        '--json',
        '--',
        'dump',
        String(action.limit),
        action.include,
      ],
      signal,
      device,
    )
    const data = parsed(out) ?? {}
    if (data.active === false) {
      const started = await this.cli(['logs', 'start', '--session', session], signal, device, true)
      if (started.code !== 0) throw this.failure(started)
      return {
        text: 'Started the app’s log capture, which the network activity comes from. Make the requests, then call again.',
        structured: { active: false, captureStarted: true, entries: [] },
      }
    }
    let entries = Array.isArray(data.entries) ? data.entries : []
    let truncated = false
    while (entries.length > 1 && JSON.stringify(entries).length > MAX_ANSWER) {
      entries = entries.slice(1)
      truncated = true
    }
    const structured = {
      entries,
      ...(truncated ? { truncated } : {}),
      ...(Array.isArray(data.notes) && data.notes.length ? { notes: data.notes } : {}),
    }
    return {
      text: entries.length
        ? jsonText(structured)
        : `No requests in the app’s log yet.${structured.notes ? `\n${jsonText(structured.notes)}` : ''}`,
      structured,
    }
  }

  private async perf(
    session: string,
    device: FoundDevice,
    signal: AbortSignal,
  ): Promise<DeviceActionResult> {
    const launched = this.apps.get(session)
    if (!launched) {
      throw new ActionError('no_app', 'Launch the app with device_launch_app first.')
    }
    const notes: string[] = []
    const memoryOut = await this.cli(
      ['perf', '--session', session, '--json', '--', 'memory', 'sample'],
      signal,
      device,
      true,
    )
    const data = parsed(memoryOut)
    const memory =
      memoryOut.code === 0
        ? ((data?.metrics as { memory?: unknown } | undefined)?.memory ?? data)
        : null
    if (memoryOut.code !== 0) notes.push(`Memory: ${this.failure(memoryOut).message}`)
    let cpu: CpuSample | null = null
    try {
      cpu = await this.cpu(device, launched.app, signal)
      if (!cpu) notes.push(`CPU: ${launched.app} is not running.`)
    } catch (error) {
      notes.push(`CPU: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (signal.aborted) throw new ActionError('stopped', 'The user stopped the agent')
    const structured = {
      app: launched.app,
      cpu,
      memory,
      ...(notes.length ? { notes } : {}),
    }
    return { text: jsonText(structured), structured }
  }

  private async cpu(
    device: FoundDevice,
    app: string,
    signal: AbortSignal,
  ): Promise<CpuSample | null> {
    const tools = await this.tools()
    const env = await this.env()
    if (device.platform === 'android') {
      if (!tools.adb) throw new Error('adb was not found')
      return androidCpu(tools.adb, device.target, app, env)
    }
    if (device.kind === 'simulator' && tools.xcrun && process.platform === 'darwin') {
      return simulatorCpu(tools.xcrun, device.target, app, env, signal)
    }
    throw new Error('A physical iPhone’s CPU is sampled with Instruments.')
  }

  private async files(folder: string | null): Promise<SessionFiles> {
    try {
      return await SessionFiles.open(folder)
    } catch (error) {
      if (error instanceof CaptureError) throw new ActionError('no_folder', error.message)
      throw error
    }
  }

  /** Ends the agent-device sessions of a Kettu session, leaving the devices as they are. */
  async endSession(sessionId: string, devices: FoundDevice[]): Promise<void> {
    for (const device of devices) {
      const session = this.sessionName(sessionId, device)
      if (!this.opened.delete(session)) continue
      await this.cli(
        ['close', '--session', session],
        new AbortController().signal,
        device,
        true,
      ).catch(() => undefined)
    }
  }

  private async ensureSession(
    session: string,
    device: FoundDevice,
    selector: string[],
    signal: AbortSignal,
  ): Promise<void> {
    if (this.opened.has(session)) return
    const out = await this.cli(['open', ...selector, '--session', session], signal, device, true)
    if (out.code !== 0 && !/already/i.test(out.stdout + out.stderr)) throw this.failure(out)
    this.opened.add(session)
  }

  private selector(device: FoundDevice): string[] {
    return device.platform === 'ios'
      ? ['--platform', 'ios', '--udid', device.target]
      : ['--platform', 'android', '--serial', device.target]
  }

  private sessionName(sessionId: string, device: FoundDevice): string {
    const hash = createHash('sha256')
      .update(`${sessionId}\0${device.id}`)
      .digest('hex')
      .slice(0, 12)
    return `kettu-${hash}`
  }

  private text(out: Output): string {
    const text = out.stdout.trim()
    return text.length > 0 ? text : 'Done.'
  }

  private failure(out: Output): ActionError {
    const text = `${out.stdout}\n${out.stderr}`.trim()
    const code = /Error \(([A-Z_]+)\)/.exec(text)?.[1] ?? 'command_failed'
    // The diagnostics lines point at agent-device's own files; the agent needs only the error.
    const message = text
      .split('\n')
      .filter((line) => !/^Diagnostic|^Diagnostics Log/.test(line))
      .join('\n')
      .slice(0, 4_000)
    return new ActionError(code, message || 'The device command failed')
  }

  private async cli(
    args: string[],
    signal: AbortSignal,
    device: FoundDevice,
    allowFailure = false,
  ): Promise<Output> {
    const base = await this.env()
    const extra: Env = {
      AGENT_DEVICE_HOME: path.join(this.dataDir, 'agent-device'),
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
    }
    // agent-device looks for adb on PATH; an SDK Kettu found elsewhere, as Homebrew's, joins it.
    const { adb, emulator } = await this.tools()
    const dirs = [adb, emulator]
      .filter((file): file is string => !!file)
      .map((file) => path.dirname(file))
    if (dirs.length > 0) {
      const sdk = adb ? path.dirname(path.dirname(adb)) : null
      extra.PATH = [...new Set(dirs), base.PATH].filter(Boolean).join(path.delimiter)
      if (sdk && !base.ANDROID_HOME && !base.ANDROID_SDK_ROOT) extra.ANDROID_HOME = sdk
    }
    if (device.platform === 'ios' && device.kind === 'physical') {
      this.team ??= developmentTeam(base)
      const team = await this.team
      if (team) extra.AGENT_DEVICE_IOS_TEAM_ID = team
    }
    const node = nodeCommand({ ...base, ...extra } as NodeJS.ProcessEnv)
    const out = await new Promise<Output>((resolve, reject) => {
      const child = spawn(node.file, [cli(), ...args], {
        env: node.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString()
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString()
      })
      const timer = setTimeout(() => child.kill('SIGTERM'), COMMAND_TIMEOUT_MS)
      const abort = (): void => {
        child.kill('SIGTERM')
      }
      signal.addEventListener('abort', abort, { once: true })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        resolve({ code, stdout, stderr })
      })
    })
    if (signal.aborted) throw new ActionError('stopped', 'The user stopped the agent')
    if (out.code !== 0) {
      this.log(`agent-device ${args[0]} failed: ${(out.stderr || out.stdout).slice(0, 500)}`)
      if (!allowFailure) throw this.failure(out)
    }
    return out
  }
}
