// What resetting an agent's environment removes, by each agent's own rules and on each system:
// the folder it really uses, its keychain names, and never its history or settings.

import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import type { HarnessId } from '@shared/thread'
import {
  claudeServiceSuffix,
  codexAccount,
  codexCanonical,
  refusal,
  resetPlan,
  type ResetContext,
  type ResetEntry,
  type ResetPlan,
} from './plan'

const HOMES: Record<'win32' | 'darwin' | 'linux', string> = {
  win32: 'C:\\Users\\me',
  darwin: '/Users/me',
  linux: '/home/me',
}

function ctx(platform: Platform, env: Record<string, string> = {}, chosen: string | null = null) {
  return {
    platform,
    home: HOMES[platform as keyof typeof HOMES],
    getEnv: (name: string) => env[name],
    chosen,
    realpath: async (target: string) => target,
  } satisfies ResetContext
}

function removedPaths(plan: ResetPlan): string[] {
  return plan.entries.flatMap((entry) => (entry.kind === 'path' ? [entry.path] : []))
}

function keysOf(plan: ResetPlan, file: string, category: ResetEntry['category']): string[] {
  return plan.entries.flatMap((entry) =>
    entry.kind === 'keys' && entry.file === file && entry.category === category
      ? [...entry.keys]
      : [],
  )
}

function secrets(plan: ResetPlan): unknown[] {
  return plan.entries.flatMap((entry) => (entry.kind === 'secret' ? [entry.secret] : []))
}

const sha = (text: string, digits: number): string =>
  createHash('sha256').update(text).digest('hex').slice(0, digits)

describe('Claude Code', () => {
  it('keeps .claude.json in the home folder and its keys there, by default', async () => {
    const plan = await resetPlan('claude-code', ctx('linux'))
    expect(plan.folder).toBe('/home/me/.claude')
    expect(removedPaths(plan)).toContain('/home/me/.claude/.credentials.json')
    expect(keysOf(plan, '/home/me/.claude.json', 'credentials')).toEqual([
      'oauthAccount',
      'primaryApiKey',
      'customApiKeyResponses',
    ])
    expect(keysOf(plan, '/home/me/.claude.json', 'identifiers')).toEqual(
      expect.arrayContaining(['userID', 'anonymousId', 'machineID', 'firstStartTime']),
    )
    expect(keysOf(plan, '/home/me/.claude.json', 'caches')).toEqual(
      expect.arrayContaining(['cachedGrowthBookFeatures', 'cachedStatsigGates']),
    )
    // Plaintext on Linux: no store entry.
    expect(secrets(plan)).toEqual([])
    expect(plan.shared).toBe('program')
  })

  it('never takes out a key of the user’s configuration', async () => {
    const plan = await resetPlan('claude-code', ctx('linux'))
    const keys = plan.entries.flatMap((entry) =>
      entry.kind === 'keys' || entry.kind === 'keys-in' ? [...entry.keys] : [],
    )
    for (const kept of [
      'mcpServers',
      'projects',
      'theme',
      'hasCompletedOnboarding',
      'migrationVersion',
      'installMethod',
      'autoUpdates',
      'tipsHistory',
    ]) {
      expect(keys).not.toContain(kept)
    }
  })

  it('follows the folder Kite gives it, with .claude.json inside, and its hashed services', async () => {
    const chosen = '/Users/me/Agents/work'
    const plan = await resetPlan('claude-code', ctx('darwin', {}, chosen))
    expect(plan.folder).toBe(chosen)
    expect(keysOf(plan, `${chosen}/.claude.json`, 'identifiers')).toContain('userID')
    expect(removedPaths(plan)).toContain(`${chosen}/.credentials.json`)
    const suffix = `-${sha(chosen, 8)}`
    expect(secrets(plan)).toEqual([
      { store: 'keychain', service: `Claude Code-credentials${suffix}` },
      { store: 'keychain', service: `Claude Code${suffix}` },
    ])
    expect(plan.shared).toBeNull()
  })

  it('takes CLAUDE_CONFIG_DIR from the environment as Claude Code hashes it: as it is', async () => {
    const raw = 'C:\\Claude\\home\\'
    const plan = await resetPlan('claude-code', ctx('win32', { CLAUDE_CONFIG_DIR: raw }))
    expect(plan.folder).toBe('C:\\Claude\\home')
    expect(secrets(plan)).toEqual([
      {
        store: 'credential-manager',
        target: `Claude Code-credentials-${sha(raw, 8)}/claude-code-user`,
        parts: true,
      },
    ])
    expect(claudeServiceSuffix(null)).toBe('')
    expect(claudeServiceSuffix('/x', '')).toBe('')
    expect(claudeServiceSuffix(null, '/secure')).toBe(`-${sha('/secure', 8)}`)
  })

  it('names the default Credential Manager entry without a suffix', async () => {
    const plan = await resetPlan('claude-code', ctx('win32'))
    expect(secrets(plan)).toEqual([
      {
        store: 'credential-manager',
        target: 'Claude Code-credentials/claude-code-user',
        parts: true,
      },
    ])
    expect(keysOf(plan, 'C:\\Users\\me\\.claude.json', 'credentials')).toContain('oauthAccount')
  })
})

