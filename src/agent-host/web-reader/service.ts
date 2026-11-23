// Huli: background web reading (后台读网页) on this host: Moli's download, its removal, and the
// reads `read_web_page` asks for. Nothing of it runs at rest: status is read from the install's
// record, the download runs only after the user turned the feature on, and each read is a `moli
// fetch` process that ends with it. Huli's own; see tools/huli/README.md (Background web reading).

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Platform } from '@shared/platform'
import { MOLI_VERSION, type WebReaderStatus, type WebReaderTask } from '@shared/web-reader'
import type { Caller } from '../artifacts/tools'
import type { Env } from '../find-command'
import { t } from '../i18n'
import type { Transport } from '../node-runtime/transport'
import type { LogFn } from '../storage'
import { evalScript, fetchArgs, moliEnv, NO_MATCH, runMoli, type ReadEgress } from './fetch'
import {
  findMoli,
  installMoli,
  removeLeftovers,
  removeMoli,
  type MoliInstall,
  type MoliInstallOptions,
} from './install'
import { checkPlace, parseReadInput, type ReadPlace } from './policy'
import { moliAsset, type MoliAsset } from './release'
import { pageResult, refusal, type WebReaderCalls } from './tools'

/** Progress reaches the windows at most this often, but for a change of phase. */
const PROGRESS_MS = 250
/** Reads at once; more wait their turn, so a burst of calls never runs a dozen browsers. */
const MAX_READS = 2
/** Bytes of Moli's output read per character asked for: Markdown of CJK text is 3 bytes each. */
const BYTES_PER_CHAR = 4
const EXTRA_BYTES = 256 * 1024

export interface WebReaderDeps {
  root: string
  platform: Platform
  arch: string
  musl?: () => boolean
  /** Kite's own way out, never an agent's node: the download goes as Kite's requests do. */
  transport: Transport
  log: LogFn
  /** Whether the user turned the feature on. */
  on(): boolean
  /** The session's agent's way out, by its environment; null for a session Kite does not hold. */
  egress(sessionId: string): ReadEgress | null
  /** Its sandbox and worktree ports; null for a session Kite does not hold. */
  place(sessionId: string): ReadPlace | null
  /** Whether the session's agent has a node listener of its own, which `agent` sandboxes need. */
  ownExit(sessionId: string): boolean
  /** The host's environment, which Moli runs with but for the proxy variables. */
  baseEnv(): Env
  /** The status changed, for the windows. */
  changed(status: WebReaderStatus): void
  install?: (options: MoliInstallOptions) => Promise<MoliInstall>
}

export class WebReaderService implements WebReaderCalls {
  private installed: MoliInstall | null = null
  private loaded: Promise<void> | null = null
  private task: WebReaderTask | null = null
  private running: Promise<MoliInstall> | null = null
  private controller: AbortController | null = null
  private reads = 0
  private readonly queue: (() => void)[] = []
  private lastSent = 0
  private sendTimer: ReturnType<typeof setTimeout> | null = null
  private found: { asset: MoliAsset | null } | null = null

  constructor(private readonly deps: WebReaderDeps) {}

  private get asset(): MoliAsset | null {
    this.found ??= {
      asset: moliAsset(this.deps.platform, this.deps.arch, this.deps.musl?.() ?? false),
    }
    return this.found.asset
  }

  /** Reads the install's record once, when first asked; nothing at the host's start. */
  private load(): Promise<void> {
    this.loaded ??= findMoli(this.deps.root, this.deps.platform).then(
      (install) => {
        this.installed = install
      },
      () => {},
    )
    return this.loaded
  }

  async status(): Promise<WebReaderStatus> {
    await this.load()
    return this.snapshot()
  }

  private snapshot(): WebReaderStatus {
    const asset = this.asset
    return {
      download: asset ? { version: MOLI_VERSION, bytes: asset.bytes } : null,
      installed: this.installed
        ? { version: this.installed.version, bytes: this.installed.bytes }
        : null,
      task: this.task,
    }
  }

  /** Downloads and installs the pinned release, or joins the download under way. */
  install(): Promise<MoliInstall> {
    if (this.running) return this.running
    if (this.task?.state === 'running') return Promise.reject(new Error(t('webReader.busy')))
    const asset = this.asset
    if (!asset) return Promise.reject(new Error(t('webReader.unsupported')))
    const controller = new AbortController()
    this.controller = controller
    this.setTask({
      kind: 'install',
      state: 'running',
      phase: 'downloading',
      progress: 0,
      error: null,
    })
    const run = (async () => {
      try {
        await this.load()
        const install = await (this.deps.install ?? installMoli)({
          root: this.deps.root,
          platform: this.deps.platform,
          asset,
          transport: this.deps.transport,
          signal: controller.signal,
          onProgress: (phase, progress) => this.progress(phase, progress),
        })
        this.installed = install
        this.deps.log('info', `Moli ${install.version} is installed`)
        this.setTask(null)
        return install
      } catch (error) {
        const message = (error as Error).message
        this.deps.log('warn', `Moli could not be installed: ${message}`)
        this.setTask(
          controller.signal.aborted
            ? null
            : {
                kind: 'install',
                state: 'failed',
                phase: this.task?.phase ?? 'downloading',
                progress: null,
                error: message,
              },
        )
        throw error
      } finally {
        this.running = null
        this.controller = null
      }
    })()
    this.running = run
    return run
  }

  /** Stops the download under way, or clears the failed one. */
  cancel(): void {
    if (this.controller) this.controller.abort()
    else if (this.task?.state === 'failed') this.setTask(null)
  }

