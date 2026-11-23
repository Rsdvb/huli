// A made-up long session for measuring the conversation list without a computer: turns of a user
// message (some long, some with a picture), a run of thoughts and tool calls with their outputs,
// files read and edits, now and then a sub-agent, and a long Markdown reply with headings, lists,
// code blocks and tables. The same `count` always makes the same thread. `useLongThread` serves it
// as an open session does: the latest page first, older pages on demand after a short wait, and,
// with `stream`, a live turn whose reply is written token by token.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  applyPatches,
  prependEntries,
  threadFromSnapshot,
  type Patch,
  type SessionView,
  type ThreadEntry,
  type ThreadState,
  type ToolEntry,
} from '@shared/thread'
import { createStore } from '../select'
import type { ThreadView } from '../thread'

export const DEV_SESSION = 'dev-long-thread'

// A 2 by 2 PNG, enough for a thumbnail's box to draw something.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8Dwn4GBgYGJAQoAAAD//wMAKnQEAeY0Xa0AAAAASUVORK5CYII='

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const WORDS =
  'the list keeps its place while older pages load above and the reply streams in below so a reader never loses the line they were on when a tool call opens or a picture arrives we measure frames on the simulator and compare the hitch ratio before and after each change to the rows and the list itself'.split(
    ' ',
  )
const NAMES = ['Conversation', 'ThreadRow', 'Markdown', 'RunRow', 'ToolRow', 'useThread']
const FILES = [
  'mobile/src/components/Conversation.tsx',
  'mobile/src/components/EntryView.tsx',
  'mobile/src/ui/session/turns.ts',
  'src/shared/thread.ts',
  'mobile/src/components/Markdown.tsx',
]

function words(next: () => number, count: number): string {
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(WORDS[Math.floor(next() * WORDS.length)]!)
  const text = out.join(' ')
  return text[0]!.toUpperCase() + text.slice(1)
}

function sentence(next: () => number): string {
  const name = NAMES[Math.floor(next() * NAMES.length)]!
  const base = words(next, 8 + Math.floor(next() * 14))
  const at = Math.floor(next() * 3)
  return at === 0
    ? `${base}, and \`${name}\` **keeps** it.`
    : at === 1
      ? `${base} in [${name}](https://example.com/${name}).`
      : `${base}.`
}

function paragraph(next: () => number, sentences: number): string {
  return Array.from({ length: sentences }, () => sentence(next)).join(' ')
}

function code(next: () => number, lines: number): string {
  const out: string[] = []
  for (let i = 0; i < lines; i++) {
    const indent = '  '.repeat(Math.floor(next() * 3))
    const kind = Math.floor(next() * 4)
    out.push(
      kind === 0
        ? `${indent}const value${i} = compute('${words(next, 2)}', ${Math.floor(next() * 900)})`
        : kind === 1
          ? `${indent}// ${words(next, 6)}`
          : kind === 2
            ? `${indent}if (rows.length > ${i}) return keep(rows[${i}]!)`
            : `${indent}export function step${i}(list: Row[]): number { return list.length * ${i} }`,
    )
  }
  return out.join('\n')
}

