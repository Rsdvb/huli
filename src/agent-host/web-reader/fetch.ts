// Huli: one read of a page with `moli fetch`, a process of its own that ends with the read, so
// nothing of Moli runs between reads. Its traffic goes the agent's way out (its Agent network
// node, else Kite's proxy), named on the command line with every proxy variable removed from its
// environment; private addresses are blocked for every request the page makes, but the loopback
// for a read of the session's own dev server. Huli's own; see tools/huli/README.md (Background web
// reading).

import { spawn } from 'node:child_process'
import { NODE_NO_PROXY } from '@shared/agent-network'
import type { Platform } from '@shared/platform'
import { deleteEnv, type Env } from '../find-command'
import { withoutElectronVars } from '../shell-env'
import type { ReadRequest } from './policy'

/** The proxy a read goes through, as the agent's environment names it; null to go directly. */
export interface ReadEgress {
  proxy: string | null
  noProxy: string | null
}

/** The private ranges a page may not reach, but the loopback. */
const LAN_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
  'fe80::/10',
]

const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']
/** A page's whole response is held in memory, so one larger than this is refused. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
/** What stderr is kept of, for the error a failed read reports. */
const MAX_STDERR_BYTES = 16 * 1024
/** Moli's own limit is the read's; past it plus this, the process is ended. */
const KILL_GRACE_MS = 15_000

export const NO_MATCH = 'KITE_NO_MATCH'

/** The script run after the page is ready: the matches' text, or the page cut to the matches. */
export function evalScript(request: Pick<ReadRequest, 'format' | 'selector'>): string | null {
  const { format, selector } = request
  if (format === 'text') {
    if (!selector) return '(document.body ?? document.documentElement).innerText'
    return (
      `(() => { const found = [...document.querySelectorAll(${JSON.stringify(selector)})]; ` +
      `if (found.length === 0) throw new Error(${JSON.stringify(NO_MATCH)}); ` +
      `return found.map((el) => el.innerText).join('\\n\\n') })()`
    )
  }
  if (!selector) return null
  return (
    `(() => { const found = [...document.querySelectorAll(${JSON.stringify(selector)})]; ` +
    `if (found.length === 0) throw new Error(${JSON.stringify(NO_MATCH)}); ` +
    'if (found.some((el) => el === document.body || el === document.documentElement)) return; ' +
    'const outer = found.filter((el) => !found.some((other) => other !== el && other.contains(el))); ' +
    'document.body.replaceChildren(...outer) })()'
  )
}

/** The no-proxy list: the agent's, and always the private ranges, so those never reach a proxy. */
function noProxyList(egress: ReadEgress): string {
  const own = (egress.noProxy ?? '')
    .split(',')
    .map((entry) => entry.trim())
    // Moli takes host names, domains, addresses and CIDRs, without ports, brackets or wildcards.
    .filter((entry) => /^[A-Za-z0-9._:/-]+$/.test(entry) && !/^[^:]+:\d+$/.test(entry))
  return [...new Set([...NODE_NO_PROXY, ...own])].join(',')
}

/** `moli fetch`'s arguments, the address last; a script, when there is one, goes in on stdin. */
export function fetchArgs(request: ReadRequest, egress: ReadEgress, local: boolean): string[] {
  const args = ['fetch']
  const script = evalScript(request)
  if (request.format !== 'text') {
    args.push('--dump', request.format === 'semantic' ? 'semantic_tree_text' : 'markdown')
  }
  if (script !== null) args.push('--eval-file', '-')
  args.push('--wait', request.waitForJs ? 'domstable' : 'load')
  if (request.waitForSelector) args.push('--wait-selector', request.waitForSelector)
  args.push('--timeout-ms', String(request.timeoutSeconds * 1000))
  args.push('--fail-with-body')
  args.push('--http-max-response-size', String(MAX_RESPONSE_BYTES))
  if (local) args.push('--block-cidrs', LAN_CIDRS.join(','))
  else args.push('--block-private-networks')
  if (egress.proxy) {
    args.push('--http-proxy', egress.proxy)
    args.push('--http-no-proxy', noProxyList(egress))
  }
  args.push(request.url.href)
  return args
}

/** Moli's environment: the host's, without proxy variables or Moli's own, which the flags set. */
export function moliEnv(base: Env, platform: Platform): Env {
  const env = withoutElectronVars(base, platform)
  for (const name of PROXY_NAMES) {
    deleteEnv(env, name, platform)
    deleteEnv(env, name.toLowerCase(), platform)
  }
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith('MOLI_')) delete env[name]
  }
  return env
}

export interface RunResult {
  /** Exit 0 or 22 (an HTTP error status, with the body kept). */
  code: number | null
  stdout: string
  /** The output went past `maxBytes` and the rest was not read. */
  cut: boolean
  stderr: string
  timedOut: boolean
}

export interface RunOptions {
  env: Env
  stdin: string | null
  /** Moli's own limit, after which this ends it. */
  timeoutMs: number
  maxBytes: number
  signal?: AbortSignal
}

/** Runs Moli once and gathers its output, up to `maxBytes`; never rejects but for a spawn error. */
export function runMoli(program: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      env: options.env as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    let outBytes = 0
    let cut = false
    const err: Buffer[] = []
    let errBytes = 0
    let timedOut = false
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, options.timeoutMs + KILL_GRACE_MS)
    const onAbort = () => kill()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (cut) return
      const room = options.maxBytes - outBytes
      if (chunk.length > room) {
        out.push(chunk.subarray(0, room))
        outBytes = options.maxBytes
        cut = true
        kill()
        return
      }
      out.push(chunk)
      outBytes += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes >= MAX_STDERR_BYTES) return
      err.push(chunk.subarray(0, MAX_STDERR_BYTES - errBytes))
      errBytes += chunk.length
    })
    child.stdin.on('error', () => {})
    child.stdin.end(options.stdin ?? '')
    child.once('error', (error) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        cut,
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      })
    })
  })
}
