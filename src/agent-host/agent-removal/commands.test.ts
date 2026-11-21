// The uninstall commands: what the dialog shows, as each platform's terminal reads it, and what
// runs, where a word that reaches cmd.exe must hold nothing it expands.

import { describe, expect, it } from 'vitest'
import { brewUninstall, cmdSafe, npmUninstall, uvCacheClean, wingetUninstall } from './commands'

const FLAGS = ['--no-fund', '--no-audit', '--no-update-notifier', '--loglevel=http']

describe('removal commands', () => {
  it('lets through cmd.exe only words it expands nothing in', () => {
    for (const word of ['C:\\Users\\Jane Doe\\npm', 'C:\\Users\\张三\\npm', 'a&b|c<d>e^f(g)']) {
      expect(cmdSafe(word)).toBe(true)
    }
    for (const word of ['C:\\100%\\npm', '%APPDATA%', 'a!b!', 'a"b', 'a\nb', 'a\rb', 'a\u0000b']) {
      expect(cmdSafe(word)).toBe(false)
    }
  })

  it('runs npm’s .cmd on Windows and shows it so PowerShell does not pick npm.ps1', () => {
    const command = npmUninstall('@openai/codex', 'D:\\node global', 'D:\\nodejs\\npm.cmd', 'win32')
    expect(command).toEqual({
      line: "npm.cmd uninstall -g --prefix 'D:\\node global' '@openai/codex'",
      run: {
        program: 'D:\\nodejs\\npm.cmd',
        args: ['uninstall', '-g', '--prefix', 'D:\\node global', '@openai/codex', ...FLAGS],
      },
    })
    expect(
      npmUninstall('@openai/codex', 'D:\\100%\\npm', 'D:\\nodejs\\npm.cmd', 'win32'),
    ).toBeNull()
    // PowerShell quotes what it would expand, `$` and backticks included.
    expect(npmUninstall('@openai/codex', "D:\\it's $HOME`x", null, 'win32')?.line).toBe(
      "npm.cmd uninstall -g --prefix 'D:\\it''s $HOME`x' '@openai/codex'",
    )
  })

  it('passes a POSIX prefix as one argument, with no shell between', () => {
    const command = npmUninstall('pi', "/home/me/my 'npm' 100%", '/usr/bin/npm', 'linux')
    expect(command?.run?.args.slice(0, 5)).toEqual([
      'uninstall',
      '-g',
      '--prefix',
      "/home/me/my 'npm' 100%",
      'pi',
    ])
    expect(command?.line).toBe(`npm uninstall -g --prefix '/home/me/my '\\''npm'\\'' 100%' pi`)
  })

  it('shows the command while its tool is missing, with nothing to run', () => {
    expect(brewUninstall('codex', true, null, 'darwin')).toEqual({
      line: 'brew uninstall --cask codex',
      run: null,
    })
    expect(wingetUninstall('Anthropic.ClaudeCode', 'C:\\winget.exe', 'win32')).toEqual({
      line: 'winget uninstall --id Anthropic.ClaudeCode -e',
      run: {
        program: 'C:\\winget.exe',
        args: ['uninstall', '--id', 'Anthropic.ClaudeCode', '-e', '--disable-interactivity'],
      },
    })
    expect(uvCacheClean('fast-agent-acp', '/usr/bin/uv', 'linux')?.run).toEqual({
      program: '/usr/bin/uv',
      args: ['cache', 'clean', 'fast-agent-acp'],
    })
  })
})
