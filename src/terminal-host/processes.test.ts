import { describe, expect, it } from 'vitest'
import { parseCim, parsePs, runningUnder, type ProcessRow } from './processes'

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0)

describe('process listings', () => {
  it('reads ps, with the name after the times, spaces and all', () => {
    const rows = parsePs(
      [
        '    1     0 3-04:05:06 /sbin/launchd',
        '  812     1    02:03:04 /bin/zsh',
        '  900   812       00:07 /Applications/Visual Studio Code.app/Contents/MacOS/Code Helper',
        'garbage',
      ].join('\n'),
      NOW,
    )
    expect(rows).toEqual([
      {
        pid: 1,
        ppid: 0,
        startedAt: NOW - ((3 * 24 + 4) * 3600 + 5 * 60 + 6) * 1000,
        name: 'launchd',
      },
      { pid: 812, ppid: 1, startedAt: NOW - (2 * 3600 + 3 * 60 + 4) * 1000, name: 'zsh' },
      { pid: 900, ppid: 812, startedAt: NOW - 7000, name: 'Code Helper' },
    ])
  })

  it('reads the CIM query, creation times as file times', () => {
    const fileTime = (ms: number) => String((ms + 11_644_473_600_000) * 10_000)
    const rows = parseCim(
      `4 0 0 System\r\n42384 44444 ${fileTime(NOW)} powershell.exe\r\n51376 42384 ${fileTime(NOW + 5000)} PING.EXE\r\n`,
    )
    expect(rows).toEqual([
      { pid: 4, ppid: 0, startedAt: 0, name: 'System' },
      { pid: 42384, ppid: 44444, startedAt: NOW, name: 'powershell.exe' },
      { pid: 51376, ppid: 42384, startedAt: NOW + 5000, name: 'PING.EXE' },
    ])
  })
})

describe('what runs under a shell', () => {
  const shell: ProcessRow = { pid: 100, ppid: 50, startedAt: NOW, name: 'powershell.exe' }

  it('is nothing for a shell at its prompt, or one that is gone', () => {
    expect(runningUnder([shell], 100)).toBeNull()
    expect(runningUnder([shell], 101)).toBeNull()
  })

  it('is the earliest started of its tree, a grandchild included', () => {
    const npm = { pid: 200, ppid: 100, startedAt: NOW + 10_000, name: 'node.exe' }
    const vite = { pid: 300, ppid: 200, startedAt: NOW + 11_000, name: 'esbuild.exe' }
    expect(runningUnder([shell, vite, npm], 100)).toEqual(npm)
    expect(runningUnder([shell, { ...vite, ppid: 100 }], 100)).toEqual({ ...vite, ppid: 100 })
  })

  it('never takes a process that started before the shell, which names a reused pid', () => {
    // Seen on Windows: a long-running app whose parent once had the pid the shell has now.
    const stale = { pid: 32524, ppid: 100, startedAt: NOW - 3_600_000, name: 'RazerAppEngine.exe' }
    expect(runningUnder([shell, stale], 100)).toBeNull()
  })

  it("leaves out a prompt's own helper, but not what runs under it", () => {
    const zsh = { pid: 100, ppid: 50, startedAt: NOW, name: 'zsh' }
    const gitstatusd = {
      pid: 150,
      ppid: 100,
      startedAt: NOW + 1000,
      name: 'gitstatusd-darwin-arm64',
    }
    expect(runningUnder([zsh, gitstatusd], 100)).toBeNull()
    const server = { pid: 160, ppid: 100, startedAt: NOW + 9000, name: 'node' }
    expect(runningUnder([zsh, gitstatusd, server], 100)).toEqual(server)
  })
})