  /** Deletes Moli; refused while a download or a read runs. */
  async remove(): Promise<WebReaderStatus> {
    if (this.running || this.task?.state === 'running') throw new Error(t('webReader.busy'))
    if (this.reads > 0) throw new Error(t('webReader.inUse'))
    await this.load()
    this.setTask({
      kind: 'remove',
      state: 'running',
      phase: 'removing',
      progress: null,
      error: null,
    })
    try {
      await removeMoli(this.deps.root, this.deps.platform)
      await removeLeftovers(this.deps.root, this.deps.platform)
      this.installed = null
      this.deps.log('info', 'Removed Moli')
      this.setTask(null)
    } catch (error) {
      this.installed = await findMoli(this.deps.root, this.deps.platform)
      this.setTask({
        kind: 'remove',
        state: 'failed',
        phase: 'removing',
        progress: null,
        error: (error as Error).message,
      })
      throw error
    }
    return this.snapshot()
  }

  /** The feature was turned on: download Moli unless it is there or on its way. */
  async turnedOn(): Promise<void> {
    await this.load()
    if (this.installed || this.running || !this.asset) return
    this.install().catch(() => {})
  }

  /** `read_web_page` for a caller: checked, then read in a Moli process of its own. */
  async read(caller: Caller, input: unknown): Promise<CallToolResult> {
    if (!this.deps.on()) {
      return refusal(
        'Background web reading is off. The user can turn on 后台读网页 (Moli) in Kite’s ' +
          'Settings › Features; propose it with change_settings only if a page really needs it.',
      )
    }
    const parsed = parseReadInput(input)
    if ('error' in parsed) return refusal(parsed.error)
    const request = parsed.ok
    const place = this.deps.place(caller.sessionId)
    const egress = this.deps.egress(caller.sessionId)
    if (!place || !egress) return refusal('The call names no session Kite holds.')
    const route = checkPlace(request.url, place)
    if ('error' in route) return refusal(route.error)
    if (place.sandbox?.network === 'agent' && !this.deps.ownExit(caller.sessionId)) {
      return refusal(
        "This session's sandbox sends its network only through its Agent network exit, and " +
          'its agent has none now.',
      )
    }
    await this.load()
    const install = this.installed
    if (!install) {
      if (this.task?.kind === 'install' && this.task.state === 'running') {
        const percent =
          this.task.progress === null ? '' : ` (${Math.round(this.task.progress * 100)}%)`
        return refusal(`Moli is still being downloaded${percent}. Try again in a minute.`)
      }
      return refusal(
        'Moli is not downloaded on this computer. The user can download it in Kite’s Settings › ' +
          'Browser › 后台读网页.',
      )
    }
    await this.turn()
    try {
      const started = Date.now()
      const result = await runMoli(install.program, fetchArgs(request, egress, route.ok.local), {
        env: moliEnv(this.deps.baseEnv(), this.deps.platform),
        stdin: evalScript(request),
        timeoutMs: request.timeoutSeconds * 1000,
        maxBytes: request.maxChars * BYTES_PER_CHAR + EXTRA_BYTES,
      })
      this.deps.log(
        'info',
        `read_web_page: ${request.url.origin} in ${Date.now() - started} ms, exit ${result.code}`,
      )
      if (result.timedOut) {
        return refusal(`Moli did not finish within ${request.timeoutSeconds} s and was stopped.`)
      }
      if (result.code !== 0 && result.code !== 22 && !result.cut) {
        return refusal(failure(result.stderr, request.selector))
      }
      return pageResult(
        {
          url: request.url.href,
          format: request.format,
          text: result.stdout,
          cut: result.cut,
          httpError: result.code === 22 ? httpStatus(result.stderr) : null,
        },
        request.maxChars,
      )
    } catch (error) {
      return refusal(`Moli could not start: ${(error as Error).message}`)
    } finally {
      this.release()
    }
  }

  private turn(): Promise<void> {
    if (this.reads < MAX_READS) {
      this.reads++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.reads++
        resolve()
      })
    })
  }

  private release(): void {
    this.reads--
    this.queue.shift()?.()
  }

  private progress(phase: WebReaderTask['phase'], progress: number | null): void {
    const previous = this.task
    if (!previous || previous.state !== 'running') return
    const phaseChanged = previous.phase !== phase
    this.task = { ...previous, phase, progress }
    if (phaseChanged) this.send()
    else this.sendSoon()
  }

  private setTask(task: WebReaderTask | null): void {
    this.task = task
    this.send()
  }

  private send(): void {
    if (this.sendTimer) clearTimeout(this.sendTimer)
    this.sendTimer = null
    this.lastSent = Date.now()
    this.deps.changed(this.snapshot())
  }

  private sendSoon(): void {
    if (this.sendTimer) return
    const wait = Math.max(0, this.lastSent + PROGRESS_MS - Date.now())
    this.sendTimer = setTimeout(() => this.send(), wait)
    this.sendTimer.unref?.()
  }
}

/** The status Moli reports for an HTTP error: `returned HTTP status 404`. */
function httpStatus(stderr: string): string {
  const match = /HTTP status ([1-5]\d\d)\b/.exec(stderr)
  return match ? `HTTP ${match[1]}` : 'with an HTTP error status'
}

/** Why a read failed, in words an agent can act on, from Moli's last lines. */
function failure(stderr: string, selector: string | null): string {
  if (stderr.includes(NO_MATCH)) {
    return `No element on the page matches the selector \`${selector ?? ''}\`.`
  }
  if (selector && /SyntaxError|DOMException/.test(stderr)) {
    return `The selector \`${selector}\` is not valid CSS.`
  }
  if (/blocked private network address/.test(stderr)) {
    return 'The page sent the read to an address on this computer or the local network, which read_web_page does not reach.'
  }
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const reason = lines.slice(-3).join(' ').slice(0, 600)
  return `Moli could not read the page${reason ? `: ${reason}` : '.'}`
}
