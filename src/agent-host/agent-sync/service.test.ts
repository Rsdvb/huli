// Agent sync against a fake home of four agents: what it reads keeps secrets masked, a write goes
// only through a confirmed preview, leaves every byte outside its change as it was, backs the old
// file up first, and writes nothing when a file changed after the preview.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentId, HarnessId } from '@shared/thread'
import { tempFolder } from '../testing/temp'
import { AgentSync, type SyncAgentContext } from './service'
import { parseToml } from './toml'

const platform = process.platform === 'win32' ? 'win32' : 'linux'
const TOKEN = 'ctx7-token-0123456789abcdef'
const BEARER = 'sk-live-REMOTE-0123456789'

const CLAUDE_JSON = `{
  "numStartups": 41,
  "userID": "${'u'.repeat(32)}",
  "mcpServers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "env": { "CONTEXT7_API_KEY": "${TOKEN}" }
    },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${BEARER}" }
    },
    "legacy": { "type": "sse", "url": "https://old.example.com/sse" }
  },
  "projects": { "/work": { "allowedTools": [] } }
}
`

const CODEX_TOML = `model = "gpt-5.5"

# Servers I wrote by hand
[mcp_servers.docs]
command = "uvx"
args = ["docs-mcp"]

[mcp_servers]
inline = { command = "x" }
`

const GEMINI_JSON = `{
  // Gemini reads comments here
  "theme": "Dracula",
  "mcpServers": {}
}
`

const OPENCODE_JSONC = `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "fs": { "type": "local", "command": ["mcp-fs", "/srv"], "enabled": true },
  },
}
`

const CLAUDE_MD = `# 运维记录（全局规则）

Personal rules that must never move.
- one
- two
`

async function fakeHome(): Promise<{ home: string; data: string; sync: AgentSync }> {
  const root = await tempFolder('kite-agent-sync-')
  const home = path.join(root, 'home')
  const data = path.join(root, 'data')
  const files: Record<string, string> = {
    '.claude.json': CLAUDE_JSON,
    '.claude/CLAUDE.md': CLAUDE_MD,
    '.claude/skills/review/SKILL.md': '---\nname: Review\ndescription: Reviews a diff\n---\nBody\n',
    '.claude/skills/review/scripts/run.sh': 'echo hi\n',
    '.codex/config.toml': CODEX_TOML,
    '.gemini/settings.json': GEMINI_JSON,
    '.config/opencode/opencode.jsonc': OPENCODE_JSONC,
  }
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(home, ...name.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
  }
  const agents: [AgentId, HarnessId][] = [
    ['claude-code', 'claude-code'],
    ['codex', 'codex'],
    ['gemini', 'gemini'],
    ['opencode', 'opencode'],
  ]
  const sync = new AgentSync({
    userDataPath: data,
    home,
    platform,
    log: () => {},
    agents: () =>
      agents.map(([agentId, harness]): SyncAgentContext => ({
        agentId,
        harness,
        getEnv: () => undefined,
        chosen: null,
        installed: () => Promise.resolve(true),
      })),
  })
  return { home, data, sync }
}

const at = (home: string, name: string) => path.join(home, ...name.split('/'))

