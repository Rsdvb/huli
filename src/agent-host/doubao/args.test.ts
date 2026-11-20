// How Kettu starts Doubao CLI: its command lines, which never carry the prompt, and the program it
// runs for the `doubao` found on PATH, which is never the PowerShell shim.

import { describe, expect, it } from 'vitest'
import type { CliFiles } from '../installed-cli'
import { exportArgs, listArgs, turnArgs } from './args'
import { dataFolder, nativeProgram, resolveProgram } from './program'

describe('Doubao CLI command lines', () => {
  it('puts -C first, reads the prompt from stdin and names the turn’s settings', () => {
    expect(
      turnArgs({
        cwd: 'C:\\work\\app',
        resume: null,
        model: '9',
        effort: 'high',
        mode: 'ask_always',
      }),
    ).toEqual([
      '-C',
      'C:\\work\\app',
      '-p',
      '-',
      '--output-format',
      'stream-json',
      '--model',
      '9',
      '--effort',
      'high',
      '--permission-mode',
      'ask_always',
    ])
  })

  it('resumes a conversation before the prompt, and leaves out what the session has none of', () => {
    expect(
      turnArgs({
        cwd: '/work/app',
        resume: '38455104568945666',
        model: null,
        effort: null,
        mode: 'always_allow',
      }),
    ).toEqual([
      '-C',
      '/work/app',
      '--resume',
      '38455104568945666',
      '-p',
      '-',
      '--output-format',
      'stream-json',
      '--permission-mode',
      'always_allow',
    ])
  })

  it('refuses an id, model, level or cursor that could read as an option', () => {
    const base = { cwd: '/w', resume: null, model: null, effort: null, mode: 'ask_risky' } as const
    expect(() =>
      turnArgs({ ...base, resume: '--dangerously-bypass-approvals-and-sandbox' }),
    ).toThrow()
    expect(() => turnArgs({ ...base, model: '-x' })).toThrow()
    expect(() => turnArgs({ ...base, effort: 'ultra' })).toThrow()
    expect(() => exportArgs('1 2')).toThrow()
    expect(() => listArgs(10, '--all')).toThrow()
    expect(listArgs(50, 'eyJza2lwIjo0fQ')).toEqual([
      '--list',
      '--limit',
      '50',
      '--json',
      '--cursor',
      'eyJza2lwIjo0fQ',
    ])
  })
})

function files(present: Record<string, string>, links: Record<string, string> = {}): CliFiles {
  return {
    isFile: async (file) => file in present,
    realpath: async (file) => links[file] ?? file,
    readText: async (file) => {
      const text = present[file]
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
  }
}

// npm 11's shim for the package's bin.
const SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@bytedance\\doubao-cli\\scripts\\run.cjs" %*',
].join('\r\n')

describe('the program Kettu runs for doubao', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
  const native = 'C:\\Users\\u\\AppData\\Local\\doubao_cli\\app\\current\\doubao.exe'
  const npm = 'C:\\Users\\u\\AppData\\Roaming\\npm'

  it('finds the data folder each platform’s launcher uses', () => {
    expect(dataFolder(env, 'win32', 'C:\\Users\\u')).toBe(
      'C:\\Users\\u\\AppData\\Local\\doubao_cli',
    )
    expect(dataFolder({}, 'darwin', '/Users/u')).toBe(
      '/Users/u/Library/Application Support/doubao_cli',
    )
    expect(dataFolder({ XDG_DATA_HOME: '/data' }, 'linux', '/home/u')).toBe('/data/doubao_cli')
    expect(dataFolder({ XDG_DATA_HOME: 'relative' }, 'linux', '/home/u')).toBe(
      '/home/u/.local/share/doubao_cli',
    )
    expect(nativeProgram({}, 'linux', '/home/u')).toBe(
      '/home/u/.local/share/doubao_cli/app/current/doubao',
    )
  })

  it('runs the native program for npm’s .cmd shim, without cmd.exe or Node.js', async () => {
    const found = `${npm}\\doubao.cmd`
    const fs = files({
      [found]: SHIM,
      [`${npm}\\node_modules\\@bytedance\\doubao-cli\\scripts\\run.cjs`]: '',
      [native]: '',
    })
    expect(await resolveProgram(found, 'win32', fs, env)).toBe(native)
  })

  it('swaps the PowerShell shim for the .cmd beside it', async () => {
    const fs = files({ [`${npm}\\doubao.cmd`]: SHIM, [native]: '' })
    expect(await resolveProgram(`${npm}\\doubao.ps1`, 'win32', fs, env)).toBe(native)
    expect(await resolveProgram(`${npm}\\doubao.ps1`, 'win32', files({}), env)).toBeNull()
  })

  it('keeps the launcher when the native program is missing, so it says what is wrong', async () => {
    const found = `${npm}\\doubao.cmd`
    expect(await resolveProgram(found, 'win32', files({ [found]: SHIM }), env)).toBe(found)
  })

  it('follows npm’s link to the launcher on macOS and Linux', async () => {
    const found = '/usr/local/bin/doubao'
    const program = '/home/u/.local/share/doubao_cli/app/current/doubao'
    const fs = files(
      { [found]: '', [program]: '' },
      { [found]: '/usr/local/lib/node_modules/@bytedance/doubao-cli/scripts/run.cjs' },
    )
    expect(await resolveProgram(found, 'linux', fs, { HOME: '/home/u' })).toBe(program)
  })

  it('leaves another program named doubao as it is', async () => {
    const found = '/opt/other/doubao'
    expect(await resolveProgram(found, 'linux', files({ [found]: '' }), { HOME: '/home/u' })).toBe(
      found,
    )
  })
})