describe('Codex', () => {
  it('uses CODEX_HOME and names its leftover keyring entry from the canonical folder', async () => {
    const plan = await resetPlan('codex', ctx('darwin', { CODEX_HOME: '/Users/me/codex-work' }))
    expect(plan.folder).toBe('/Users/me/codex-work')
    expect(removedPaths(plan)).toEqual(
      expect.arrayContaining([
        '/Users/me/codex-work/auth.json',
        '/Users/me/codex-work/.credentials.json',
        '/Users/me/codex-work/installation_id',
        '/Users/me/codex-work/log',
      ]),
    )
    expect(secrets(plan)).toEqual([
      {
        store: 'keychain',
        service: 'Codex Auth',
        account: `cli|${sha('/Users/me/codex-work', 16)}`,
      },
    ])
  })

  it('hashes the folder with the \\\\?\\ prefix Rust gives it on Windows', async () => {
    const win = ctx('win32')
    expect(await codexCanonical(win, 'C:\\Users\\me\\.codex')).toBe('\\\\?\\C:\\Users\\me\\.codex')
    expect(await codexCanonical(win, '\\\\server\\share\\.codex')).toBe(
      '\\\\?\\UNC\\server\\share\\.codex',
    )
    expect(
      await codexCanonical({ ...win, realpath: () => Promise.reject(new Error('gone')) }, 'C:\\x'),
    ).toBe('C:\\x')
    const plan = await resetPlan('codex', win)
    expect(secrets(plan)).toEqual([
      {
        store: 'credential-manager',
        target: `${codexAccount('cli', '\\\\?\\C:\\Users\\me\\.codex')}.Codex Auth`,
      },
    ])
  })

  it('keeps its history, settings and the secrets passphrase’s other files', async () => {
    const plan = await resetPlan('codex', ctx('linux'))
    const root = '/home/me/.codex'
    for (const kept of [
      'sessions',
      'archived_sessions/2026/x.jsonl',
      'history.jsonl',
      'session_index.jsonl',
      'state_5.sqlite',
      'thread_history_1.sqlite',
      'goals_1.sqlite',
      'config.toml',
      'AGENTS.md',
      'skills',
      'rules/default.rules',
      'memories',
      'secrets/local.age',
      '.sandbox-secrets/sandbox_users.json',
      'cap_sid',
      '.tmp/marketplaces',
    ]) {
      expect(refusal(plan, `${root}/${kept}`, 'linux'), kept).not.toBeNull()
    }
  })
})

describe('Antigravity', () => {
  it('signs out of the keyring entry it shares with the app and keeps its conversations', async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const plan = await resetPlan('antigravity', ctx(platform))
      expect(plan.shared).toBe('app')
      expect(secrets(plan)).toEqual([
        platform === 'win32'
          ? { store: 'credential-manager', target: 'gemini:antigravity' }
          : platform === 'darwin'
            ? { store: 'keychain', service: 'gemini', account: 'antigravity' }
            : {
                store: 'secret-service',
                attributes: { service: 'gemini', username: 'antigravity' },
              },
      ])
    }
    const plan = await resetPlan('antigravity', ctx('linux'))
    const folder = '/home/me/.gemini/antigravity-cli'
    expect(removedPaths(plan)).toEqual(
      expect.arrayContaining([`${folder}/installation_id`, `${folder}/log`]),
    )
    for (const kept of [
      'conversations/a.db',
      'brain/x',
      '../config/mcp_config.json',
      '../GEMINI.md',
    ]) {
      expect(refusal(plan, path.posix.join(folder, kept), 'linux'), kept).not.toBeNull()
    }
  })
})

describe('every plan', () => {
  const harnesses: HarnessId[] = [
    'claude-code',
    'codex',
    'antigravity',
    'pi',
    'cline',
    'dimcode',
    'opencode',
  ]

  it('removes only what its own guard allows, on every system', async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const harness of harnesses) {
        const plan = await resetPlan(harness, ctx(platform))
        for (const target of removedPaths(plan)) {
          expect(refusal(plan, target, platform), `${harness} ${target}`).toBeNull()
        }
        // The folders themselves, the home folder and history are never removed.
        for (const target of [HOMES[platform], ...plan.roots, ...plan.keep.map((k) => k.path)]) {
          expect(refusal(plan, target, platform), `${harness} ${target}`).not.toBeNull()
        }
      }
    }
  })

  it('refuses the history inside a kept folder however it is spelled on Windows', async () => {
    const plan = await resetPlan('claude-code', ctx('win32'))
    expect(refusal(plan, 'C:\\USERS\\ME\\.CLAUDE\\projects\\p\\s.jsonl', 'win32')).not.toBeNull()
    expect(refusal(plan, 'C:\\Users\\me\\.claude\\..\\Documents', 'win32')).not.toBeNull()
    expect(refusal(plan, 'C:\\Users\\me\\.claude\\debug', 'win32')).toBeNull()
  })

  it('offers only a sign-out for an agent whose files Kite does not know', async () => {
    const plan = await resetPlan('kimi', ctx('linux'))
    expect(plan).toMatchObject({ known: [], entries: [] })
    expect((await resetPlan('cline', ctx('linux'))).known).not.toContain('credentials')
    expect((await resetPlan('opencode', ctx('linux'))).known).toEqual(['caches'])
  })

  it('takes Pi’s ids and keys out of its settings, which it keeps', async () => {
    const plan = await resetPlan('pi', ctx('linux', { PI_CODING_AGENT_DIR: '~/pi' }))
    expect(plan.folder).toBe('/home/me/pi')
    expect(keysOf(plan, '/home/me/pi/settings.json', 'identifiers')).toEqual([
      'deviceId',
      'trackingId',
    ])
    expect(refusal(plan, '/home/me/pi/settings.json', 'linux')).not.toBeNull()
    expect(refusal(plan, '/home/me/pi/sessions/a.jsonl', 'linux')).not.toBeNull()
  })
})
