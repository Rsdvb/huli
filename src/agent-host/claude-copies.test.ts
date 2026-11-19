import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeCopies, syncClaudeTranscript } from './claude-copies'
import { claudeProjectFolder } from './prompt-cache'

const SESSION = '1b3e33b5-0398-45a8-95d7-eb6d1548192c'
const NOW = Date.parse('2026-11-19T12:00:00.000Z')

const message = (
  type: 'user' | 'assistant',
  uuid: string,
  parentUuid: string | null,
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    type,
    uuid,
    parentUuid,
    timestamp: new Date(NOW).toISOString(),
    ...extra,
  })

describe('Claude Code transcripts continued in another folder', () => {
  let root: string
  let cwd: string
  let home: string

  beforeEach(async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-copies-')))
    root = path.join(base, 'projects')
    cwd = path.join(base, 'work')
    await mkdir(cwd)
    home = path.join(root, claudeProjectFolder(cwd))
  })

  afterEach(async () => {
    await rm(path.dirname(root), { recursive: true, force: true })
  })

  async function transcript(folder: string, lines: string[]): Promise<string> {
    await mkdir(folder, { recursive: true })
    const file = path.join(folder, `${SESSION}.jsonl`)
    await writeFile(file, lines.join('\n') + '\n')
    return file
  }

  const start = [
    message('user', 'u1', null),
    message('assistant', 'a1', 'u1'),
    JSON.stringify({ type: 'custom-title', customTitle: 'x' }),
  ]

  it('brings in a copy that holds the whole conversation and more, keeping the old one', async () => {
    const own = await transcript(home, start)
    const moved = await transcript(path.join(root, 'scratch'), [
      ...start,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'c1',
        parentUuid: null,
        logicalParentUuid: 'a1',
      }),
      message('user', 'u2', 'c1'),
      message('assistant', 's1', 'u2', { isSidechain: true }),
      message('assistant', 'a2', 'u2'),
    ])
    const subagents = path.join(root, 'scratch', SESSION, 'subagents')
    await mkdir(subagents, { recursive: true })
    await writeFile(path.join(subagents, 'agent-1.jsonl'), 'sub\n')

    await expect(claudeCopies(root, cwd, SESSION)).resolves.toEqual({
      home: own,
      current: moved,
      moved: true,
      forks: [],
    })
    await expect(syncClaudeTranscript(root, cwd, SESSION, NOW)).resolves.toBe('synced')

    expect(await readFile(own, 'utf8')).toBe(await readFile(moved, 'utf8'))
    const backup = `${own}.kite-bak-2026-11-19T12-00-00-000Z`
    expect(await readFile(backup, 'utf8')).toBe(start.join('\n') + '\n')
    expect(await readFile(path.join(home, SESSION, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe(
      'sub\n',
    )
    // Brought in, both copies end alike and nothing more moves.
    await expect(claudeCopies(root, cwd, SESSION)).resolves.toMatchObject({
      current: own,
      moved: false,
    })
    await expect(syncClaudeTranscript(root, cwd, SESSION, NOW + 1)).resolves.toBe('unchanged')
  })

  it('leaves a fork alone', async () => {
    const own = await transcript(home, [...start, message('user', 'u2', 'a1')])
    const fork = await transcript(path.join(root, 'scratch'), [
      ...start,
      message('user', 'f2', 'a1'),
      message('assistant', 'f3', 'f2'),
    ])

    await expect(claudeCopies(root, cwd, SESSION)).resolves.toEqual({
      home: own,
      current: own,
      moved: false,
      forks: [fork],
    })
    await expect(syncClaudeTranscript(root, cwd, SESSION, NOW)).resolves.toBe('fork')
    expect(await readFile(own, 'utf8')).toContain('"u2"')
    expect(await readdir(home)).toEqual([`${SESSION}.jsonl`])
  })

  it('changes nothing without another copy, or with one this session went on from', async () => {
    const own = await transcript(home, [...start, message('user', 'u2', 'a1')])
    await expect(syncClaudeTranscript(root, cwd, SESSION, NOW)).resolves.toBe('unchanged')

    await transcript(path.join(root, 'scratch'), start)
    await expect(claudeCopies(root, cwd, SESSION)).resolves.toEqual({
      home: own,
      current: own,
      moved: false,
      forks: [],
    })
    await expect(syncClaudeTranscript(root, cwd, SESSION, NOW)).resolves.toBe('unchanged')
    expect(await readdir(home)).toEqual([`${SESSION}.jsonl`])
  })

  it('follows a transcript that grows, and one written anew', async () => {
    const own = await transcript(home, start)
    const moved = await transcript(path.join(root, 'scratch'), start)
    await expect(claudeCopies(root, cwd, SESSION)).resolves.toMatchObject({ moved: false })

    await writeFile(moved, [...start, message('user', 'u2', 'a1')].join('\n') + '\n')
    await expect(claudeCopies(root, cwd, SESSION)).resolves.toMatchObject({
      current: moved,
      moved: true,
    })

    await writeFile(
      own,
      [...start, message('user', 'u2', 'a1'), message('user', 'u3', 'u2')].join('\n') + '\n',
    )
    await expect(claudeCopies(root, cwd, SESSION)).resolves.toMatchObject({
      current: own,
      moved: false,
      forks: [],
    })
  })
})
