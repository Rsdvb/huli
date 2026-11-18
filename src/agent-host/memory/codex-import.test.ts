import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appliesTo, parseSummary, parseTaskGroups, readCodexMemory } from './codex-import'

let home: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kettu-codex-memory-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function write(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(home, file)), { recursive: true })
  await writeFile(path.join(home, file), text)
}

describe('Codex memory parsing', () => {
  it('reads the folders a task group applies to, a named project first', () => {
    expect(appliesTo('applies_to: cwd=C:\\work\\a; reuse_rule=x; y')).toEqual(['C:\\work\\a'])
    expect(appliesTo('applies_to: cwd=C:\\work\\a / project=D:\\b; reuse_rule=x')).toEqual([
      'D:\\b',
      'C:\\work\\a',
    ])
    expect(appliesTo('applies_to: cwd=\\\\?\\C:\\long; reuse_rule=x')).toEqual(['C:\\long'])
    expect(appliesTo('applies_to: cwd=/srv/app')).toEqual(['/srv/app'])
    expect(appliesTo('applies_to: anywhere; reuse_rule=x')).toEqual([])
    expect(appliesTo('applies_to: cwd=relative/path')).toEqual([])
  })

  it('makes each task group an entry, without the lists of rollout files', () => {
    const groups = parseTaskGroups(
      [
        '# Task Group: One',
        'scope: The first.',
        'applies_to: cwd=/a; reuse_rule=r',
        '## Task 1: Do it',
        '### rollout_summary_files',
        '- rollout_summaries/one.md (thread_id=1)',
        '### keywords',
        '- k',
        '## User preferences',
        '- Short replies. [Task 1]',
        '# Task Group: Empty',
        '',
      ].join('\n'),
    )
    expect(groups).toEqual([
      {
        heading: 'Task Group: One',
        title: 'One',
        description: 'The first.',
        body: [
          'applies_to: cwd=/a; reuse_rule=r',
          '## Task 1: Do it',
          '### keywords',
          '- k',
          '## User preferences',
          '- Short replies. [Task 1]',
        ].join('\n'),
        aboutUser: false,
        projects: ['/a'],
      },
    ])
  })

  it('takes the summary’s sections about the user, without placeholders or the index', () => {
    const text = [
      'v1',
      '## User Profile',
      'No durable user profile is supported by the available sources.',
      '## User preferences',
      '- Concrete evidence.',
      '## General Tips',
      '- Recheck state.',
      "## What's in Memory",
      '### Shop',
      '#### 2026-11-14',
      '- rollout_summaries/a.md — Released v2. thread_id=0a1b',
      '  - Project: `/work/shop`.',
      '### Older Memory Topics',
      '#### Old topic',
      '- Old knowledge.',
    ].join('\n')
    expect(parseSummary(text, false).map((item) => [item.title, item.aboutUser])).toEqual([
      ['User preferences (Codex)', true],
      ['General Tips (Codex)', false],
    ])
    const topics = parseSummary(text, true).filter((item) => item.heading.includes('/'))
    expect(topics.map((item) => [item.title, item.body, item.projects])).toEqual([
      ['Old topic', '- Old knowledge.', []],
      ['Shop', '- Released v2.\n  - Project: `/work/shop`.', ['/work/shop']],
    ])
  })
})

describe('readCodexMemory', () => {
  it('reads only the curated files of `memories`', async () => {
    await write('memories/MEMORY.md', '# Task Group: Kept\nscope: s\n- k\n')
    await write('memories/memory_summary.md', '## User Profile\nA person.\n')
    await write('memories/raw_memories.md', '# Raw Memories\n## Thread `x`\nraw\n')
    await write('memories/rollout_summaries/a.md', '# A rollout\nnotes\n')
    await write(
      'memories/extensions/ad_hoc/instructions.md',
      '# Ad-hoc notes\n## Instructions\nx\n',
    )
    await write('memories/skills/s/SKILL.md', '---\nname: s\n---\n# Skill\n')
    await write('memories_v2/memory_summary.md', '## General Tips\nFrom v2.\n')
    const memories = await readCodexMemory(home, () => {})
    expect(memories.map((m) => m.file)).toEqual([
      'memories/memory_summary.md#User Profile',
      'memories/MEMORY.md#Task Group: Kept',
    ])
  })

  it('falls back to `memories_v2` when `memories` has nothing; no home holds nothing', async () => {
    expect(await readCodexMemory(path.join(home, 'none'), () => {})).toEqual([])
    await write('memories_v2/memory_summary.md', '## General Tips\nFrom v2.\n')
    const memories = await readCodexMemory(home, () => {})
    expect(memories.map((m) => [m.file, m.draft.body])).toEqual([
      ['memories_v2/memory_summary.md#General Tips', 'From v2.'],
    ])
  })

  it('passes over an entry that seems to hold a secret', async () => {
    await write(
      'memories/MEMORY.md',
      `# Task Group: Leak\nscope: s\n- token ghp_${'a1'.repeat(18)}\n# Task Group: Fine\nscope: s\n- ok\n`,
    )
    const warnings: string[] = []
    const memories = await readCodexMemory(home, (_, message) => warnings.push(message))
    expect(memories.map((m) => m.draft.title)).toEqual(['Fine'])
    expect(warnings.join('\n')).toContain('Leak')
  })
})
