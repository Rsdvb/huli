import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  digestPreview,
  hasToolDigest,
  threadFromSnapshot,
  type ThreadEntry,
  type ToolContent,
  type ToolEntry,
} from '@shared/thread'
import {
  diffCounts,
  DIGEST_INPUT_BYTES,
  DIGEST_OUTPUT_BYTES,
  digestEntries,
  digestEntry,
  LEAN_TITLE_CHARS,
  leanEntries,
  leanEntry,
  PREVIEW_BYTES,
  PREVIEW_LINES,
} from './digest'

const tool = (changes: Partial<ToolEntry> = {}): ToolEntry => ({
  kind: 'tool',
  id: 't1',
  title: 'Run',
  toolKind: 'execute',
  status: 'completed',
  content: [],
  locations: [],
  permission: null,
  permissionResult: null,
  ...changes,
})

const numbered = (count: number, from = 0): string =>
  Array.from({ length: count }, (_, i) => `line ${from + i}\n`).join('')

describe('tool digests', () => {
  it('leaves other entries, short outputs and inputs, small diffs and images alone', () => {
    const agent: ThreadEntry = {
      kind: 'agent',
      id: 'a1',
      markdown: 'x'.repeat(DIGEST_OUTPUT_BYTES * 4),
      attachments: [],
      streaming: false,
    }
    const short = tool({
      rawInput: 'x'.repeat(DIGEST_INPUT_BYTES),
      content: [
        { type: 'markdown', markdown: 'x'.repeat(DIGEST_OUTPUT_BYTES) },
        { type: 'diff', path: '/p/a.ts', oldText: 'a\n', newText: 'b\n' },
        { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', blob: 'ab'.repeat(32) } },
      ],
    })
    expect(digestEntry(agent)).toBe(agent)
    expect(digestEntry(short)).toBe(short)
  })

  it('turns a long output into its size and lines, by UTF-8 bytes', () => {
    const markdown = 'é'.repeat(DIGEST_OUTPUT_BYTES / 2) + '\nend\n'
    const image: ToolContent = {
      type: 'ref',
      ref: { kind: 'image', mimeType: 'image/png', blob: 'cd'.repeat(32) },
    }
    const entry = tool({ content: [{ type: 'markdown', markdown }, image] })
    expect(digestEntry(entry)).toEqual({
      ...entry,
      content: [{ type: 'digest', of: 'markdown', size: DIGEST_OUTPUT_BYTES + 5, lines: 2 }, image],
    })
    expect(entry.content[0]).toEqual({ type: 'markdown', markdown })
  })

  it('turns a long input into its size and lines in place of rawInput', () => {
    const rawInput = `cat <<EOF\n${'x'.repeat(DIGEST_INPUT_BYTES)}\nEOF`
    const digested = digestEntry(tool({ rawInput, title: 'cat' }))
    expect(digested).not.toHaveProperty('rawInput')
    expect(digested).toMatchObject({
      title: 'cat',
      rawInputDigest: { size: rawInput.length, lines: 3 },
    })
  })

  it('turns a large diff into its path, size and the lines it adds and removes', () => {
    const oldText = numbered(600)
    const newText = numbered(600).replace('line 10\n', 'ten\n').replace('line 500\n', '')
    const digested = digestEntry(
      tool({ toolKind: 'edit', content: [{ type: 'diff', path: '/p/a.ts', oldText, newText }] }),
    )
    expect(digested).toMatchObject({
      content: [
        {
          type: 'digest',
          of: 'diff',
          path: '/p/a.ts',
          size: oldText.length + newText.length,
          added: 1,
          removed: 2,
        },
      ],
    })
    const created = digestEntry(
      tool({
        content: [{ type: 'diff', path: '/p/b.ts', oldText: null, newText: numbered(1000) }],
      }),
    )
    expect(created).toMatchObject({ content: [{ added: 1000, removed: 0 }] })
  })

  it('keeps a call that waits for an answer whole', () => {
    const waiting = tool({
      status: 'pending',
      rawInput: 'x'.repeat(DIGEST_INPUT_BYTES * 2),
      content: [{ type: 'markdown', markdown: 'x'.repeat(DIGEST_OUTPUT_BYTES * 2) }],
      permission: { requestId: 'r1', options: [] },
    })
    expect(digestEntry(waiting)).toBe(waiting)
  })

  it('digests every entry of a page and keeps the rest of it', () => {
    const long = tool({ rawInput: 'x'.repeat(DIGEST_INPUT_BYTES + 1) })
    const page = { entries: [long], older: 3 }
    const digested = digestEntries(page)
    expect(digested.older).toBe(3)
    expect(digested.entries[0]).toHaveProperty('rawInputDigest')
    expect(page.entries[0]).toBe(long)
  })
})

describe('lean pages', () => {
  const output = '```\n' + numbered(2000) + '```'

  it("keeps a long output's first and last lines, within their caps", () => {
    const lean = leanEntry(tool({ content: [{ type: 'markdown', markdown: output }] }))
    if (lean.kind !== 'tool') throw new Error('not a tool call')
    const item = lean.content[0]!
    expect(item).toMatchObject({ type: 'digest', of: 'markdown', size: output.length, lines: 2002 })
    if (item.type !== 'digest' || item.of !== 'markdown') throw new Error('not a digest')
    expect(item.head).toBe('```\nline 0\nline 1\nline 2\nline 3')
    expect(item.tail).toBe('line 1996\nline 1997\nline 1998\nline 1999\n```')
    expect(item.head!.split('\n')).toHaveLength(PREVIEW_LINES)
    expect(digestPreview(item)).toBe(`${item.head}\n…\n${item.tail}`)
    // The digests of other pages carry no preview.
    const plain = digestEntry(tool({ content: [{ type: 'markdown', markdown: output }] }))
    if (plain.kind !== 'tool') throw new Error('not a tool call')
    expect(plain.content[0]).not.toHaveProperty('head')
    expect(digestPreview({ type: 'digest', of: 'markdown', size: 9, lines: 1 })).toBeNull()
  })

  it('cuts one long line of a preview at a character, by UTF-8 bytes', () => {
    const line = 'é'.repeat(PREVIEW_BYTES) + 'x' + '\u{1F600}'.repeat(PREVIEW_BYTES)
    const lean = leanEntry(tool({ content: [{ type: 'markdown', markdown: line }] }))
    if (lean.kind !== 'tool' || lean.content[0]?.type !== 'digest') throw new Error('no digest')
    const item = lean.content[0]
    if (item.of !== 'markdown') throw new Error('not markdown')
    expect(item.head).toBe('é'.repeat(PREVIEW_BYTES / 2))
    expect(item.tail).toBe('\u{1F600}'.repeat(PREVIEW_BYTES / 4))
  })

  it('cuts a long title, saying its size, and digests an input as other pages do', () => {
    const title = `Run ${'a'.repeat(LEAN_TITLE_CHARS - 5)}\u{1F600}${'b'.repeat(500)}`
    const rawInput = 'x'.repeat(DIGEST_INPUT_BYTES + 1)
    const lean = leanEntry(tool({ title, rawInput }))
    // The cut falls inside the pair, which is left out whole.
    expect(lean).toMatchObject({
      title: `${title.slice(0, LEAN_TITLE_CHARS - 1)}…`,
      titleSize: Buffer.byteLength(title),
      rawInputDigest: { size: DIGEST_INPUT_BYTES + 1, lines: 1 },
    })
    expect(lean).not.toHaveProperty('rawInput')
    expect(hasToolDigest(lean)).toBe(true)
    // Outside a lean page the title stays whole.
    expect(digestEntry(tool({ title, rawInput }))).toMatchObject({ title })
    expect(leanEntry(tool({ title, rawInput: 'x'.repeat(DIGEST_INPUT_BYTES) }))).toMatchObject({
      rawInput: 'x'.repeat(DIGEST_INPUT_BYTES),
    })
    const short = tool({ title: 'Run ls', rawInput: 'ls' })
    expect(leanEntry(short)).toBe(short)
  })

  it('says a large diff made its file, and keeps a waiting call and other entries whole', () => {
    const made = leanEntry(
      tool({
        toolKind: 'edit',
        content: [{ type: 'diff', path: '/p/b.ts', oldText: null, newText: numbered(1000) }],
      }),
    )
    expect(made).toMatchObject({
      content: [{ of: 'diff', added: 1000, removed: 0, created: true }],
    })
    const changed = leanEntry(
      tool({
        toolKind: 'edit',
        content: [
          { type: 'diff', path: '/p/a.ts', oldText: numbered(600), newText: numbered(601) },
        ],
      }),
    )
    if (changed.kind !== 'tool') throw new Error('not a tool call')
    expect(changed.content[0]).toMatchObject({ of: 'diff', added: 1, removed: 0 })
    expect(changed.content[0]).not.toHaveProperty('created')
    const small = tool({
      content: [{ type: 'diff', path: '/p/a.ts', oldText: 'a\n', newText: 'b\n' }],
    })
    expect(leanEntry(small)).toBe(small)
    const waiting = tool({
      title: 'x'.repeat(LEAN_TITLE_CHARS * 2),
      content: [{ type: 'markdown', markdown: output }],
      permission: { requestId: 'r1', options: [] },
    })
    expect(leanEntry(waiting)).toBe(waiting)
    const agent: ThreadEntry = {
      kind: 'agent',
      id: 'a1',
      markdown: output,
      attachments: [],
      streaming: false,
    }
    const page = leanEntries({ entries: [agent], older: 4 })
    expect(page).toEqual({ entries: [agent], older: 4 })
    expect(page.entries[0]).toBe(agent)
  })

  it('drops a cut title once a patch sets the title', () => {
    const lean = leanEntry(tool({ title: 'x'.repeat(LEAN_TITLE_CHARS * 2) }))
    const thread = threadFromSnapshot({
      session: { id: 's' } as never,
      entries: [lean as ThreadEntry],
      seq: 0,
    })
    const next = applyPatches(thread, [
      { op: 'entry.update', id: 't1', changes: { status: 'completed' } },
    ])
    expect(next.byId.t1).toHaveProperty('titleSize')
    const titled = applyPatches(next, [{ op: 'entry.update', id: 't1', changes: { title: 'Run' } }])
    expect(titled.byId.t1).not.toHaveProperty('titleSize')
    expect(hasToolDigest(titled.byId.t1)).toBe(false)
  })
})

describe('diff counts', () => {
  it('counts the lines of changes far apart as the diff view does', () => {
    const before = numbered(50)
    const after = before.replace('line 3\n', 'three\n').replace('line 40\n', 'line 40\nnew\n')
    expect(diffCounts(before, after)).toEqual({ added: 2, removed: 1 })
    expect(diffCounts(before, before)).toEqual({ added: 0, removed: 0 })
    expect(diffCounts('', 'a\nb')).toEqual({ added: 2, removed: 0 })
    expect(diffCounts('a\nb\n', '')).toEqual({ added: 0, removed: 2 })
  })

  it('gives no counts for a change too large to compare quickly', () => {
    expect(diffCounts(numbered(3000), numbered(3000, 10_000))).toEqual({
      added: null,
      removed: null,
    })
  })
})
