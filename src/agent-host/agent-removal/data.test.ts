// What deleting an agent's data takes, by each agent's own folders and on each system, what stays
// because another program or app shares it, and the guard no path may get past.

import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import type { HarnessId } from '@shared/thread'
import { fakeRemovalFiles, type FakeEntry } from '../testing/fake-removal-files'
import { planData, type DataFacts } from './data'
import { removalRefusal, type RemovalGuard } from './guard'

const HOMES = { win32: 'C:\\Users\\me', darwin: '/Users/me', linux: '/home/me' } as const

function facts(
  platform: keyof typeof HOMES,
  harness: HarnessId,
  over: Partial<DataFacts> & { env?: Record<string, string> } = {},
): DataFacts {
  const { env = {}, ...rest } = over
  return {
    harness,
    platform,
    home: HOMES[platform],
    getEnv: (name) => env[name],
    chosen: null,
    picked: false,
    others: [],
    realpath: async (target) => target,
    ...rest,
  }
}

async function plan(f: DataFacts, entries: Record<string, FakeEntry> = {}) {
  return planData(f, fakeRemovalFiles(f.platform, entries))
}

const paths = (planned: Awaited<ReturnType<typeof planData>>) =>
  planned.steps.map((step) =>
    step.kind === 'contents' ? `${step.path} except ${step.except?.join(',')}` : step.path,
  )

describe('planData', () => {
  it('takes Claude Code’s folder, .claude.json and its backups, and its keychain entry', async () => {
    const home = HOMES.darwin
    const planned = await plan(facts('darwin', 'claude-code'), {
      [`${home}/.claude.json`]: { kind: 'file' },
      [`${home}/.claude.json.backup`]: { kind: 'file' },
      [`${home}/.claude.json.backup.1763600000000`]: { kind: 'file' },
      [`${home}/.claude.json.other`]: { kind: 'file' },
    })
    expect(paths(planned)).toEqual([
      `${home}/.claude`,
      `${home}/.claude.json`,
      `${home}/.claude.json.backup`,
      `${home}/.claude.json.backup.1763600000000`,
      'Claude Code-credentials',
      'Claude Code',
    ])
    expect(planned.notes).toEqual(['claude-apps'])
  })

  it('keeps the device keys every Claude Code shares while other Claude agents remain', async () => {
    const home = HOMES.win32
    const planned = await plan(facts('win32', 'claude-code', { others: ['Claude (work)'] }), {
      [`${home}\\.claude\\.device-keys.json`]: { kind: 'file' },
    })
    expect(paths(planned)[0]).toBe(`${home}\\.claude except .device-keys.json`)
    expect(planned.kept).toEqual([
      { path: `${home}\\.claude\\.device-keys.json`, reason: 'agents' },
    ])
    // Windows' Credential Manager entry, with its split parts.
    expect(planned.steps.at(-1)?.secret).toEqual({
      store: 'credential-manager',
      target: 'Claude Code-credentials/claude-code-user',
      parts: true,
    })
  })

  it('takes only the folder of an added agent, with the keychain names its folder hashes to', async () => {
    const folder = '/Users/me/.huli/agents/claude-code-work'
    const planned = await plan(facts('darwin', 'claude-code', { chosen: folder }))
    expect(paths(planned)[0]).toBe(folder)
    expect(paths(planned)).not.toContain('/Users/me/.claude.json')
    expect(paths(planned).slice(1)).toEqual([
      expect.stringMatching(/^Claude Code-credentials-[0-9a-f]{8}$/),
      expect.stringMatching(/^Claude Code-[0-9a-f]{8}$/),
    ])
    expect(planned.notes).toEqual([])
    const picked = await plan(facts('darwin', 'claude-code', { chosen: folder, picked: true }))
    expect(picked.notes).toEqual(['picked-folder'])
  })

  it('keeps Codex’s program and, on Windows, its sandbox accounts’ files', async () => {
    const home = HOMES.win32
    const planned = await plan(facts('win32', 'codex'), {
      [`${home}\\.codex\\packages\\standalone\\current`]: { kind: 'file' },
      [`${home}\\.codex\\.sandbox-secrets\\x`]: { kind: 'file' },
    })
    expect(paths(planned)).toEqual([
      `${home}\\.codex except packages,.sandbox,.sandbox-bin,.sandbox-secrets,.sandbox_migration,cap_sid`,
      expect.stringMatching(/^cli\|[0-9a-f]{16}\.Codex Auth$/),
    ])
    expect(planned.kept).toEqual([
      { path: `${home}\\.codex\\packages`, reason: 'program' },
      { path: `${home}\\.codex\\.sandbox-secrets`, reason: 'sandbox' },
    ])
    expect(planned.notes).toEqual(['codex-app'])
    const moved = await plan(facts('linux', 'codex', { env: { CODEX_HOME: '/data/codex' } }))
    expect(paths(moved)[0]).toBe('/data/codex except packages')
    expect(moved.notes).toEqual([])
  })

  it('takes agy’s own folder and leaves what the Antigravity app shares', async () => {
    const home = HOMES.linux
    const planned = await plan(facts('linux', 'antigravity'), {
      [`${home}/.gemini/antigravity/brain/x`]: { kind: 'file' },
    })
    expect(paths(planned)).toEqual([`${home}/.gemini/antigravity-cli`])
    expect(planned.kept).toEqual([
      { path: `${home}/.gemini/antigravity`, reason: 'app' },
      { path: 'service=gemini, username=antigravity', reason: 'app', store: 'secret-service' },
    ])
    expect(planned.steps.some((step) => step.kind === 'secret')).toBe(false)
  })

  it('takes dsh’s folder but never the agents folder it shares', async () => {
    const home = HOMES.darwin
    const planned = await plan(facts('darwin', 'deepseek'), {
      [`${home}/.agents/AGENTS.md`]: { kind: 'file' },
    })
    expect(paths(planned)).toEqual([`${home}/.dsh`])
    expect(planned.kept).toEqual([{ path: `${home}/.agents`, reason: 'agents' }])
    const moved = await plan(facts('darwin', 'deepseek', { env: { DSH_HOME: 'work/dsh' } }))
    expect(paths(moved)).toEqual([`${home}/work/dsh`])
  })

  it('takes Doubao’s data folder but its program, on each system', async () => {
    const win = await plan(facts('win32', 'doubao', { env: { LOCALAPPDATA: 'D:\\Local' } }), {
      'D:\\Local\\doubao_cli\\app\\current\\doubao.exe': { kind: 'file' },
    })
    expect(paths(win)).toEqual(['D:\\Local\\doubao_cli except app'])
    expect(win.kept).toEqual([{ path: 'D:\\Local\\doubao_cli\\app', reason: 'program' }])
    const mac = await plan(facts('darwin', 'doubao'))
    expect(paths(mac)).toEqual(['/Users/me/Library/Application Support/doubao_cli except app'])
    const linux = await plan(facts('linux', 'doubao', { env: { XDG_DATA_HOME: '/data' } }))
    expect(paths(linux)).toEqual(['/data/doubao_cli except app'])
  })

  it('takes OpenCode’s XDG folders and Cline’s without a folder twice', async () => {
    const opencode = await plan(facts('linux', 'opencode', { env: { XDG_CACHE_HOME: '/cache' } }))
    expect(paths(opencode)).toEqual([
      '/home/me/.local/share/opencode',
      '/home/me/.config/opencode',
      '/cache/opencode',
      '/home/me/.local/state/opencode',
    ])
    const cline = await plan(facts('linux', 'cline'))
    expect(paths(cline)).toEqual(['/home/me/.cline'])
  })

  it('knows no data of an agent it has no folder for', async () => {
    const planned = await plan(facts('linux', 'goose'))
    expect(planned).toEqual({ known: false, steps: [], kept: [], notes: [], roots: [] })
  })
})

