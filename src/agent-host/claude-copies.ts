// Huli: a Claude Code session another program continued in another working folder, as the Claude
// desktop app does when it resumes a session in a scratch folder, goes on in a copy of its
// transcript under that folder's project folder. Claude Code resumes a session only from the
// project folder of the folder it runs in, so these find the copy that carries the conversation on
// and bring it into the session's own folder. Nothing under Claude Code's folder is ever deleted.

import { constants } from 'node:fs'
import { copyFile, cp, open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { claudeProjectFolder } from './prompt-cache'

/** A transcript larger than this is not compared with its copies. */
const READ_LIMIT = 256 * 1024 * 1024
/** Transcripts whose chains are kept between looks. */
const KEPT = 32
/** What is read again before a kept chain's end, to tell an appended file from a rewritten one. */
const EDGE = 256
const SESSION_ID = /^[A-Za-z0-9_-]+$/

/** The messages of a transcript, each with the one before it. */
interface Chain {
  size: number
  mtimeMs: number
  /** Where the first line not read yet starts. */
  read: number
  /** The bytes just before `read`, as they were read. */
  edge: Buffer
  parents: Map<string, string | null>
  /** The last message of the main thread. */
  tail: string | null
  /** When it was written, in ms; 0 when it does not say. */
  at: number
}

const chains = new Map<string, Chain>()

function take(chain: Chain, text: string): void {
  for (const line of text.split('\n')) {
    if (!line.includes('"uuid"')) continue
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof json !== 'object' || json === null) continue
    const record = json as Record<string, unknown>
    if (typeof record.uuid !== 'string' || record.uuid === '') continue
    // A compaction's boundary starts a new chain, which names the message it follows logically.
    const parent = record.parentUuid ?? record.logicalParentUuid
    chain.parents.set(record.uuid, typeof parent === 'string' && parent !== '' ? parent : null)
    if ((record.type === 'user' || record.type === 'assistant') && record.isSidechain !== true) {
      chain.tail = record.uuid
      const at = Date.parse(String(record.timestamp))
      if (Number.isFinite(at)) chain.at = at
    }
  }
}

/**
 * A transcript's chain, read again only past what was read before when the file just grew, since
 * Claude Code appends to it. Null for one too large or unreadable.
 */
async function chainOf(file: string): Promise<Chain | null> {
  let info
  try {
    info = await stat(file)
  } catch {
    chains.delete(file)
    return null
  }
  if (!info.isFile() || info.size > READ_LIMIT) return null
  const kept = chains.get(file)
  if (kept && kept.size === info.size && kept.mtimeMs === info.mtimeMs) return kept
  const handle = await open(file, 'r').catch(() => null)
  if (!handle) return null
  const readFrom = async (from: number): Promise<Buffer> => {
    const bytes = Buffer.alloc(info.size - from)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, from)
    return bytes.subarray(0, bytesRead)
  }
  try {
    let chain = kept && info.size >= kept.read ? kept : undefined
    let data: Buffer
    if (chain) {
      data = await readFrom(chain.read - chain.edge.length)
      if (data.subarray(0, chain.edge.length).equals(chain.edge)) {
        data = data.subarray(chain.edge.length)
      } else {
        // Rewritten rather than appended to: read whole again.
        chain = undefined
        data = await readFrom(0)
      }
    } else {
      data = await readFrom(0)
    }
    chain ??= {
      size: 0,
      mtimeMs: 0,
      read: 0,
      edge: Buffer.alloc(0),
      parents: new Map(),
      tail: null,
      at: 0,
    }
    const end = data.lastIndexOf(0x0a) + 1
    const consumed = data.subarray(0, end)
    take(chain, consumed.toString('utf8'))
    chain.read += end
    const joined = consumed.length >= EDGE ? consumed : Buffer.concat([chain.edge, consumed])
    chain.edge = Buffer.from(joined.subarray(Math.max(0, joined.length - EDGE)))
    chain.size = info.size
    chain.mtimeMs = info.mtimeMs
    chains.delete(file)
    chains.set(file, chain)
    if (chains.size > KEPT) chains.delete(chains.keys().next().value!)
    return chain
  } finally {
    await handle.close()
  }
}

function forget(file: string): string {
  chains.delete(file)
  return file
}

/** Whether a chain's last message comes after `uuid`, or is it. */
function reaches(chain: Chain, uuid: string): boolean {
  let at = chain.tail
  for (let steps = 0; at !== null && steps <= chain.parents.size; steps++) {
    if (at === uuid) return true
    at = chain.parents.get(at) ?? null
  }
  return false
}

async function isFile(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  )
}

async function isDirectory(folder: string): Promise<boolean> {
  return stat(folder).then(
    (info) => info.isDirectory(),
    () => false,
  )
}

const sameFile = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

