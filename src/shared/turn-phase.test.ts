import { describe, expect, it } from 'vitest'
import type { SessionView, ThreadEntry, ThreadState, ToolEntry } from './thread'
import { thoughtHeading, turnDoing, turnWork } from './turn-phase'

function thread(entries: ThreadEntry[], status: SessionView['status'] = 'running'): ThreadState {
  return {
    session: { status } as SessionView,
    order: entries.map((e) => e.id),
    byId: Object.fromEntries(entries.map((e) => [e.id, e])),
  }
}

function tool(id: string, fields: Partial<ToolEntry>): ToolEntry {
  return {
    kind: 'tool',
    id,
    title: '',
    toolKind: 'other',
    status: 'in_progress',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...fields,
  }
}

const user: ThreadEntry = { kind: 'user', id: 'u', content: [] } as unknown as ThreadEntry

describe('turnDoing', () => {
  it('names the file a running read works on', () => {
    const state = thread([
      user,
      tool('t1', {
        toolKind: 'read',
        title: 'Read src/a/index.tsx (1 - 20)',
        locations: [{ path: '/p/src/a/index.tsx' }],
      }),
    ])
    expect(turnDoing(state)).toEqual({
      phase: 'read',
      count: 1,
      detail: 'index.tsx',
      quoted: false,
    })
  })

  it('names the first line of a running command and counts the others', () => {
    const state = thread([
      user,
      tool('t1', { toolKind: 'execute', title: 'ls', rawInput: 'ls' }),
      tool('t2', { toolKind: 'execute', title: 'Run ssh mac', rawInput: 'ssh mac \\\n  uptime' }),
    ])
    expect(turnDoing(state)).toMatchObject({ phase: 'execute', count: 2, detail: 'ssh mac \\' })
  })

  it('quotes what a search looks for', () => {
    const grep = thread([
      user,
      tool('t1', { toolKind: 'search', title: 'grep -n --include="*.ts" "tok/s" src' }),
    ])
    expect(turnDoing(grep)).toMatchObject({ phase: 'search', detail: 'tok/s', quoted: true })
    const glob = thread([user, tool('t1', { toolKind: 'search', title: 'Find `src` `**/*.ts`' })])
    expect(turnDoing(glob)).toMatchObject({ detail: '**/*.ts', quoted: true })
  })

  it('names an edit by the path of its diff', () => {
    const state = thread([
      user,
      tool('t1', {
        toolKind: 'edit',
        title: 'Edit',
        content: [{ type: 'diff', path: 'C:\\p\\Composer.tsx', oldText: 'a', newText: 'b' }],
      }),
    ])
    expect(turnDoing(state)).toMatchObject({ phase: 'edit', detail: 'Composer.tsx' })
  })

  it('gives the latest heading of a thought that streams', () => {
    const state = thread([
      user,
      {
        kind: 'thought',
        id: 'th',
        streaming: true,
        markdown: '**Reading the code**\n\nSome text.\n\n**Why the quota is missing**\n\nMore',
      },
    ])
    expect(turnDoing(state)).toEqual({
      phase: 'thinking',
      count: 1,
      detail: 'Why the quota is missing',
      quoted: false,
    })
  })

  it('names nothing for a thought without a heading, or a message being written', () => {
    const thinking = thread([
      user,
      { kind: 'thought', id: 'th', streaming: true, markdown: 'The user wants **this** done' },
    ])
    expect(turnDoing(thinking).detail).toBeNull()
    const writing = thread([
      user,
      { kind: 'agent', id: 'a', markdown: 'Hi', streaming: true } as unknown as ThreadEntry,
    ])
    expect(turnDoing(writing)).toMatchObject({ phase: 'writing', detail: null })
  })

  it('keeps the phase turnWork reads', () => {
    const state = thread([user, tool('t1', { toolKind: 'fetch', title: 'Fetch https://x.dev' })])
    expect(turnWork(state)).toEqual({ phase: 'fetch', count: 1, step: 'Fetch https://x.dev' })
    expect(turnDoing(state)).toMatchObject({ detail: 'https://x.dev', quoted: false })
  })
})

describe('thoughtHeading', () => {
  it('reads only a closed heading alone on its line', () => {
    expect(thoughtHeading('**Planning')).toBeNull()
    expect(thoughtHeading('**Planning** the next step')).toBeNull()
    expect(thoughtHeading('__Planning__')).toBe('Planning')
  })
})