describe('removalRefusal', () => {
  const guard = (platform: Platform, over: Partial<RemovalGuard> = {}): RemovalGuard => ({
    platform,
    roots: platform === 'win32' ? ['C:\\Users\\me\\.claude'] : ['/home/me/.claude'],
    protect:
      platform === 'win32' ? ['C:\\Users\\me', 'C:\\Users\\me\\.huli\\harnesses'] : ['/home/me'],
    others: [],
    ...over,
  })

  it('lets what is inside the agent’s folders go, the folder itself included', () => {
    expect(removalRefusal('/home/me/.claude', guard('linux'))).toBeNull()
    expect(removalRefusal('/home/me/.claude/projects/x.jsonl', guard('linux'))).toBeNull()
    expect(removalRefusal('C:\\USERS\\ME\\.Claude\\x', guard('win32'))).toBeNull()
  })

  it('refuses what lies outside, a root, the home folder and what holds what must stay', () => {
    const linux = guard('linux')
    expect(removalRefusal('/home/me/.claude-other', linux)).toMatch(/outside/)
    expect(removalRefusal('/home/me/.claude/../.ssh', linux)).toMatch(/outside/)
    expect(removalRefusal('relative/.claude', linux)).toMatch(/absolute/)
    expect(removalRefusal('/home/me/.claude/a\nb', linux)).toMatch(/plain/)
    // A variable pointed at the home folder or a drive makes such a root; it still never goes.
    for (const root of ['/home/me', '/home', '/']) {
      expect(removalRefusal(root, guard('linux', { roots: [root] }))).not.toBeNull()
    }
    for (const root of ['C:\\', 'C:\\Users', 'C:\\Users\\me', 'C:\\Users\\me\\.huli']) {
      expect(removalRefusal(root, guard('win32', { roots: [root] }))).not.toBeNull()
    }
  })

  it('refuses another agent’s folder and anything that holds it', () => {
    const others = ['/home/me/.claude/agents-of-mine']
    expect(removalRefusal('/home/me/.claude', guard('linux', { others }))).toMatch(/another/)
    expect(removalRefusal('/home/me/.claude/agents-of-mine', guard('linux', { others }))).toMatch(
      /another/,
    )
    expect(removalRefusal('/home/me/.claude/cache', guard('linux', { others }))).toBeNull()
  })
})
