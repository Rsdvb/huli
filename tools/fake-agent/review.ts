// Answers Kite's review prompt as a reviewer would: a few words on the changes, then findings in a
// kite-review block, on the first lines of the first text files of the session's folder, with one
// finding outside it that the host must drop. `/review-garbage` in the folder's first file answers
// without the block.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { StopReason } from '@agentclientprotocol/sdk/unstable'
import type { Turn } from './turn.ts'

export const isReviewPrompt = (text: string): boolean => text.includes('[kite-review ')

const SKIPPED = new Set(['.git', 'node_modules', 'dist', 'out'])
const TEXT = /\.(?:ts|tsx|js|mjs|json|md|txt|css|html|py|rs|go)$/i

/** The folder's text files, nearest first, at most a few. */
async function textFiles(root: string, depth = 0): Promise<string[]> {
  const found: string[] = []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.isFile() && TEXT.test(entry.name)) found.push(entry.name)
  }
  for (const entry of entries) {
    if (found.length >= 3 || depth >= 2 || !entry.isDirectory() || SKIPPED.has(entry.name)) {
      continue
    }
    const inner = await textFiles(path.join(root, entry.name), depth + 1)
    found.push(...inner.map((name) => `${entry.name}/${name}`))
  }
  return found.slice(0, 3)
}

export async function review(turn: Turn): Promise<StopReason> {
  await turn.sleep(800)
  if (turn.signal.aborted) return 'cancelled'
  const files = await textFiles(turn.session.cwd)
  const first = files[0] ? await readFile(path.join(turn.session.cwd, files[0]), 'utf8') : ''
  const chinese = turn.text.includes('Simplified Chinese')
  const findings = files.flatMap((file, i) => [
    {
      severity: ['high', 'medium', 'low'][i],
      title: chinese ? `${file} 的第 ${i + 1} 行有问题` : `Line ${i + 1} of ${file} looks wrong`,
      detail: chinese
        ? '这里的取值没有处理空的情况，传进来空值时会抛异常。先判断一下再用。'
        : 'The value is used before it is checked, so an empty one throws. Check it first.',
      file,
      line: i + 1,
      endLine: i + 2,
    },
  ])
  findings.push({
    severity: 'critical',
    title: 'Outside the folder',
    detail: 'The host drops this one.',
    file: '../outside.txt',
    line: 1,
    endLine: 1,
  })
  const said = chinese ? '看了一下这些改动。' : 'I looked at the changes.'
  const block = first.includes('/review-garbage')
    ? ''
    : `\n\n\`\`\`kite-review\n${JSON.stringify({ summary: chinese ? '有几处要改。' : 'A few things to fix.', findings })}\n\`\`\``
  await turn.send({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: said + block },
  })
  return 'end_turn'
}
