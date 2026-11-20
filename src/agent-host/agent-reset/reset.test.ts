// A reset against a fake home: it lists what is there with sizes, removes only the categories
// asked for, keeps every history and settings file byte for byte, and logs no file's contents.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentResetCategory } from '@shared/agent-reset'
import type { HarnessId } from '@shared/thread'
import { tempFolder } from '../testing/temp'
import { resetPlan, type SecretRef } from './plan'
import { applyReset, keptNames, resetLog, resolvePlan } from './reset'
import { secretName, type SecretStore } from './secrets'

const platform = process.platform === 'win32' ? 'win32' : 'linux'
const SECRET = 'sk-ant-oat01-NEVER-PRINT-ME'

const CLAUDE_JSON = JSON.stringify(
  {
    numStartups: 3,
    userID: 'u'.repeat(64),
    machineID: 'm'.repeat(64),
    firstStartTime: '2026-11-01T00:00:00.000Z',
    oauthAccount: { emailAddress: 'me@example.com' },
    primaryApiKey: SECRET,
    cachedGrowthBookFeatures: { flag: true },
    mcpServers: { local: { command: 'server' } },
    projects: { '/work': { allowedTools: ['Bash'] } },
    theme: 'dark',
  },
  null,
  2,
)

/** Files of a fake home, by path under it; what a reset must keep is marked. */
const FILES: Record<string, { text: string; kept: boolean }> = {
  '.claude.json': { text: CLAUDE_JSON, kept: false },
  '.claude/.credentials.json': {
    text: `{"claudeAiOauth":{"accessToken":"${SECRET}"}}`,
    kept: false,
  },
  '.claude/backups/.claude.json.backup.1763600000000': { text: CLAUDE_JSON, kept: false },
  '.claude/statsig/cache.json': { text: '{}', kept: false },
  '.claude/shell-snapshots/snapshot-bash-1.sh': { text: 'export A=1', kept: false },
  '.claude/telemetry/1p_failed_events.a.b.json': { text: '[]', kept: false },
  '.claude/cache/changelog.md': { text: '# changes', kept: false },
  '.claude/cache/model-catalog/masked-ids.json': { text: '[]', kept: true },
  '.claude/projects/-work/s1.jsonl': { text: '{"type":"user"}\n', kept: true },
  '.claude/history.jsonl': { text: '{"display":"hi"}\n', kept: true },
  '.claude/file-history/s1/a@v1': { text: 'old', kept: true },
  '.claude/settings.json': { text: '{"model":"opus"}', kept: true },
  '.claude/CLAUDE.md': { text: '# rules', kept: true },
  '.claude/skills/mine/SKILL.md': { text: '---\nname: mine\n---', kept: true },
  '.claude/plugins/installed_plugins.json': { text: '{}', kept: true },
  '.claude/sessions/123.json': { text: '{"pid":123}', kept: true },
  '.codex/auth.json': { text: `{"tokens":{"access_token":"${SECRET}"}}`, kept: false },
  '.codex/installation_id': { text: '00000000-0000-4000-8000-000000000000', kept: false },
  '.codex/logs_2.sqlite': { text: 'log', kept: false },
  '.codex/logs_2.sqlite-wal': { text: 'wal', kept: false },
  '.codex/models_cache.json': { text: '{}', kept: false },
  '.codex/log/codex-tui.log': { text: 'line', kept: false },
  '.codex/secrets/codex_auth.age': { text: 'age', kept: false },
  '.codex/secrets/local.age': { text: 'age', kept: true },
  '.codex/sessions/2026/11/20/rollout.jsonl': { text: '{}\n', kept: true },
  '.codex/history.jsonl': { text: '{}\n', kept: true },
  '.codex/state_5.sqlite': { text: 'db', kept: true },
  '.codex/thread_history_1.sqlite': { text: 'db', kept: true },
  '.codex/config.toml': { text: 'model = "gpt-5"', kept: true },
  '.codex/AGENTS.md': { text: '# rules', kept: true },
  '.codex/memories/MEMORY.md': { text: 'remember', kept: true },
  '.gemini/antigravity-cli/installation_id': { text: 'id', kept: false },
  '.gemini/antigravity-cli/cache/acp-auth-state.json': { text: '{}', kept: false },
  '.gemini/antigravity-cli/log/cli-1.log': { text: 'line', kept: false },
  '.gemini/antigravity-cli/conversations/c.db': { text: 'db', kept: true },
  '.gemini/antigravity-cli/brain/b/task.md': { text: 'plan', kept: true },
  '.gemini/antigravity-cli/cache/projects.json': { text: '{}', kept: true },
  '.gemini/config/mcp_config.json': { text: '{}', kept: true },
  '.gemini/GEMINI.md': { text: '# rules', kept: true },
}

