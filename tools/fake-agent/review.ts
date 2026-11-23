// Answers Kite's review prompt as a reviewer would: a few words on the changes, then findings in a
// kite-review block. In a Git folder each changed file gets one, on its first added line, and the
// second also one on its first line, which the diff folds away; elsewhere the first text files get
// one on a line each. One finding names a file outside the folder, which the host must drop.
// `/review-garbage` in the first file answers without the block.

import { execFile } from 'node:child_process'
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

const git = (cwd: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout) =>
      resolve(error ? null : stdout),
    )
  })

/** Each changed file's first added line, from `git diff`; null outside a repository. */
async function changedLines(cwd: string): Promise<{ file: string; line: number }[] | null> {
  const diff = await git(cwd, ['diff', '-U0', '--no-color', '--relative', 'HEAD'])
  if (diff === null) return null
  const out: { file: string; line: number }[] = []
  let file: string | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6).trim() : null
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && file && hunk[2] !== '0' && !out.some((item) => item.file === file)) {
      out.push({ file, line: Number(hunk[1]) })
    }
  }
  return out.slice(0, 3)
}

export async function review(turn: Turn): Promise<StopReason> {
  await turn.sleep(800)
  if (turn.signal.aborted) return 'cancelled'
  const { cwd } = turn.session
  const changed = await changedLines(cwd)
  const places =
    changed && changed.length > 0
      ? [
          ...changed.map(({ file, line }) => ({ file, line, end: line })),
          ...(changed[1] ? [{ file: changed[1].file, line: 1, end: 1 }] : []),
        ]
      : (await textFiles(cwd)).map((file, i) => ({ file, line: i + 1, end: i + 2 }))
  const first = places[0] ? await readFile(path.join(cwd, places[0].file), 'utf8') : ''
  const chinese = turn.text.includes('Simplified Chinese')
  const findings = places.map(({ file, line, end }, i) => ({
    severity: ['high', 'medium', 'low', 'critical'][i % 4],
    title: chinese
      ? [
          `${path.basename(file)} 这里没有处理空值`,
          '新加的判断漏了一种情况',
          '函数名看不出它做什么',
        ][i % 3]
      : [
          `${path.basename(file)} does not handle an empty value`,
          'The new check misses a case',
          'The name does not say what it does',
        ][i % 3],
    detail: chinese
      ? '传进来的值可能是空的，这里直接用了，会在运行时抛异常。先判断一下，或者给个默认值。'
      : 'The value can be empty and is used as it is, which throws at run time. Check it first, or give it a default.',
    file,
    line,
    endLine: end,
  }))
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
