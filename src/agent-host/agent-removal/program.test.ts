// How an agent's program is uninstalled, told by where it lives, on each system: npm, Homebrew,
// WinGet, uvx and the vendors' own installers, Kite's own packages, and what is left to the user.

import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import type { HarnessId } from '@shared/thread'
import type { LaunchKind } from '../catalog'
import { ANTIGRAVITY, CLAUDE_CODE, CODEX, DOUBAO, OPENCODE } from '../catalog'
import { fakeRemovalFiles, type FakeEntry } from '../testing/fake-removal-files'
import { planProgram, type ProgramFacts } from './program'

const WIN = 'C:\\Users\\me'
const MAC = '/Users/me'
const LINUX = '/home/me'

const SHIM = (target: string): string =>
  `@ECHO off\r\nSETLOCAL\r\n"%_prog%"  "%dp0%\\${target}" %*\r\n`

function facts(
  platform: Platform,
  home: string,
  over: Partial<ProgramFacts> & { harness: HarnessId; launch: LaunchKind },
): ProgramFacts {
  const p = platform === 'win32' ? '\\' : '/'
  return {
    platform,
    home,
    env: {},
    kiteRoot: [home, '.huli', 'harnesses'].join(p),
    program: null,
    launcher: null,
    tools: { npm: null, brew: null, winget: null, uv: null },
    others: [],
    ...over,
  }
}

const claude = {
  harness: 'claude-code' as const,
  launch: CLAUDE_CODE.launch,
  installs: CLAUDE_CODE.installs!,
}
const codex = { harness: 'codex' as const, launch: CODEX.launch, installs: CODEX.installs! }
const agy = {
  harness: 'antigravity' as const,
  launch: ANTIGRAVITY.launch,
  installs: ANTIGRAVITY.installs!,
}
const doubao = { harness: 'doubao' as const, launch: DOUBAO.launch, installs: DOUBAO.installs! }
const opencode = {
  harness: 'opencode' as const,
  launch: OPENCODE.launch,
  installs: OPENCODE.installs!,
}

function plan(f: ProgramFacts, entries: Record<string, FakeEntry>) {
  return planProgram(f, fakeRemovalFiles(f.platform, entries))
}

const steps = (planned: Awaited<ReturnType<typeof planProgram>>) =>
  planned.steps.map((step) => [step.kind, step.path, ...(step.kite ? ['kite'] : [])])

