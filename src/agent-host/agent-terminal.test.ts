import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledCli } from '@shared/agent-host'
import {
  ANTIGRAVITY,
  CLAUDE_CODE,
  CODEX,
  DEEPSEEK,
  DOUBAO,
  DROID,
  fakeAgent,
  GEMINI,
  GOOSE,
  OPENCODE,
  PI,
  QWEN,
  type AgentDefinition,
  type Detection,
  type LaunchSpec,
} from './catalog'
import {
  GRANT_MS,
  inFolder,
  terminalLine,
  terminalProgram,
  terminalWords,
  TerminalGrants,
  validResumeId,
} from './agent-terminal'
import type { Platform } from '@shared/platform'

const UUID = '3f2c1e7a-9b4d-4c2e-8f1a-6d5e4c3b2a10'

function withCli(path: string, more: Partial<InstalledCli> = {}): Detection {
  return {
    state: 'available',
    spec: null,
    adapter: null,
    cli: { path, version: '1.0.0', variable: null, problem: null, ...more },
  }
}

function withSpec(command: string, args: string[], env: Record<string, string> = {}): Detection {
  const spec: LaunchSpec = { command, args, env, shell: false, display: { command, args, env } }
  return { state: 'available', spec, adapter: null }
}

/** The line that starts the agent, or resumes `id`, with `env` added, for `platform`'s shell. */
function line(
  def: AgentDefinition,
  detection: Detection,
  platform: Platform,
  env: Record<string, string> = {},
  id?: string,
): string | null {
  const program = terminalProgram(def, detection)
  const words = program && terminalWords(def, program, env, id)
  return words && terminalLine(words, platform)
}

