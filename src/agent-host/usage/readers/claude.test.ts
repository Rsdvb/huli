import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readLog } from './claude'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const AT = '2026-11-27T10:00:00.000Z'
const lines = (...items: object[]) => items.map((item) => `${JSON.stringify(item)}\n`).join('')
const image = (data: string) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data },
})
const user = (content: unknown[], extra: object = {}) => ({
  type: 'user',
  timestamp: AT,
  message: { role: 'user', content },
  ...extra,
})
const assistant = (id: string, extra: object = {}) => ({
  type: 'assistant',
  timestamp: AT,
  sessionId: 's1',
  message: {
    id,
    model: 'claude-opus-4-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 },
  },
  ...extra,
})

it('gives each request the images its context held, until a compaction drops them', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-claude-log-'))
  dirs.push(dir)
  const file = path.join(dir, 's1.jsonl')
  writeFileSync(
    file,
    lines(
      assistant('m1'),
      user([{ type: 'tool_result', tool_use_id: 't1', content: [image('A'.repeat(4000))] }]),
      assistant('m2'),
      user([{ type: 'text', text: 'and this' }, image('B'.repeat(1000))]),
      // A sidechain's images are its own context's.
      user([image('C'.repeat(9000))], { isSidechain: true }),
      assistant('m3'),
      assistant('m4', { isSidechain: true }),
      { type: 'system', subtype: 'compact_boundary', timestamp: AT },
      assistant('m5'),
    ),
  )
  const first = await readLog(file, null, new AbortController().signal)
  const images = (rows: typeof first.rows) =>
    rows.map((row) => [row.key, row.images ?? 0, row.imageBytes ?? 0])
  expect(images(first.rows)).toEqual([
    ['claude:m1', 0, 0],
    ['claude:m2', 1, 4000],
    ['claude:m3', 2, 5000],
    ['claude:m4', 0, 0],
    ['claude:m5', 0, 0],
  ])
  expect(first.cursor.state).toBeNull()

  // A later read goes on from what the context held where the last one stopped.
  appendFileSync(file, lines(user([image('D'.repeat(800))]), assistant('m6')))
  const second = await readLog(file, first.cursor, new AbortController().signal)
  appendFileSync(file, lines(assistant('m7')))
  const third = await readLog(file, second.cursor, new AbortController().signal)
  expect(images([...second.rows, ...third.rows])).toEqual([
    ['claude:m6', 1, 800],
    ['claude:m7', 1, 800],
  ])
})