/** Where a session's transcript sits in each project folder under `root` that has one. */
async function copiesOf(root: string, name: string): Promise<string[]> {
  const folders = await readdir(root, { withFileTypes: true }).catch(() => [])
  const found = await Promise.all(
    folders
      .filter((folder) => folder.isDirectory())
      .map(async (folder) => {
        const file = path.join(root, folder.name, name)
        return (await isFile(file)) ? file : null
      }),
  )
  return found.filter((file): file is string => file !== null)
}

export interface TranscriptCopies {
  /** The transcript in the project folder of the session's working folder, which a resume reads. */
  home: string
  /**
   * The transcript that carries the conversation furthest: `home`, or a copy in another folder that
   * holds all of it and more. Null when the session has none.
   */
  current: string | null
  /** `current` is such a copy in another folder, which a resume would miss. */
  moved: boolean
  /** Copies in other folders that went another way: neither holds the other's last message. */
  forks: string[]
}

/**
 * The copies of a session's transcript across every project folder under `root`, Claude Code's
 * `projects` folder. Without one in its own folder, which a setting can rename, the newest copy
 * stands for it.
 */
export async function claudeCopies(
  root: string,
  cwd: string,
  sessionId: string,
): Promise<TranscriptCopies | null> {
  if (!SESSION_ID.test(sessionId)) return null
  const name = `${sessionId}.jsonl`
  const real = await realpath(cwd).catch(() => cwd)
  const home = path.join(root, claudeProjectFolder(real.normalize('NFC')), name)
  const files = await copiesOf(root, name)
  const others = files.filter((file) => !sameFile(file, home))
  if (others.length === files.length) {
    if (files.length === 0) return { home, current: null, moved: false, forks: [] }
    const times = await Promise.all(
      files.map((file) =>
        stat(file).then(
          (info) => info.mtimeMs,
          () => 0,
        ),
      ),
    )
    const newest = files[times.indexOf(Math.max(...times))]!
    return { home, current: newest, moved: false, forks: [] }
  }
  const own = others.length === 0 ? null : await chainOf(home)
  if (!own) return { home, current: home, moved: false, forks: [] }
  let best: { file: string; at: number } | null = null
  const forks: string[] = []
  for (const file of others) {
    const chain = await chainOf(file)
    if (!chain?.tail || chain.tail === own.tail) continue
    if (own.tail === null || reaches(chain, own.tail)) {
      if (!best || chain.at > best.at) best = { file, at: chain.at }
    } else if (!reaches(own, chain.tail)) {
      forks.push(file)
    }
  }
  return best
    ? { home, current: best.file, moved: true, forks }
    : { home, current: home, moved: false, forks }
}

/**
 * How transcript `a` stands to `b`: the same conversation, `ahead` when it holds all of `b` and
 * more, `behind` when `b` holds all of it and more, or a `fork` when each has what the other has
 * not. Null when either is unreadable or too large to compare.
 */
export async function compareTranscripts(
  a: string,
  b: string,
): Promise<'same' | 'ahead' | 'behind' | 'fork' | null> {
  const first = await chainOf(a)
  const second = first && (await chainOf(b))
  if (!first || !second) return null
  if (first.tail === second.tail) return 'same'
  if (second.tail === null || reaches(first, second.tail)) return 'ahead'
  if (first.tail === null || reaches(second, first.tail)) return 'behind'
  return 'fork'
}

export type SyncResult = 'synced' | 'fork' | 'unchanged'

const syncing = new Map<string, Promise<SyncResult>>()

/**
 * Brings a copy in another folder that carries the session on into its own folder, so that a
 * resume continues from it: the session's transcript is kept beside it as
 * `<id>.jsonl.kite-bak-<time>` first, and the copy's subagents come along where they are missing.
 * A fork is left alone.
 */
export async function syncClaudeTranscript(
  root: string,
  cwd: string,
  sessionId: string,
  now: number = Date.now(),
): Promise<SyncResult> {
  const copies = await claudeCopies(root, cwd, sessionId)
  if (!copies?.current || !copies.moved) return copies?.forks.length ? 'fork' : 'unchanged'
  const { home, current } = copies
  const running = syncing.get(home)
  if (running) return running
  const run = (async (): Promise<SyncResult> => {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
    await copyFile(home, `${home}.kite-bak-${stamp}`, constants.COPYFILE_EXCL)
    try {
      await copyFile(current, home)
    } finally {
      forget(home)
    }
    const subagents = path.join(path.dirname(current), sessionId, 'subagents')
    if (await isDirectory(subagents)) {
      await cp(subagents, path.join(path.dirname(home), sessionId, 'subagents'), {
        recursive: true,
        force: false,
        errorOnExist: false,
      })
    }
    return 'synced'
  })().finally(() => syncing.delete(home))
  syncing.set(home, run)
  return run
}
