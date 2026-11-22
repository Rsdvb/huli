// Huli: a moved session's transcript, rewritten for the computer it goes on on. Claude Code and
// Codex record the folder they work in on every line (`cwd`) and the paths their tools touched;
// on the target that folder is another one, often on another system, so each path inside the
// source's folder becomes the same path inside the target's, in the target's separators. A path
// elsewhere, and text that only mentions a path, stay as they are.

import { createReadStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { Platform } from '@shared/platform'

/** One side of a move: the folder the agent works in, and the system that names it. */
export interface MoveRoot {
  root: string
  platform: Platform
}

export interface TranscriptRewrite {
  from: MoveRoot
  to: MoveRoot
  /** The agent's own session id, when the target gives the session a new one. */
  sessionId?: { from: string; to: string }
  /** The branch the transcript records, when the target names it otherwise. */
  branch?: { from: string; to: string }
}

/** Keys whose value names the branch a line was written on. */
const BRANCH_KEYS = new Set(['gitBranch', 'branch'])

/** Deeper than any transcript line nests. */
const MAX_DEPTH = 64

function trimEnd(value: string, platform: Platform): string {
  const separators = platform === 'win32' ? /[\\/]+$/ : /\/+$/
  const trimmed = value.replace(separators, '')
  // `/` and `C:\` are roots: what is left of them is the root itself.
  if (trimmed === '') return platform === 'win32' ? value : '/'
  if (platform === 'win32' && /^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`
  return trimmed
}

function joinOn(root: string, parts: string[], platform: Platform): string {
  if (parts.length === 0) return root
  const sep = platform === 'win32' ? '\\' : '/'
  return root.endsWith(sep) ? `${root}${parts.join(sep)}` : `${root}${sep}${parts.join(sep)}`
}

/**
 * The same path under the target's folder, for a path that is the source's folder or inside it;
 * null for any other string. Windows' paths compare without case and with either separator.
 */
export function mapPath(value: string, from: MoveRoot, to: MoveRoot): string | null {
  if (value.length === 0 || value.length > 32_767) return null
  const root = trimEnd(from.root, from.platform)
  const target = trimEnd(to.root, to.platform)
  if (from.platform === 'win32') {
    const plain = value.replace(/\//g, '\\')
    const base = root.replace(/\//g, '\\')
    const lower = plain.toLowerCase()
    const key = base.toLowerCase()
    if (lower === key) return target
    const prefix = key.endsWith('\\') ? key : `${key}\\`
    if (!lower.startsWith(prefix)) return null
    const rest = plain.slice(prefix.length).split('\\').filter(Boolean)
    return joinOn(target, rest, to.platform)
  }
  if (value === root) return target
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (!value.startsWith(prefix)) return null
  return joinOn(target, value.slice(prefix.length).split('/').filter(Boolean), to.platform)
}

/** The value with every path in it mapped, every key too when `keys`; the same value if none was. */
export function rewriteValue(
  value: unknown,
  rewrite: TranscriptRewrite,
  keys = true,
  key: string | null = null,
  depth = 0,
): unknown {
  if (typeof value === 'string') {
    if (rewrite.sessionId && value === rewrite.sessionId.from) return rewrite.sessionId.to
    if (rewrite.branch && key !== null && BRANCH_KEYS.has(key) && value === rewrite.branch.from) {
      return rewrite.branch.to
    }
    return mapPath(value, rewrite.from, rewrite.to) ?? value
  }
  if (typeof value !== 'object' || value === null || depth >= MAX_DEPTH) return value
  if (Array.isArray(value)) {
    let out: unknown[] | null = null
    value.forEach((item: unknown, index) => {
      const next = rewriteValue(item, rewrite, keys, null, depth + 1)
      if (next !== item) (out ??= [...value])[index] = next
    })
    return out ?? value
  }
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    const mapped = keys ? (mapPath(name, rewrite.from, rewrite.to) ?? name) : name
    const next = rewriteValue(item, rewrite, keys, name, depth + 1)
    if (mapped !== name || next !== item) changed = true
    out[mapped] = next
  }
  return changed ? out : value
}

/** One JSONL line rewritten; a line that is not JSON stays as it is. */
export function rewriteLine(line: string, rewrite: TranscriptRewrite): string {
  if (line.trim() === '') return line
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return line
  }
  const next = rewriteValue(parsed, rewrite)
  return next === parsed ? line : JSON.stringify(next)
}

/** A whole transcript's text rewritten, its line breaks kept. */
export function rewriteTranscript(text: string, rewrite: TranscriptRewrite): string {
  return text
    .split('\n')
    .map((line) => {
      const cr = line.endsWith('\r')
      const body = cr ? line.slice(0, -1) : line
      return rewriteLine(body, rewrite) + (cr ? '\r' : '')
    })
    .join('\n')
}

/**
 * Rewrites the transcript at `from` into a new file at `to`, line by line so a large one never
 * sits in memory whole; fails when `to` exists, and leaves no part of it behind on a failure.
 */
export async function rewriteTranscriptFile(
  from: string,
  to: string,
  rewrite: TranscriptRewrite,
): Promise<void> {
  const out = await open(to, 'wx', 0o600)
  let ok = false
  try {
    const lines = createInterface({
      input: createReadStream(from, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    let batch: string[] = []
    let size = 0
    for await (const line of lines) {
      const next = rewriteLine(line, rewrite)
      batch.push(next, '\n')
      size += next.length
      if (size >= 1024 * 1024) {
        await out.write(batch.join(''))
        batch = []
        size = 0
      }
    }
    if (batch.length > 0) await out.write(batch.join(''))
    ok = true
  } finally {
    await out.close()
    if (!ok) await rm(to, { force: true })
  }
}