describe('planProgram', () => {
  it('removes Claude Code’s native install on Windows, and the SDK Kite installed', async () => {
    const exe = `${WIN}\\.local\\bin\\claude.exe`
    const planned = await plan(facts('win32', WIN, { ...claude, program: exe, launcher: exe }), {
      [exe]: { kind: 'file' },
      [`${WIN}\\.local\\share\\claude\\versions\\2.1.330`]: { kind: 'file' },
      [`${WIN}\\.huli\\harnesses\\claude-code\\0.3.330\\installed.json`]: { kind: 'file' },
    })
    expect(planned.method).toBe('native')
    expect(steps(planned)).toEqual([
      ['file', exe],
      ['folder', `${WIN}\\.local\\share\\claude`],
      ['folder', `${WIN}\\.huli\\harnesses\\claude-code`, 'kite'],
    ])
    expect(planned.notes).toEqual(['claude-apps'])
    expect(planned.manual).toBeNull()
  })

  it('removes Claude Code’s launcher on macOS only when it links into its versions', async () => {
    const link = `${MAC}/.local/bin/claude`
    const version = `${MAC}/.local/share/claude/versions/2.1.330`
    const native = await plan(facts('darwin', MAC, { ...claude, program: link, launcher: link }), {
      [link]: { kind: 'link', target: version },
      [version]: { kind: 'file' },
    })
    expect(steps(native)).toEqual([
      ['file', link],
      ['folder', `${MAC}/.local/share/claude`],
    ])
    // A launcher of the user's own, which the installer leaves alone, stays: Kite cannot tell it.
    const custom = await plan(
      facts('linux', LINUX, { ...claude, program: `${LINUX}/.local/bin/claude` }),
      {
        [`${LINUX}/.local/bin/claude`]: { kind: 'file' },
        [`${LINUX}/.local/share/claude/versions/2.1.330`]: { kind: 'file' },
      },
    )
    expect(custom.steps).toEqual([])
    expect(custom.manual).toEqual({ path: `${LINUX}/.local/bin/claude`, reason: 'unknown' })
  })

  it('uninstalls a global npm package with npm’s .cmd under the prefix it lives in', async () => {
    const prefix = `${WIN}\\AppData\\Roaming\\npm`
    const exe = `${prefix}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`
    const npm = 'C:\\Program Files\\nodejs\\npm.cmd'
    const planned = await plan(
      facts('win32', WIN, {
        ...claude,
        program: exe,
        launcher: `${prefix}\\claude.cmd`,
        tools: { npm, brew: null, winget: null, uv: null },
      }),
      {
        [exe]: { kind: 'file' },
        [`${prefix}\\claude.cmd`]: {
          kind: 'file',
          text: SHIM('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'),
        },
      },
    )
    expect(planned.method).toBe('npm')
    expect(planned.steps).toEqual([
      {
        part: 'program',
        kind: 'command',
        path: `npm.cmd uninstall -g --prefix ${prefix} '@anthropic-ai/claude-code'`,
        run: {
          program: npm,
          args: [
            'uninstall',
            '-g',
            '--prefix',
            prefix,
            '@anthropic-ai/claude-code',
            '--no-fund',
            '--no-audit',
            '--no-update-notifier',
            '--loglevel=http',
          ],
        },
        measure: `${prefix}\\node_modules\\@anthropic-ai\\claude-code`,
      },
    ])
  })

  it('quotes a prefix with spaces, and refuses one cmd.exe would expand', async () => {
    const run = async (home: string) => {
      const prefix = `${home}\\AppData\\Roaming\\npm`
      const exe = `${prefix}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`
      return plan(
        facts('win32', home, {
          ...claude,
          program: exe,
          tools: { npm: 'C:\\nodejs\\npm.cmd', brew: null, winget: null, uv: null },
        }),
        { [exe]: { kind: 'file' } },
      )
    }
    const spaced = await run('C:\\Users\\Jane Doe')
    expect(spaced.steps[0]?.path).toBe(
      "npm.cmd uninstall -g --prefix 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm' '@anthropic-ai/claude-code'",
    )
    for (const home of ['C:\\Users\\100%me', 'C:\\Users\\a!b', 'C:\\Users\\a"b']) {
      const refused = await run(home)
      expect(refused.steps).toEqual([])
      expect(refused.manual?.reason).toBe('unsafe')
    }
  })

  it('leaves the npm command to the user when npm is not found', async () => {
    const prefix = `${LINUX}/.npm-global`
    const file = `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`
    const planned = await plan(facts('linux', LINUX, { ...codex, program: file }), {
      [file]: { kind: 'file' },
    })
    expect(planned.steps).toEqual([])
    expect(planned.manual).toEqual({
      path: file,
      reason: 'tool',
      command: `npm uninstall -g --prefix ${prefix} @openai/codex`,
    })
  })

  it('uninstalls Doubao’s npm launcher and the program it downloaded', async () => {
    const local = `${WIN}\\AppData\\Local`
    const prefix = `${WIN}\\AppData\\Roaming\\npm`
    const native = `${local}\\doubao_cli\\app\\current\\doubao.exe`
    const planned = await plan(
      facts('win32', WIN, {
        ...doubao,
        env: { LOCALAPPDATA: local },
        program: native,
        launcher: `${prefix}\\doubao.cmd`,
        tools: { npm: 'C:\\nodejs\\npm.cmd', brew: null, winget: null, uv: null },
      }),
      {
        [native]: { kind: 'file' },
        [`${local}\\doubao_cli\\logs\\cli.log`]: { kind: 'file' },
        [`${prefix}\\doubao.cmd`]: {
          kind: 'file',
          text: SHIM('node_modules\\@bytedance\\doubao-cli\\scripts\\run.cjs'),
        },
        [`${prefix}\\node_modules\\@bytedance\\doubao-cli\\scripts\\run.cjs`]: { kind: 'file' },
      },
    )
    expect(steps(planned)).toEqual([
      ['command', `npm.cmd uninstall -g --prefix ${prefix} '@bytedance/doubao-cli'`],
      ['folder', `${local}\\doubao_cli\\app`],
    ])
    // macOS: the launcher is npm's link, the program in Application Support.
    const support = `${MAC}/Library/Application Support/doubao_cli`
    const mac = await plan(
      facts('darwin', MAC, {
        ...doubao,
        program: `${support}/app/current/doubao`,
        launcher: '/opt/homebrew/bin/doubao',
        tools: { npm: '/opt/homebrew/bin/npm', brew: null, winget: null, uv: null },
      }),
      {
        [`${support}/app/current/doubao`]: { kind: 'file' },
        '/opt/homebrew/bin/doubao': {
          kind: 'link',
          target: '../lib/node_modules/@bytedance/doubao-cli/scripts/run.cjs',
        },
        '/opt/homebrew/lib/node_modules/@bytedance/doubao-cli/scripts/run.cjs': { kind: 'file' },
      },
    )
    expect(steps(mac)).toEqual([
      ['command', 'npm uninstall -g --prefix /opt/homebrew @bytedance/doubao-cli'],
      ['folder', `${support}/app`],
    ])
  })

  it('removes Codex’s standalone releases and its links, never the app’s daemon', async () => {
    const root = `${MAC}/.codex/packages/standalone`
    const release = `${root}/releases/0.171.0-aarch64-apple-darwin`
    const planned = await plan(
      facts('darwin', MAC, { ...codex, program: `${MAC}/.local/bin/codex` }),
      {
        [`${MAC}/.local/bin/codex`]: { kind: 'link', target: `${release}/bin/codex` },
        [`${MAC}/.local/bin/codex-code-mode-host`]: {
          kind: 'link',
          target: `${release}/bin/codex-code-mode-host`,
        },
        [`${release}/bin/codex`]: { kind: 'file' },
        [`${release}/bin/codex-code-mode-host`]: { kind: 'file' },
        [`${MAC}/.codex/packages/app-server-daemon/current`]: { kind: 'file' },
      },
    )
    expect(planned.method).toBe('native')
    expect(steps(planned)).toEqual([
      ['file', `${MAC}/.local/bin/codex`],
      ['file', `${MAC}/.local/bin/codex-code-mode-host`],
      ['folder', root],
    ])
    expect(planned.notes).toEqual(['codex-app', 'path-left'])
  })

  it('uninstalls a Homebrew cask or formula by its own name', async () => {
    const cask = await plan(
      facts('darwin', MAC, {
        ...codex,
        program: '/opt/homebrew/bin/codex',
        tools: { npm: null, brew: '/opt/homebrew/bin/brew', winget: null, uv: null },
      }),
      {
        '/opt/homebrew/bin/codex': {
          kind: 'link',
          target: '/opt/homebrew/Caskroom/codex/0.171.0/codex-aarch64-apple-darwin',
        },
        '/opt/homebrew/Caskroom/codex/0.171.0/codex-aarch64-apple-darwin': { kind: 'file' },
      },
    )
    expect(cask.steps.map((step) => [step.path, step.run])).toEqual([
      [
        'brew uninstall --cask codex',
        { program: '/opt/homebrew/bin/brew', args: ['uninstall', '--cask', 'codex'] },
      ],
    ])
    const formula = await plan(
      facts('linux', LINUX, {
        ...opencode,
        program: '/home/linuxbrew/.linuxbrew/bin/opencode',
        tools: { npm: null, brew: '/home/linuxbrew/.linuxbrew/bin/brew', winget: null, uv: null },
      }),
      {
        '/home/linuxbrew/.linuxbrew/bin/opencode': {
          kind: 'link',
          target: '../Cellar/opencode-v2/2.3.2/bin/opencode',
        },
        '/home/linuxbrew/.linuxbrew/Cellar/opencode-v2/2.3.2/bin/opencode': { kind: 'file' },
      },
    )
    expect(formula.steps[0]?.path).toBe('brew uninstall anomalyco/tap/opencode-v2')
  })

  it('uninstalls a WinGet package by its id, without stopping to ask', async () => {
    const links = `${WIN}\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe`
    const exe = `${WIN}\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe`
    const winget = `${WIN}\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe`
    const planned = await plan(
      facts('win32', WIN, {
        ...claude,
        program: links,
        tools: { npm: null, brew: null, winget, uv: null },
      }),
      { [links]: { kind: 'link', target: exe }, [exe]: { kind: 'file' } },
    )
    expect(planned.method).toBe('winget')
    expect(planned.steps.map((step) => [step.path, step.run])).toEqual([
      [
        'winget uninstall --id Anthropic.ClaudeCode -e',
        {
          program: winget,
          args: ['uninstall', '--id', 'Anthropic.ClaudeCode', '-e', '--disable-interactivity'],
        },
      ],
    ])
  })

  it('removes agy’s one file, and leaves the Antigravity app’s own copy alone', async () => {
    const local = `${WIN}\\AppData\\Local`
    const exe = `${local}\\agy\\bin\\agy.exe`
    const windows = await plan(
      facts('win32', WIN, { ...agy, env: { LOCALAPPDATA: local }, program: exe }),
      { [exe]: { kind: 'file' } },
    )
    expect(windows.steps).toEqual([
      {
        part: 'program',
        kind: 'file',
        path: exe,
        prune: [`${local}\\agy\\bin`, `${local}\\agy`],
      },
    ])
    const linux = await plan(
      facts('linux', LINUX, { ...agy, program: `${LINUX}/.local/bin/agy` }),
      {
        [`${LINUX}/.local/bin/agy`]: { kind: 'file' },
      },
    )
    expect(steps(linux)).toEqual([['file', `${LINUX}/.local/bin/agy`]])
    const bundled = '/Applications/Antigravity.app/Contents/Resources/bin/agy'
    const app = await plan(facts('darwin', MAC, { ...agy, program: `${MAC}/.local/bin/agy` }), {
      [`${MAC}/.local/bin/agy`]: { kind: 'link', target: bundled },
      [bundled]: { kind: 'file' },
    })
    expect(app.steps).toEqual([])
    expect(app.manual).toEqual({ path: `${MAC}/.local/bin/agy`, reason: 'app' })
    expect(app.notes).toEqual(['antigravity-app'])
  })

  it('removes OpenCode’s script install, its legacy shim with it', async () => {
    const bin = `${LINUX}/.opencode/bin`
    const planned = await plan(facts('linux', LINUX, { ...opencode, program: `${bin}/opencode` }), {
      [`${bin}/opencode`]: { kind: 'file' },
      [`${bin}/opencode2`]: { kind: 'file' },
    })
    expect(steps(planned)).toEqual([
      ['file', `${bin}/opencode2`],
      ['file', `${bin}/opencode`],
    ])
  })

  it('leaves a program it cannot tell the install of, but still removes what Kite installed', async () => {
    const planned = await plan(
      facts('linux', LINUX, { ...claude, program: '/usr/local/bin/claude' }),
      {
        '/usr/local/bin/claude': { kind: 'file' },
        [`${LINUX}/.huli/harnesses/claude-code/0.3.330/installed.json`]: { kind: 'file' },
      },
    )
    expect(steps(planned)).toEqual([['folder', `${LINUX}/.huli/harnesses/claude-code`, 'kite']])
    expect(planned.manual).toEqual({ path: '/usr/local/bin/claude', reason: 'unknown' })
    expect(planned.method).toBeNull()
  })

  it('plans nothing while other agents run on the harness', async () => {
    const exe = `${WIN}\\.local\\bin\\claude.exe`
    const planned = await plan(
      facts('win32', WIN, { ...claude, program: exe, others: ['Claude (work)'] }),
      {
        [exe]: { kind: 'file' },
        [`${WIN}\\.huli\\harnesses\\claude-code\\0.3.330\\installed.json`]: { kind: 'file' },
      },
    )
    expect(planned.blocked).toEqual(['Claude (work)'])
    expect(planned.steps).toEqual([])
  })

  it('takes Kite’s own release of a harness for Kite’s, and cleans uvx’s cache', async () => {
    const kite = `${LINUX}/.huli/harnesses/goose`
    const release = await plan(
      facts('linux', LINUX, {
        harness: 'goose',
        launch: { kind: 'binary', command: 'goose', args: ['acp'] },
        program: `${kite}/1.9.0/goose`,
      }),
      { [`${kite}/1.9.0/goose`]: { kind: 'file' } },
    )
    expect(steps(release)).toEqual([['folder', kite, 'kite']])
    expect(release.manual).toBeNull()
    const uvx = await plan(
      facts('win32', WIN, {
        harness: 'fast-agent',
        launch: { kind: 'uvx', package: 'fast-agent-acp', args: ['-x'] },
        tools: { npm: null, brew: null, winget: null, uv: `${WIN}\\.local\\bin\\uv.exe` },
      }),
      { [`${WIN}\\.huli\\harnesses\\fast-agent\\uvx.json`]: { kind: 'file' } },
    )
    expect(uvx.method).toBe('uvx')
    expect(steps(uvx)).toEqual([
      ['command', 'uv cache clean fast-agent-acp'],
      ['folder', `${WIN}\\.huli\\harnesses\\fast-agent`, 'kite'],
    ])
  })
})