function table(next: () => number): string {
  const columns = 3 + Math.floor(next() * 3)
  const head = ['Row kind', 'Before', 'After', 'Change', 'Notes'].slice(0, columns)
  const rows = Array.from({ length: 4 + Math.floor(next() * 5) }, (_, r) =>
    head.map((_, c) =>
      c === 0
        ? NAMES[r % NAMES.length]!
        : c < 4
          ? `${Math.floor(next() * 120)} ms`
          : words(next, 3),
    ),
  )
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

/** A long reply, as agents write them after a run of work. */
function reply(next: () => number): string {
  const parts: string[] = [`## ${words(next, 4)}`, paragraph(next, 3)]
  const lang = ['ts', 'py', 'sh', 'tsx'][Math.floor(next() * 4)]!
  if (next() < 0.7)
    parts.push('```' + lang + '\n' + code(next, 6 + Math.floor(next() * 40)) + '\n```')
  parts.push(
    Array.from({ length: 3 + Math.floor(next() * 4) }, () => `- ${sentence(next)}`).join('\n'),
  )
  if (next() < 0.45) parts.push(table(next))
  parts.push(paragraph(next, 2))
  if (next() < 0.3) parts.push(`> ${paragraph(next, 2)}`)
  if (next() < 0.4) {
    parts.push(
      Array.from(
        { length: 3 + Math.floor(next() * 3) },
        (_, i) => `${i + 1}. ${sentence(next)}`,
      ).join('\n'),
    )
  }
  if (next() < 0.35) parts.push(`### ${words(next, 3)}`, paragraph(next, 4))
  return parts.join('\n\n')
}

function tool(next: () => number, id: string): ToolEntry {
  const base = {
    kind: 'tool' as const,
    id,
    status: (next() < 0.06 ? 'failed' : 'completed') as ToolEntry['status'],
    permission: null,
    permissionResult: null,
  }
  const file = FILES[Math.floor(next() * FILES.length)]!
  const kind = Math.floor(next() * 5)
  if (kind === 0) {
    const lines = 20 + Math.floor(next() * 160)
    const start = 1 + Math.floor(next() * 300)
    const body = code(next, lines)
      .split('\n')
      .map((line, i) => `${start + i}\t${line}`)
      .join('\n')
    return {
      ...base,
      title: `Read ${file}`,
      toolKind: 'read',
      locations: [{ path: `/work/huli/${file}` }],
      content: [{ type: 'markdown', markdown: '```\n' + body + '\n```' }],
    }
  }
  if (kind === 1) {
    const command = [
      'pnpm test',
      'git status --short',
      'npx tsc --noEmit',
      'rg -n "FlatList" mobile/src',
    ][Math.floor(next() * 4)]!
    const output = Array.from(
      { length: 4 + Math.floor(next() * 70) },
      (_, i) => `${i % 7 === 0 ? 'PASS' : '  ok'} ${words(next, 5)}`,
    ).join('\n')
    return {
      ...base,
      title: command,
      rawInput: command,
      toolKind: 'execute',
      locations: [],
      content: [{ type: 'markdown', markdown: '```\n' + output + '\n```' }],
      description: words(next, 6),
    }
  }
  if (kind === 2) {
    const before = code(next, 10 + Math.floor(next() * 30))
    const after = before
      .split('\n')
      .map((line, i) => (i % 4 === 0 ? `${line} // changed` : line))
      .join('\n')
    return {
      ...base,
      title: `Edit ${file}`,
      toolKind: 'edit',
      locations: [{ path: `/work/huli/${file}` }],
      content: [{ type: 'diff', path: `/work/huli/${file}`, oldText: before, newText: after }],
    }
  }
  if (kind === 3) {
    return {
      ...base,
      title: `Search "${words(next, 2)}"`,
      toolKind: 'search',
      locations: [],
      content: [
        {
          type: 'markdown',
          markdown: FILES.map((f, i) => `${f}:${10 + i * 7}: ${words(next, 6)}`).join('\n'),
        },
      ],
    }
  }
  return {
    ...base,
    title: `Fetch https://docs.example.com/${words(next, 1)}`,
    toolKind: 'fetch',
    locations: [],
    content: [{ type: 'markdown', markdown: paragraph(next, 5) }],
  }
}

/**
 * `count` entries of a long session, oldest first. Sub-agents' cards read their session through
 * the link, so a phone with no computer gets none (`children` false).
 */
export function longThreadEntries(count: number, children = true, seed = 7): ThreadEntry[] {
  const next = random(seed)
  const out: ThreadEntry[] = []
  let n = 0
  const id = () => `e${n++}`
  let turn = 0
  const at = Date.now() - count * 60_000
  while (out.length < count) {
    turn++
    const long = next() < 0.15
    const picture = next() < 0.15
    out.push({
      kind: 'user',
      id: id(),
      at: at + out.length * 60_000,
      content: [
        ...(picture
          ? [
              {
                type: 'ref' as const,
                ref: { kind: 'image' as const, mimeType: 'image/png', data: PNG },
              },
            ]
          : []),
        {
          type: 'text',
          text: long
            ? Array.from({ length: 6 }, () => paragraph(next, 4)).join('\n\n')
            : sentence(next),
        },
      ],
    })
    out.push({
      kind: 'thought',
      id: id(),
      markdown: `**${words(next, 4)}**\n\n${paragraph(next, 3)}`,
      streaming: false,
      durationMs: 1000 + Math.floor(next() * 9000),
    })
    const tools = Math.floor(next() * 9)
    for (let i = 0; i < tools; i++) out.push(tool(next, id()))
    if (children && turn % 6 === 0)
      out.push({ kind: 'subagent', id: id(), sessionId: `dev-child-${turn}` })
    if (next() < 0.3) out.push(tool(next, id()))
    out.push({
      kind: 'agent',
      id: id(),
      markdown: reply(next),
      streaming: false,
      attachments: next() < 0.08 ? [{ kind: 'image', mimeType: 'image/png', data: PNG }] : [],
    })
    if (turn % 11 === 0) {
      out.push({
        kind: 'git',
        id: id(),
        event: 'commit',
        commits: [{ oid: `abc${turn}`, subject: words(next, 5) }],
        more: 0,
      })
    }
    out.push({
      kind: 'turn_end',
      id: id(),
      stopReason: 'end_turn',
      durationMs: 20_000 + Math.floor(next() * 200_000),
    })
  }
  return out
}

function session(running: boolean): SessionView {
  const now = Date.now()
  return {
    id: DEV_SESSION,
    agentId: 'claude-code',
    projectPath: '/work/huli',
    acpSessionId: null,
    status: running ? 'running' : 'ready',
    title: 'Long thread',
    config: [],
    commands: [],
    usage: null,
    error: null,
    turnStartedAt: running ? now : null,
    turnStartUsed: null,
    createdAt: now,
    updatedAt: now,
    parentId: null,
    origin: 'user',
    subagent: null,
    routine: null,
    queue: [],
    queuePaused: false,
  }
}

/**
 * The made-up session as the conversation reads it: `page` entries at a time, older pages after a
 * wait, and with `stream`, a turn that keeps running, its reply growing every 50 ms.
 */
export function useLongThread(options: {
  entries: number
  page: number
  stream: boolean
  children: boolean
}): {
  view: ThreadView
  running: boolean
} {
  const all = useMemo(
    () => longThreadEntries(options.entries, options.children),
    [options.entries, options.children],
  )
  const start = useRef(Math.max(0, all.length - options.page))
  const store = useMemo(
    () =>
      createStore<ThreadState | null>(
        threadFromSnapshot({
          session: session(options.stream),
          entries: all.slice(start.current),
          seq: 0,
        }),
      ),
    [all, options.stream],
  )
  const [hasOlder, setHasOlder] = useState(start.current > 0)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const loading = useRef(false)

  const loadOlder = () => {
    if (loading.current || start.current === 0) return
    loading.current = true
    setLoadingOlder(true)
    setTimeout(() => {
      const from = Math.max(0, start.current - options.page)
      const page = all.slice(from, start.current)
      start.current = from
      store.set((thread) => (thread ? prependEntries(thread, page) : thread))
      loading.current = false
      setLoadingOlder(false)
      setHasOlder(from > 0)
    }, 350)
  }

  useEffect(() => {
    if (!options.stream) return
    const next = random(99)
    let n = 0
    let writing: string | null = null
    let target = ''
    let written = 0
    let step = 0
    const apply = (patches: Patch[]) =>
      store.set((thread) => (thread ? applyPatches(thread, patches) : thread))
    const timer = setInterval(() => {
      step++
      if (writing) {
        const piece = target.slice(written, written + 6 + Math.floor(next() * 14))
        written += piece.length
        if (piece) apply([{ op: 'entry.appendText', id: writing, text: piece }])
        if (written >= target.length) {
          apply([
            { op: 'entry.update', id: writing, changes: { streaming: false } },
            {
              op: 'entry.add',
              entry: {
                kind: 'turn_end',
                id: `s${n++}`,
                stopReason: 'end_turn',
                durationMs: 30_000,
              },
            },
            {
              op: 'entry.add',
              entry: {
                kind: 'user',
                id: `s${n++}`,
                at: Date.now(),
                content: [{ type: 'text', text: sentence(next) }],
              },
            },
          ])
          writing = null
          step = 0
        }
        return
      }
      // Before each reply, a few tool calls that run for a moment each.
      if (step % 12 === 1 && step < 60) {
        const made = tool(next, `s${n++}`)
        apply([{ op: 'entry.add', entry: { ...made, status: 'in_progress', content: [] } }])
        const id = made.id
        setTimeout(
          () =>
            apply([
              { op: 'entry.update', id, changes: { status: made.status, content: made.content } },
            ]),
          400,
        )
        return
      }
      if (step >= 60) {
        writing = `s${n++}`
        target = reply(next)
        written = 0
        apply([
          {
            op: 'entry.add',
            entry: { kind: 'agent', id: writing, markdown: '', attachments: [], streaming: true },
          },
        ])
      }
    }, 50)
    return () => clearInterval(timer)
  }, [options.stream, store])

  return {
    view: {
      store,
      cached: false,
      cacheRead: true,
      error: null,
      reads: 1,
      retry: () => {},
      hasOlder,
      loadingOlder,
      olderError: null,
      loadOlder,
      requests: [],
      reloadRequests: () => {},
      plan: null,
    },
    running: options.stream,
  }
}
