// Huli: what a review of a session's changes needs beside the session: the prompt Kite sends an
// agent without a review mode of its own, the reply's text it reads the findings from, the anchors
// that tell later whether a finding's line is still there, and the message that asks for fixes.

import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { anchorText, REVIEW_BLOCK, type ParsedReview, type ReviewFinding } from '@shared/review'
import type { ThreadState } from '@shared/thread'
import { currentLocale, t } from './i18n'

/** A file larger than this is not read for its findings' anchors. */
const ANCHOR_FILE_BYTES = 4 * 1024 * 1024

/** What the prompt carries so its turn can be told apart from the session's others. */
export function reviewMark(reviewId: string): string {
  return `[kite-review ${reviewId}]`
}

/**
 * Kite's review prompt for an agent without a review mode of its own: read only, every finding
 * pinned to the lines of the file as it is now, all of them in one JSON block at the end.
 */
export function reviewPrompt(reviewId: string): string {
  const language = currentLocale().startsWith('zh') ? 'Simplified Chinese' : 'English'
  return [
    `Review the uncommitted changes in this folder (staged, unstaged and untracked files) as a careful code reviewer. Kite asks this for the user. ${reviewMark(reviewId)}`,
    '',
    '- Look for real problems the changes bring: bugs, broken edge cases, security issues, missing error handling, changed behavior nobody asked for. Leave out style nits unless they hide a bug.',
    '- Only read. Do not change, create or delete any file, and run no command that changes anything.',
    '- Point each finding at the lines of the file as the working tree has it now, the path relative to your working directory.',
    `- Write each title and detail in ${language}.`,
    `- End your reply with one fenced block tagged ${REVIEW_BLOCK} holding only JSON of this shape, and nothing after it. With no problems found, give an empty list.`,
    '',
    '```' + REVIEW_BLOCK,
    '{"summary": "one or two sentences on the changes", "findings": [{"severity": "critical | high | medium | low", "title": "one line, at most 100 characters", "detail": "what is wrong and how to fix it", "file": "src/example.ts", "line": 12, "endLine": 14}]}',
    '```',
  ].join('\n')
}

/**
 * The agent's reply to the review prompt that carries `reviewId`'s mark: the text of its messages
 * after the prompt. Null while the prompt is not in the thread, as when it is still queued.
 */
export function reviewReply(thread: ThreadState, reviewId: string): string | null {
  const mark = reviewMark(reviewId)
  let at = -1
  for (let i = thread.order.length - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (
      entry?.kind === 'user' &&
      entry.content.some((part) => part.type === 'text' && part.text.includes(mark))
    ) {
      at = i
      break
    }
  }
  if (at < 0) return null
  const texts: string[] = []
  for (const id of thread.order.slice(at + 1)) {
    const entry = thread.byId[id]
    if (entry?.kind === 'agent' && entry.markdown.trim() !== '') texts.push(entry.markdown)
  }
  return texts.join('\n\n')
}

/** Whether `child` lies inside `root`, both resolved, case-insensitively on Windows. */
function inside(root: string, child: string, platform: NodeJS.Platform): boolean {
  const relative = path.relative(
    platform === 'win32' ? root.toLowerCase() : root,
    platform === 'win32' ? child.toLowerCase() : child,
  )
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * The parsed findings with ids and anchors: each one's first line as the file in `root` has it
 * now, read once a file, only for a file that really lies inside `root`. A file that cannot be
 * read leaves its findings without an anchor.
 */
export async function anchoredFindings(
  parsed: ParsedReview,
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ReviewFinding[]> {
  const files = new Map<string, Promise<string[] | null>>()
  const realRoot = realpath(root).catch(() => null)
  const lines = (relative: string): Promise<string[] | null> => {
    let read = files.get(relative)
    if (!read) {
      read = (async () => {
        const base = await realRoot
        if (base === null) return null
        const file = path.resolve(base, relative)
        if (!inside(base, file, platform)) return null
        const real = await realpath(file)
        if (!inside(base, real, platform)) return null
        const buffer = await readFile(real)
        if (buffer.length > ANCHOR_FILE_BYTES) return null
        return buffer.toString('utf8').split(/\r?\n/)
      })().catch(() => null)
      files.set(relative, read)
    }
    return read
  }
  return Promise.all(
    parsed.findings.map(async (finding, index) => {
      const text = (await lines(finding.path))?.[finding.start - 1]
      const anchor = text === undefined ? null : anchorText(text)
      return {
        ...finding,
        id: `f${index + 1}`,
        anchor: anchor === '' ? null : anchor,
        state: 'open' as const,
      }
    }),
  )
}

/** The message that sends findings back to the session's agent, in the user's language. */
export function fixMessage(findings: readonly ReviewFinding[]): string {
  const items = findings.map((finding, index) => {
    const lines =
      finding.start === finding.end ? `${finding.start}` : `${finding.start}-${finding.end}`
    const head = t('review.fix.item', {
      n: index + 1,
      severity: t(`review.severity.${finding.severity}`),
      place: `${finding.path}:${lines}`,
      title: finding.title,
    })
    const body = finding.body.trim()
    return body === '' ? head : `${head}\n${body.replace(/^/gm, '   ')}`
  })
  return [
    findings.length === 1 ? t('review.fix.one') : t('review.fix.many', { count: findings.length }),
    '',
    ...items,
    '',
    t('review.fix.after'),
  ].join('\n')
}