describe('Agent sync', () => {
  it('reads every agent’s servers, skills and instructions with secrets masked', async () => {
    const { home, sync } = await fakeHome()
    const state = await sync.read()
    const text = JSON.stringify(state)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(BEARER)
    const claude = state.mcp.find((place) => place.agentIds.includes('claude-code'))!
    expect(claude.servers.map((s) => s.name)).toEqual(['context7', 'remote', 'legacy'])
    expect(claude.servers[0]!.env).toEqual([{ name: 'CONTEXT7_API_KEY', value: '••••cdef' }])
    const codex = state.mcp.find((place) => place.agentIds.includes('codex'))!
    expect(codex.servers.map((s) => s.name)).toEqual(['docs', 'inline'])
    const opencode = state.mcp.find((place) => place.agentIds.includes('opencode'))!
    expect(opencode.servers[0]).toMatchObject({ name: 'fs', target: 'mcp-fs /srv' })
    const own = state.skills.find((place) => place.owners.includes('claude-code'))!
    expect(own.skills).toEqual([{ name: 'review', title: 'Review', description: 'Reviews a diff' }])
    expect(state.instructions.map((place) => place.id)).toContain(at(home, '.claude/CLAUDE.md'))
  })

  it('converts a server for another agent, backs the file up and keeps its other bytes', async () => {
    const { home, data, sync } = await fakeHome()
    const claude = at(home, '.claude.json')
    const codex = at(home, '.codex/config.toml')
    const gemini = at(home, '.gemini/settings.json')
    const preview = await sync.preview([
      { kind: 'mcp-add', server: 'context7', from: claude, to: codex },
      { kind: 'mcp-add', server: 'remote', from: claude, to: gemini },
      { kind: 'mcp-add', server: 'legacy', from: claude, to: codex },
    ])
    expect(JSON.stringify(preview)).not.toContain(TOKEN)
    expect(JSON.stringify(preview)).not.toContain(BEARER)
    expect(preview.problems).toEqual([
      expect.objectContaining({ code: 'transport', detail: 'sse' }),
    ])
    expect(preview.files.map((file) => file.path)).toEqual([codex, gemini])
    // Nothing is written by a preview.
    expect(await readFile(codex, 'utf8')).toBe(CODEX_TOML)

    const applied = await sync.apply(preview.id)
    expect(applied).toMatchObject({ ok: true, written: [codex, gemini], failed: null })
    const toml = await readFile(codex, 'utf8')
    expect(toml.startsWith(CODEX_TOML)).toBe(true)
    expect(parseToml(toml).value.mcp_servers).toMatchObject({
      context7: { command: 'npx', env: { CONTEXT7_API_KEY: TOKEN } },
    })
    const json = await readFile(gemini, 'utf8')
    expect(json.startsWith('{\n  // Gemini reads comments here\n  "theme": "Dracula",\n')).toBe(
      true,
    )
    expect(json).toContain(`"Authorization": "Bearer ${BEARER}"`)
    expect(await readFile(claude, 'utf8')).toBe(CLAUDE_JSON)

    const backups = path.join(data, 'agent-sync', 'backups')
    expect(applied.backup!.startsWith(backups)).toBe(true)
    const copies = (await readdir(applied.backup!)).sort()
    expect(copies).toEqual(['1-config.toml', '2-settings.json', 'backup.json'])
    expect(await readFile(path.join(applied.backup!, '1-config.toml'), 'utf8')).toBe(CODEX_TOML)

    // A preview is good once.
    await expect(sync.apply(preview.id)).rejects.toThrow()
  })

  it('writes nothing when a file changed after the preview', async () => {
    const { home, data, sync } = await fakeHome()
    const claude = at(home, '.claude.json')
    const gemini = at(home, '.gemini/settings.json')
    const preview = await sync.preview([
      { kind: 'mcp-add', server: 'context7', from: claude, to: gemini },
      { kind: 'mcp-remove', server: 'legacy', place: claude },
    ])
    expect(preview.files).toHaveLength(2)
    const edited = CLAUDE_JSON.replace('"numStartups": 41', '"numStartups": 42')
    await writeFile(claude, edited)
    const applied = await sync.apply(preview.id)
    expect(applied).toEqual({
      ok: false,
      changed: [claude],
      written: [],
      backup: null,
      failed: null,
    })
    expect(await readFile(claude, 'utf8')).toBe(edited)
    expect(await readFile(gemini, 'utf8')).toBe(GEMINI_JSON)
    await expect(readdir(path.join(data, 'agent-sync', 'backups'))).rejects.toThrow()
  })

  it('removes a server and refuses one written in a form it cannot take out', async () => {
    const { home, sync } = await fakeHome()
    const codex = at(home, '.codex/config.toml')
    const opencode = at(home, '.config/opencode/opencode.jsonc')
    const preview = await sync.preview([
      { kind: 'mcp-remove', server: 'inline', place: codex },
      { kind: 'mcp-remove', server: 'fs', place: opencode },
    ])
    expect(preview.problems).toEqual([
      expect.objectContaining({
        code: 'unsupported',
        change: expect.objectContaining({ server: 'inline' }),
      }),
    ])
    await sync.apply(preview.id)
    expect(await readFile(codex, 'utf8')).toBe(CODEX_TOML)
    expect(await readFile(opencode, 'utf8')).toBe(
      '{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {},\n}\n',
    )
  })

  it('keeps the shared snippets in a block and the user’s rules byte for byte', async () => {
    const { home, sync } = await fakeHome()
    const file = at(home, '.claude/CLAUDE.md')
    await sync.saveSnippets([
      { id: 'pnpm', title: 'pnpm', body: 'Use pnpm, never npm.' },
      { id: 'lang', title: 'Language', body: 'Answer in Chinese.' },
    ])
    const first = await sync.preview([
      { kind: 'instructions', place: file, snippetIds: ['pnpm', 'lang'] },
    ])
    expect(first.files[0]!.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'del')).toEqual(
      [],
    )
    await sync.apply(first.id)
    const written = await readFile(file, 'utf8')
    expect(written.startsWith(CLAUDE_MD)).toBe(true)
    expect(written).toContain(
      'Use pnpm, never npm.\n\nAnswer in Chinese.\n<!-- kite:shared end -->',
    )
    let place = (await sync.read()).instructions.find((p) => p.id === file)!
    expect(place).toMatchObject({ block: 'synced', snippetIds: ['pnpm', 'lang'] })

    // A changed snippet leaves the file's block outdated; an edit in the file shows as such.
    await sync.saveSnippets([
      { id: 'pnpm', title: 'pnpm', body: 'Use pnpm 10.' },
      { id: 'lang', title: 'Language', body: 'Answer in Chinese.' },
    ])
    place = (await sync.read()).instructions.find((p) => p.id === file)!
    expect(place.block).toBe('outdated')
    await writeFile(file, written.replace('Answer in Chinese.', 'Answer in French.'))
    place = (await sync.read()).instructions.find((p) => p.id === file)!
    expect(place.block).toBe('edited')
    const update = await sync.preview([{ kind: 'instructions', place: file, snippetIds: ['pnpm'] }])
    expect(update.files[0]!.notes).toEqual([{ kind: 'outside-edit' }])

    // Taking every snippet out gives back the file as the user had it.
    const out = await sync.preview([{ kind: 'instructions', place: file, snippetIds: [] }])
    await sync.apply(out.id)
    expect(await readFile(file, 'utf8')).toBe(CLAUDE_MD)
  })

  it('copies a skill folder to another agent once', async () => {
    const { home, sync } = await fakeHome()
    const from = at(home, '.claude/skills')
    const to = at(home, '.gemini/skills')
    const preview = await sync.preview([{ kind: 'skill-copy', skill: 'review', from, to }])
    expect(preview.files).toEqual([
      expect.objectContaining({ path: path.join(to, 'review'), action: 'copy', files: 2 }),
    ])
    await sync.apply(preview.id)
    expect(await readFile(path.join(to, 'review', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n')
    const again = await sync.preview([{ kind: 'skill-copy', skill: 'review', from, to }])
    expect(again.problems).toEqual([expect.objectContaining({ code: 'exists' })])
  })

  it('takes only places it found itself', async () => {
    const { home, sync } = await fakeHome()
    const outside = path.join(path.dirname(home), 'elsewhere.json')
    const preview = await sync.preview([
      { kind: 'mcp-add', server: 'context7', from: at(home, '.claude.json'), to: outside },
      { kind: 'instructions', place: outside, snippetIds: [] },
      { kind: 'skill-copy', skill: 'review', from: at(home, '.claude/skills'), to: outside },
    ])
    expect(preview.files).toEqual([])
    expect(preview.problems.map((problem) => problem.code)).toEqual([
      'unknown-place',
      'unknown-place',
      'unknown-place',
    ])
  })
})
