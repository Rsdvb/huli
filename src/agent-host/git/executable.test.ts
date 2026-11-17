// Where git is found: on PATH as the system would, never in the working directory, and where its
// installers put it when the app started with a PATH that lacks it.

import { describe, expect, it } from 'vitest'
import { createExec } from './exec'
import { findExecutable, findWindowsExecutable, knownLocations } from './executable'

/** A file system holding exactly `files`, compared as Windows does when `windows`. */
function holding(files: string[], windows = false) {
  const keys = new Set(files.map((file) => (windows ? file.toLowerCase() : file)))
  const asked: string[] = []
  const isFile = async (file: string): Promise<boolean> => {
    asked.push(file)
    return keys.has(windows ? file.toLowerCase() : file)
  }
  return { isFile, asked }
}

const WINDOWS_ENV = {
  Path: 'C:\\Windows\\system32;C:\\Windows',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\bea\\AppData\\Local',
}

describe('git on Windows', () => {
  it('is found where Git for Windows installs it when PATH lacks it', async () => {
    const { isFile } = holding(['C:\\Program Files\\Git\\cmd\\git.exe'], true)
    expect(await findExecutable('git', 'win32', WINDOWS_ENV, isFile)).toBe(
      'C:\\Program Files\\Git\\cmd\\git.exe',
    )
  })

  it('is found in the 32-bit and the per-user install too, in that order', async () => {
    const x86 = 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'
    const user = 'C:\\Users\\bea\\AppData\\Local\\Programs\\Git\\cmd\\git.exe'
    expect(
      await findExecutable('git', 'win32', WINDOWS_ENV, holding([x86, user], true).isFile),
    ).toBe(x86)
    expect(await findExecutable('git', 'win32', WINDOWS_ENV, holding([user], true).isFile)).toBe(
      user,
    )
  })

  it('is taken from PATH first, as the user set it', async () => {
    const env = { ...WINDOWS_ENV, Path: `D:\\tools\\git\\cmd;${WINDOWS_ENV.Path}` }
    const { isFile } = holding(
      ['D:\\tools\\git\\cmd\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe'],
      true,
    )
    expect(await findExecutable('git', 'win32', env, isFile)).toBe('D:\\tools\\git\\cmd\\git.exe')
  })

  it('reads the folders whatever the case of their variables', async () => {
    const env = { PATH: 'C:\\Windows', PROGRAMFILES: 'E:\\Apps', LocalAppData: 'E:\\Me' }
    expect(knownLocations('git', 'win32', env)).toEqual([
      'E:\\Apps\\Git\\cmd\\git.exe',
      'E:\\Me\\Programs\\Git\\cmd\\git.exe',
    ])
  })

  it('never looks in a relative or missing folder, or in the working directory', async () => {
    const env = { Path: 'tools;.;C:\\Windows', ProgramFiles: 'Program Files', LOCALAPPDATA: '' }
    expect(knownLocations('git', 'win32', env)).toEqual([])
    const { isFile, asked } = holding(['tools\\git.exe', 'git.exe'], true)
    expect(await findExecutable('git', 'win32', env, isFile)).toBeNull()
    expect(asked.every((file) => /^[A-Z]:\\/i.test(file))).toBe(true)
  })

  it('looks nowhere else for another command', async () => {
    expect(knownLocations('gh', 'win32', WINDOWS_ENV)).toEqual([])
    const { isFile } = holding(['C:\\Program Files\\Git\\cmd\\gh.exe'], true)
    expect(await findExecutable('gh', 'win32', WINDOWS_ENV, isFile)).toBeNull()
  })

  it('still runs only what can start without a shell from PATH', async () => {
    const { isFile } = holding(['C:\\Windows\\git.cmd', 'C:\\Windows\\git.exe'], true)
    expect(await findWindowsExecutable('git', WINDOWS_ENV, isFile)).toBe('C:\\Windows\\git.exe')
  })
})

describe('git on macOS and Linux', () => {
  // What a Finder or desktop launch gives the app.
  const minimal = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

  it('is found in Homebrew when the app started with a minimal PATH', async () => {
    const env = { PATH: '/bin' }
    const { isFile } = holding(['/opt/homebrew/bin/git', '/usr/local/bin/git'])
    expect(await findExecutable('git', 'darwin', env, isFile)).toBe('/opt/homebrew/bin/git')
    const intel = holding(['/usr/local/bin/git'])
    expect(await findExecutable('git', 'darwin', env, intel.isFile)).toBe('/usr/local/bin/git')
    const linux = holding(['/usr/bin/git'])
    expect(await findExecutable('git', 'linux', { PATH: '' }, linux.isFile)).toBe('/usr/bin/git')
  })

  it('is taken from PATH first, as the shell set it', async () => {
    const { isFile } = holding(['/usr/bin/git', '/opt/homebrew/bin/git'])
    expect(await findExecutable('git', 'darwin', minimal, isFile)).toBe('/usr/bin/git')
  })

  it('looks nowhere else for another command, or for a path', async () => {
    expect(knownLocations('gh', 'darwin', minimal)).toEqual([])
    expect(knownLocations('./git', 'linux', minimal)).toEqual([])
    const { isFile } = holding(['/opt/homebrew/bin/gh'])
    expect(await findExecutable('gh', 'darwin', minimal, isFile)).toBeNull()
  })
})

describe('running a command', () => {
  it('runs the file the lookup found, not the name', async () => {
    const { exec } = createExec(() => process.env, { find: async () => process.execPath })
    const result = await exec('git', ['-e', 'process.stdout.write("found")'], { timeoutMs: 10_000 })
    expect(result).toMatchObject({ code: 0, stdout: 'found' })
  })

  it('reports a command found nowhere on Windows without starting anything', async () => {
    const { exec } = createExec(() => ({}), { platform: 'win32', find: async () => null })
    expect(await exec('git', ['status'], { timeoutMs: 1000 })).toMatchObject({
      code: null,
      failure: 'not-found',
    })
  })
})