describe('the line that starts an agent’s own CLI', () => {
  it("runs npm's .cmd shim on Windows, where PowerShell refuses the .ps1 beside it", () => {
    const codex = withCli('C:\\Users\\Ann\\AppData\\Roaming\\npm\\node_modules\\codex.exe', {
      launcher: 'C:\\Users\\Ann\\AppData\\Roaming\\npm\\codex.cmd',
    })
    expect(line(CODEX, codex, 'win32')).toBe('C:\\Users\\Ann\\AppData\\Roaming\\npm\\codex.cmd')
    const doubao = withCli('C:\\Users\\Ann\\AppData\\Local\\doubao_cli\\app\\current\\doubao.exe', {
      launcher: 'C:\\Users\\Ann\\AppData\\Roaming\\npm\\doubao.cmd',
    })
    expect(line(DOUBAO, doubao, 'win32')).toBe('C:\\Users\\Ann\\AppData\\Roaming\\npm\\doubao.cmd')
  })

  it('sets the configuration folder as PowerShell does, with no &&, and as POSIX does', () => {
    const windows = withCli('C:\\Users\\Ann\\.local\\bin\\claude.exe')
    const env = { CLAUDE_CONFIG_DIR: "C:\\Users\\Ann\\Ann's claude" }
    const ps = line(CLAUDE_CODE, windows, 'win32', env)
    expect(ps).toBe(
      "$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\Ann\\Ann''s claude'; C:\\Users\\Ann\\.local\\bin\\claude.exe",
    )
    expect(ps).not.toContain('&&')
    const mac = withCli('/Users/ann/.local/bin/claude')
    expect(line(CLAUDE_CODE, mac, 'darwin', { CLAUDE_CONFIG_DIR: '/Users/ann/claude work' })).toBe(
      "CLAUDE_CONFIG_DIR='/Users/ann/claude work' /Users/ann/.local/bin/claude",
    )
  })

  it('calls a quoted program through the call operator', () => {
    const agy = withCli("C:\\Program Files\\Ann's agy\\agy.exe")
    expect(line(ANTIGRAVITY, agy, 'win32')).toBe("& 'C:\\Program Files\\Ann''s agy\\agy.exe'")
  })

  it('runs a package Kite installed as node and its entry, without the protocol’s arguments', () => {
    const entry = 'C:\\Users\\Ann\\.huli\\harnesses\\gemini\\0.70.0\\node_modules\\gemini.js'
    const gemini = withSpec('C:\\Program Files\\nodejs\\node.exe', [entry, '--acp'])
    expect(line(GEMINI, gemini, 'win32')).toBe(`& 'C:\\Program Files\\nodejs\\node.exe' ${entry}`)
    // Its updater stays off, as for Kite's own runs of it; `exec` and its output mode go.
    const droid = withSpec('/usr/bin/node', ['/h/droid/bin.js', 'exec', '--output-format', 'x'])
    expect(line(DROID, droid, 'linux')).toBe(
      'DROID_DISABLE_AUTO_UPDATE=true FACTORY_DROID_AUTO_UPDATE_ENABLED=false /usr/bin/node /h/droid/bin.js',
    )
  })

  it('runs a program with the arguments its interactive UI takes', () => {
    expect(line(GOOSE, withSpec('/opt/goose/goose', ['acp']), 'darwin')).toBe(
      '/opt/goose/goose session',
    )
    expect(line(DEEPSEEK, withSpec('/usr/bin/node', ['/h/dsh/lib/bin.js']), 'linux')).toBe(
      '/usr/bin/node /h/dsh/lib/bin.js --profile web',
    )
    // The fake agent's stand-in runs on the PATH's Node.js, which a Windows shell waits for.
    const script = 'C:\\app\\tools\\fake-agent\\main.ts'
    const electron = withSpec('C:\\app\\electron.exe', [script], RUN_AS_NODE)
    expect(line(fakeAgent(script), electron, 'win32')).toBe(`node ${script} --terminal`)
    // Another script runs on the runtime Kite gives it.
    const other: AgentDefinition = { ...fakeAgent(script), terminal: { args: ['--terminal'] } }
    expect(line(other, electron, 'win32')).toBe(
      `$env:ELECTRON_RUN_AS_NODE = '1'; C:\\app\\electron.exe ${script} --terminal`,
    )
  })

  it('offers nothing without an interactive CLI, or one that was not found or cannot run', () => {
    const noUi: AgentDefinition = { ...GEMINI, terminal: undefined }
    expect(terminalProgram(noUi, withSpec('/usr/bin/node', ['/x.js', '--acp']))).toBeNull()
    expect(terminalProgram(CLAUDE_CODE, null)).toBeNull()
    expect(
      terminalProgram(CLAUDE_CODE, {
        state: 'not-installed',
        detail: 'missing',
        reason: { kind: 'not-installed' },
      }),
    ).toBeNull()
    const old = withCli('/bin/claude', { problem: { kind: 'too-old', minimum: '9.0.0' } })
    expect(terminalProgram(CLAUDE_CODE, old)).toBeNull()
    // Claude Code runs its SDK in the host; only the user's CLI starts in a terminal.
    expect(terminalProgram(CLAUDE_CODE, withSpec('/sdk/entry.mjs', []))).toBeNull()
  })

  it('refuses a line a control character would break', () => {
    expect(line(CLAUDE_CODE, withCli('/bin/claude\nrm -rf ~'), 'linux')).toBeNull()
    expect(line(CLAUDE_CODE, withCli('/bin/claude'), 'linux', { CLAUDE_CONFIG_DIR: 'a\rb' })).toBe(
      null,
    )
  })
})

