import { describe, expect, it } from 'vitest'
import { formatCommand, quotePowerShell, quotePosix } from './quote'
import { forWindowsShell } from '../terminal-host/shell'

describe('formatCommand', () => {
  it('writes POSIX lines on macOS and Linux', () => {
    expect(
      formatCommand(
        { command: '/opt/x/claude', args: ['auth', 'login'], env: { A: 'b c' } },
        'darwin',
      ),
    ).toBe(`A='b c' /opt/x/claude auth login`)
  })

  it('writes PowerShell lines on Windows, without &&', () => {
    const line = formatCommand(
      {
        command: 'C:\\Users\\Ann\\.local\\bin\\claude.exe',
        args: ['auth', 'login', '--console'],
        env: { CLAUDE_CODE_EXECUTABLE: 'C:\\Users\\Ann\\.local\\bin\\claude.exe' },
      },
      'win32',
    )
    expect(line).toBe(
      "$env:CLAUDE_CODE_EXECUTABLE = 'C:\\Users\\Ann\\.local\\bin\\claude.exe'; " +
        'C:\\Users\\Ann\\.local\\bin\\claude.exe auth login --console',
    )
    expect(line).not.toContain('&&')
  })

  it('runs a quoted program through the call operator', () => {
    expect(
      formatCommand({ command: "C:\\Program Files\\Ann's\\x.exe", args: ['a b'] }, 'win32'),
    ).toBe("& 'C:\\Program Files\\Ann''s\\x.exe' 'a b'")
  })

  it("names npm's .cmd shim, not the .ps1 the execution policy refuses", () => {
    expect(formatCommand({ command: 'npm', args: ['install', '-g', 'x@1'] }, 'win32')).toBe(
      'npm.cmd install -g x@1',
    )
  })

  it('quotes what PowerShell would read as syntax', () => {
    for (const arg of ['a,b', '@x', '#x', '$x', 'a;b', 'a&b', 'a|b', '(x)', '{x}', 'a`b', '"x"']) {
      expect(quotePowerShell(arg)).toBe(`'${arg}'`)
    }
    expect(quotePowerShell("it's")).toBe("'it''s'")
    expect(quotePowerShell('')).toBe("''")
    expect(quotePowerShell('--console')).toBe('--console')
  })

  it('keeps an environment value from expanding', () => {
    expect(formatCommand({ command: 'x', args: [], env: { A: "$HOME'`" } }, 'win32')).toBe(
      "$env:A = '$HOME''`'; x",
    )
  })
})

describe('forWindowsShell', () => {
  const line = '$env:A = \'b\'; x "q"'

  it('leaves the line to PowerShell', () => {
    expect(forWindowsShell(line, 'pwsh')).toBe(line)
    expect(forWindowsShell(line, 'powershell')).toBe(line)
  })

  it('hands it to Windows PowerShell from cmd.exe', () => {
    expect(forWindowsShell(line, 'cmd')).toBe(
      `powershell -NoProfile -Command "$env:A = 'b'; x \\"q\\""`,
    )
  })

  it('hands it to Windows PowerShell from a POSIX shell', () => {
    expect(forWindowsShell(line, 'bash')).toBe(
      `powershell.exe -NoProfile -Command ${quotePosix(line)}`,
    )
  })
})
