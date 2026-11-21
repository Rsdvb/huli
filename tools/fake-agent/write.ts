// The `write` scenario: a real edit in the session's folder, so worktree features such as best of
// N have changes to compare. `/write [file] [text]` writes the text, its model's name and the time
// into the file, `notes.md` by default, under a heading of the model's own, and says so with an
// edit tool call carrying the diff.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import type { Scenario } from './turn.ts'

const DEFAULT_FILE = 'notes.md'

function inside(cwd: string, relative: string): string | null {
  const clean = normalize(relative)
  if (isAbsolute(clean) || clean === '..' || clean.startsWith(`..${sep}`)) return null
  return join(cwd, clean)
}

export const write: Scenario = async (turn) => {
  const [first = '', ...rest] = (turn.text ?? '').trim().split(/\s+/)
  const named = /\.[A-Za-z0-9]+$/.test(first)
  const file = named ? first : DEFAULT_FILE
  const words = (named ? rest : [first, ...rest]).join(' ').trim()
  const path = inside(turn.session.cwd, file)
  const messageId = turn.messageId()
  const say = (text: string) =>
    turn.send({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })
  if (!path) {
    await say(`I only write inside the session's folder, not ${file}.`)
    return 'end_turn'
  }
  const before = await readFile(path, 'utf8').catch(() => null)
  const model = turn.session.model
  const lines = [
    `## ${model}`,
    '',
    words || `A change written by the fake agent's ${model} model.`,
    '',
    `- Model: ${model}`,
    `- Written at ${new Date().toISOString()}`,
    '',
  ]
  const after = `${before ?? '# Notes\n\n'}${lines.join('\n')}`
  const toolCallId = `write-${turn.id}`
  await turn.send({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: `Edit ${file}`,
    kind: 'edit',
    status: 'in_progress',
    locations: [{ path }],
    rawInput: { file_path: path, content: after },
  })
  await turn.sleep(400)
  if (turn.signal.aborted) return 'cancelled'
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, after)
  await turn.send({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [{ type: 'diff', path, oldText: before, newText: after }],
  })
  await say(`I wrote my take into \`${file}\` with the ${model} model.`)
  return 'end_turn'
}