describe('the line that resumes a session in its agent’s CLI', () => {
  it('passes each CLI its own resume arguments', () => {
    const posix = (def: AgentDefinition, id: string, detection = withCli('/bin/x')) =>
      line(def, detection, 'linux', {}, id)
    expect(posix(CLAUDE_CODE, UUID)).toBe(`/bin/x --resume ${UUID}`)
    expect(posix(CODEX, UUID)).toBe(`/bin/x resume ${UUID}`)
    expect(posix(DOUBAO, 'conv_123')).toBe('/bin/x --resume conv_123')
    expect(posix(OPENCODE, 'ses_4f2a9c')).toBe('/bin/x --session ses_4f2a9c')
    expect(posix(ANTIGRAVITY, UUID)).toBe(`/bin/x --conversation ${UUID}`)
    expect(posix(PI, '/home/ann/.pi/agent/sessions/--work--/1_a b.jsonl')).toBe(
      "/bin/x --session '/home/ann/.pi/agent/sessions/--work--/1_a b.jsonl'",
    )
    const node = withSpec('/usr/bin/node', ['/h/cli.js', '--acp'])
    expect(posix(GEMINI, UUID, node)).toBe(`/usr/bin/node /h/cli.js --resume ${UUID}`)
    expect(posix(QWEN, UUID, node)).toBe(`/usr/bin/node /h/cli.js --resume ${UUID}`)
  })

  it('carries the folder the session was made in, quoted for PowerShell', () => {
    const codex = withCli('C:\\bin\\codex.exe', { launcher: 'C:\\npm\\codex.cmd' })
    expect(line(CODEX, codex, 'win32', { CODEX_HOME: 'C:\\Users\\Ann\\codex 2' }, UUID)).toBe(
      `$env:CODEX_HOME = 'C:\\Users\\Ann\\codex 2'; C:\\npm\\codex.cmd resume ${UUID}`,
    )
  })

  it('resumes nothing for a CLI without resume, or by an id that is not one', () => {
    const dsh = withSpec('/usr/bin/node', ['/h/dsh/lib/bin.js'])
    expect(line(DEEPSEEK, dsh, 'linux', {}, UUID)).toBeNull()
    for (const id of [
      '',
      '-r',
      `${UUID}\nrm -rf ~`,
      `${UUID}\r`,
      'a b',
      "x'; rm -rf ~; '",
      'x'.repeat(201),
    ]) {
      expect(validResumeId(id)).toBe(false)
      expect(line(CLAUDE_CODE, withCli('/bin/claude'), 'linux', {}, id)).toBeNull()
    }
    expect(validResumeId(UUID)).toBe(true)
    expect(validResumeId('C:\\Users\\Ann\\.pi\\s.jsonl')).toBe(true)
  })
})

describe('the line to paste, after a change to the session’s folder', () => {
  it('is PowerShell’s on a Windows host and POSIX’s elsewhere, whatever the path looks like', () => {
    expect(inFolder("C:\\work\\Ann's app", 'claude --resume x', 'win32')).toBe(
      "Set-Location -LiteralPath 'C:\\work\\Ann''s app'; claude --resume x",
    )
    expect(inFolder("/work/Ann's app", 'claude --resume x', 'darwin')).toBe(
      "cd '/work/Ann'\\''s app' && claude --resume x",
    )
    // A Linux folder may be named like a Windows path; the host's platform decides.
    expect(inFolder('C:\\x', 'codex resume y', 'linux')).toBe("cd 'C:\\x' && codex resume y")
  })
})

describe('the resumes a terminal may run', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('lets a resume run for a while after it was asked for, and tells each change', () => {
    const changed = vi.fn()
    const grants = new TerminalGrants(changed)
    grants.grant('claude --resume a')
    expect(grants.lines()).toEqual(['claude --resume a'])
    expect(changed).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(GRANT_MS - 1)
    expect(grants.lines()).toEqual(['claude --resume a'])
    vi.advanceTimersByTime(1)
    expect(grants.lines()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
    grants.dispose()
  })

  it('keeps only the newest resumes', () => {
    const grants = new TerminalGrants(() => {})
    for (let i = 0; i < 40; i++) grants.grant(`codex resume ${i}`)
    const lines = grants.lines()
    expect(lines).toHaveLength(32)
    expect(lines[0]).toBe('codex resume 8')
    expect(lines.at(-1)).toBe('codex resume 39')
    grants.dispose()
    expect(grants.lines()).toEqual([])
  })
})

const RUN_AS_NODE = { ELECTRON_RUN_AS_NODE: '1' }