async function fakeHome(): Promise<string> {
  const home = await tempFolder('kite-reset-home-')
  for (const [name, { text }] of Object.entries(FILES)) {
    const file = path.join(home, ...name.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
  }
  return home
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

/** A credential store of names in memory; the real ones are never asked in tests. */
function fakeStore(names: string[]): SecretStore & { names: Set<string> } {
  const set = new Set(names)
  return {
    names: set,
    has: async (secret: SecretRef) => set.has(secretName(secret)),
    remove: async (secret: SecretRef) => {
      set.delete(secretName(secret))
    },
  }
}

async function reset(home: string, harness: HarnessId, categories: AgentResetCategory[]) {
  const plan = await resetPlan(harness, {
    platform,
    home,
    getEnv: () => undefined,
    chosen: null,
  })
  const store = fakeStore([
    'gemini:antigravity',
    'gemini (antigravity)',
    'service=gemini, username=antigravity',
  ])
  const logs: string[] = []
  const items = await resolvePlan(plan, store, platform, (message) => logs.push(message))
  const result = await applyReset(
    items.filter(({ item }) => categories.includes(item.category)),
    plan,
    store,
    platform,
  )
  return { plan, items, result, store, logs }
}

describe('a reset in a fake home', () => {
  it('lists what is there, with sizes, and the keys a file has', async () => {
    const home = await fakeHome()
    const { items, logs } = await reset(home, 'claude-code', [])
    expect(logs).toEqual([])
    const listed = items.map(({ item }) => item)
    expect(listed).toContainEqual({
      category: 'credentials',
      kind: 'file',
      path: path.join(home, '.claude', '.credentials.json'),
      bytes: FILES['.claude/.credentials.json']!.text.length,
    })
    expect(listed).toContainEqual({
      category: 'identifiers',
      kind: 'keys',
      path: path.join(home, '.claude.json'),
      keys: ['userID', 'machineID', 'firstStartTime'],
      bytes: null,
    })
    expect(listed).toContainEqual(
      expect.objectContaining({
        category: 'caches',
        kind: 'folder',
        path: path.join(home, '.claude', 'statsig'),
        bytes: 2,
      }),
    )
    // What is not there is not listed.
    expect(listed.some((item) => item.path.endsWith('debug'))).toBe(false)
  })

  it('removes every category and keeps every history and settings file as it was', async () => {
    const home = await fakeHome()
    for (const harness of ['claude-code', 'codex', 'antigravity'] as const) {
      const { result } = await reset(home, harness, ['credentials', 'identifiers', 'caches'])
      expect(result.failed, harness).toEqual([])
    }
    for (const [name, { text, kept }] of Object.entries(FILES)) {
      const file = path.join(home, ...name.split('/'))
      if (name === '.claude.json' || name.includes('.claude.json.backup')) continue
      if (kept) expect(await readFile(file, 'utf8'), name).toBe(text)
      else expect(await exists(file), name).toBe(false)
    }
    const config = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')) as object
    expect(config).toEqual({
      numStartups: 3,
      mcpServers: { local: { command: 'server' } },
      projects: { '/work': { allowedTools: ['Bash'] } },
      theme: 'dark',
    })
    const backup = path.join(home, '.claude', 'backups', '.claude.json.backup.1763600000000')
    expect(JSON.parse(await readFile(backup, 'utf8'))).toEqual(config)
  })

  it('removes only the categories asked for', async () => {
    const home = await fakeHome()
    const { result, store } = await reset(home, 'antigravity', ['identifiers'])
    expect(result.removed.map((item) => item.category)).toEqual(['identifiers'])
    expect(await exists(path.join(home, '.gemini', 'antigravity-cli', 'installation_id'))).toBe(
      false,
    )
    expect(await exists(path.join(home, '.gemini', 'antigravity-cli', 'log'))).toBe(true)
    expect(store.names.size).toBe(3)
    const claude = await reset(home, 'claude-code', ['identifiers'])
    const left = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')) as object
    expect(left).toHaveProperty('oauthAccount')
    expect(left).not.toHaveProperty('userID')
    expect(claude.result.removed.every((item) => item.category === 'identifiers')).toBe(true)
  })

  it('removes the store entry it found and says so', async () => {
    const home = await fakeHome()
    const { result, store } = await reset(home, 'antigravity', ['credentials'])
    const secret = result.removed.find((item) => item.kind === 'secret')
    expect(secret?.path).toBeDefined()
    expect(store.names.has(secret!.path)).toBe(false)
  })

  it('leaves a file that does not parse as it is and reports it', async () => {
    const home = await fakeHome()
    const broken = '{"userID": "x", "mcpServers": {'
    await writeFile(path.join(home, '.claude.json'), broken)
    const { items, result } = await reset(home, 'claude-code', ['identifiers'])
    expect(
      items.find(({ item }) => item.path === path.join(home, '.claude.json'))?.item.problem,
    ).toBe('not JSON')
    expect(result.failed.map(({ item }) => item.path)).toContain(path.join(home, '.claude.json'))
    expect(await readFile(path.join(home, '.claude.json'), 'utf8')).toBe(broken)
  })

  it('logs paths and key names, never what a file holds', async () => {
    const home = await fakeHome()
    const { result } = await reset(home, 'claude-code', ['credentials', 'identifiers', 'caches'])
    const line = resetLog(result)
    expect(line).toContain('.credentials.json')
    expect(line).toContain('userID')
    expect(line).not.toContain(SECRET)
    expect(line).not.toContain('me@example.com')
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('names what it keeps, relative to the agent’s folder', async () => {
    const home = await fakeHome()
    const { plan } = await reset(home, 'codex', [])
    const names = await keptNames(plan, platform, home)
    expect(names).toEqual(
      expect.arrayContaining([`sessions${path.sep}`, 'history.jsonl', 'config.toml']),
    )
  })
})
