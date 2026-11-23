// Huli: what restoring a checkpoint does to a folder, worked out before anything is written, and
// then done. Only paths both snapshots know are touched: one either did not keep stays as it is.

import { randomUUID } from 'node:crypto'
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { diffCounts } from '../threads/digest'
import { checkedOutBlob, storedBlobs, treeOf, type RunGit, type TreeEntry } from './git'
import { fromKey, objectPath, type FileState, type Snapshot } from './snapshot'

/** One path's content as a snapshot has it, HEAD's blob for a clean path in a repository. */
type Side =
  | { k: 'absent' }
  | { k: 'unknown' }
  | Exclude<FileState, { k: 'd' }>
  | { k: 'b'; oid: string; mode: string; repo: string }

export interface PlannedChange {
  /** Relative to the folder, `/`-separated. */
  key: string
  /** What the restore does: puts back its content, removes it, or brings it back. */
  action: 'restore' | 'delete' | 'recreate'
  /** Lines the restore adds and removes; null when not counted, as for a large or binary file. */
  insertions: number | null
  deletions: number | null
  binary: boolean
}

export interface FolderPlan {
  changes: PlannedChange[]
  /** Paths that may differ but stay as they are, as one of the snapshots did not keep them. */
  kept: string[]
  /** The checkpoint's side of each change, to write. */
  sources: Map<string, Side>
}

const COUNT_BYTES = 2 * 1024 * 1024

interface Trees {
  checkpoint: Map<string, TreeEntry> | null
  now: Map<string, TreeEntry> | null
}

/** HEAD's blobs of both snapshots, by key; only those named in `keys` when HEAD is the same. */
async function treesOf(
  run: RunGit,
  checkpoint: Snapshot,
  now: Snapshot,
  keys: string[],
): Promise<Trees> {
  const read = async (
    snap: Snapshot,
    only: string[] | null,
  ): Promise<Map<string, TreeEntry> | null> => {
    const git = snap.git
    if (!git?.head) return null
    const paths = only?.map((key) => `${git.prefix}${key}`)
    const tree = await treeOf(run, git.top, git.head, git.prefix, paths)
    if (!tree) throw new Error(`Could not read ${git.head} in ${git.top}`)
    const out = new Map<string, TreeEntry>()
    for (const [repoPath, entry] of tree) {
      if (git.prefix && !repoPath.startsWith(git.prefix)) continue
      out.set(repoPath.slice(git.prefix.length), entry)
    }
    return out
  }
  const same =
    !!checkpoint.git?.head &&
    checkpoint.git.head === now.git?.head &&
    checkpoint.git.top === now.git.top &&
    checkpoint.git.prefix === now.git.prefix
  if (same) {
    const tree = await read(now, keys.length <= 200 ? keys : null)
    return { checkpoint: tree, now: tree }
  }
  return { checkpoint: await read(checkpoint, null), now: await read(now, null) }
}

function sideOf(
  snap: Snapshot,
  tree: Map<string, TreeEntry> | null,
  key: string,
  skipped: Set<string>,
): Side {
  const file = snap.files[key]
  if (file) return file.k === 'd' ? { k: 'absent' } : file
  if (skipped.has(key)) return { k: 'unknown' }
  const entry = tree?.get(key)
  if (entry) {
    // A submodule is another repository's to keep.
    if (entry.mode === '160000') return { k: 'unknown' }
    return { k: 'b', oid: entry.oid, mode: entry.mode, repo: `${snap.git!.prefix}${key}` }
  }
  return snap.partial ? { k: 'unknown' } : { k: 'absent' }
}

function sameSide(a: Side, b: Side): boolean | null {
  if (a.k === 'absent' && b.k === 'absent') return true
  if (a.k === 'f' && b.k === 'f') return a.h === b.h && !!a.x === !!b.x
  if (a.k === 'b' && b.k === 'b') return a.oid === b.oid && a.mode === b.mode
  if (a.k === 'l' && b.k === 'l') return a.t === b.t
  if (a.k === 'absent' || b.k === 'absent') return false
  // A copy and a blob, or a blob and a link: only their bytes tell.
  return null
}

type Content = { kind: 'file'; data: Buffer; exec: boolean } | { kind: 'link'; target: string }

function same(a: Content, b: Content): boolean {
  if (a.kind === 'link' || b.kind === 'link') {
    return a.kind === 'link' && b.kind === 'link' && a.target === b.target
  }
  return a.exec === b.exec && a.data.equals(b.data)
}

function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8000).includes(0)
}

function lines(content: Content): string {
  return content.kind === 'link' ? `${content.target}\n` : content.data.toString('utf8')
}

/** HEAD's blobs as stored, and a way to one as the user's checkout writes it. */
interface Blobs {
  stored: Map<string, Buffer>
  checkout: (oid: string, repoPath: string) => Promise<Buffer | null>
}

const LFS_POINTER = Buffer.from('version https://git-lfs.github.com/spec/v1')

/**
 * The bytes a clean file of HEAD had. Git counts a file clean whose line endings its checkout
 * would change, as one a tool wrote with LF where `core.autocrlf` checks out CRLF, so the file as
 * it is now tells its line endings; a file gone, or one Git LFS keeps, is as the checkout writes it.
 */
async function cleanBytes(
  blobs: Blobs,
  side: { oid: string; repo: string },
  now: Buffer | null,
): Promise<Buffer | null> {
  const stored = blobs.stored.get(side.repo)
  if (!stored) return null
  if (now === null || stored.subarray(0, LFS_POINTER.length).equals(LFS_POINTER)) {
    return (await blobs.checkout(side.oid, side.repo)) ?? stored
  }
  if (!stored.includes(0x0d) && now.includes('\r\n')) {
    return Buffer.from(stored.toString('latin1').replace(/\n/g, '\r\n'), 'latin1')
  }
  return stored
}

/** The bytes of the checkpoint's side; null when the store or the repository no longer has them. */
async function contentOf(
  objects: string,
  side: Side,
  blobs: Blobs,
  now: Buffer | null,
): Promise<Content | null> {
  if (side.k === 'f') {
    try {
      return { kind: 'file', data: await readFile(objectPath(objects, side.h)), exec: !!side.x }
    } catch {
      return null
    }
  }
  if (side.k === 'l') return { kind: 'link', target: side.t }
  if (side.k === 'b') {
    if (side.mode === '120000') {
      const target = blobs.stored.get(side.repo)
      return target ? { kind: 'link', target: target.toString('utf8') } : null
    }
    const data = await cleanBytes(blobs, side, now)
    return data ? { kind: 'file', data, exec: side.mode === '100755' } : null
  }
  return null
}

/** What is on disk at `abs` now; null when nothing is. */
async function onDisk(abs: string): Promise<Content | 'other' | null> {
  let info
  try {
    info = await lstat(abs)
  } catch {
    return null
  }
  if (info.isSymbolicLink()) return { kind: 'link', target: await readlink(abs) }
  if (!info.isFile()) return 'other'
  return {
    kind: 'file',
    data: await readFile(abs),
    exec: process.platform !== 'win32' && (info.mode & 0o111) !== 0,
  }
}

/**
 * Works out what restoring `checkpoint` over the folder as `now` found it would change, with the
 * lines of each change. `now` must have just been taken: the files on disk are read as its.
 */
export async function planRestore(
  run: RunGit,
  objects: string,
  folder: string,
  checkpoint: Snapshot,
  now: Snapshot,
): Promise<FolderPlan> {
  const skippedC = new Set(checkpoint.skipped)
  const skippedN = new Set(now.skipped)
  const named = new Set([
    ...Object.keys(checkpoint.files),
    ...Object.keys(now.files),
    ...checkpoint.skipped,
    ...now.skipped,
  ])
  const trees = await treesOf(run, checkpoint, now, [...named])
  if (trees.checkpoint !== trees.now) {
    for (const key of new Set([
      ...(trees.checkpoint?.keys() ?? []),
      ...(trees.now?.keys() ?? []),
    ])) {
      const a = trees.checkpoint?.get(key)
      const b = trees.now?.get(key)
      if (a?.oid !== b?.oid || a?.mode !== b?.mode) named.add(key)
    }
  }
  // Outside a repository, or before its first commit, a snapshot names every file it kept, so a
  // file only one names is new or gone.
  const kept: string[] = []
  const candidates: { key: string; from: Side; to: Side }[] = []
  for (const key of [...named].sort()) {
    const from = sideOf(checkpoint, trees.checkpoint, key, skippedC)
    const to = sideOf(now, trees.now, key, skippedN)
    if (from.k === 'unknown' || to.k === 'unknown') {
      if (skippedC.has(key) || skippedN.has(key)) kept.push(key)
      continue
    }
    if (sameSide(from, to) === true) continue
    candidates.push({ key, from, to })
  }
  const blobs = await blobsOf(
    run,
    checkpoint,
    candidates.map((item) => item.from),
  )
  const changes: PlannedChange[] = []
  const sources = new Map<string, Side>()
  for (const { key, from, to } of candidates) {
    const abs = fromKey(folder, key)
    if (abs === null) continue
    const have = await onDisk(abs)
    // Something the snapshot of now did not keep, such as an ignored file, is never overwritten.
    if (have === 'other' || (to.k === 'absent' && have !== null)) {
      kept.push(key)
      continue
    }
    const want =
      from.k === 'absent'
        ? null
        : await contentOf(objects, from, blobs, have?.kind === 'file' ? have.data : null)
    if (from.k !== 'absent' && want === null) {
      // The checkpoint's copy or HEAD's blob is gone: nothing to put back.
      kept.push(key)
      continue
    }
    if (want === null && have === null) continue
    if (want !== null && have !== null && same(want, have)) continue
    let insertions: number | null = null
    let deletions: number | null = null
    let binary = false
    const wantData = want?.kind === 'file' ? want.data : null
    const haveData = have?.kind === 'file' ? have.data : null
    if ((wantData && isBinary(wantData)) || (haveData && isBinary(haveData))) {
      binary = true
    } else if ((wantData?.length ?? 0) <= COUNT_BYTES && (haveData?.length ?? 0) <= COUNT_BYTES) {
      const counted = diffCounts(
        have === null ? null : lines(have),
        want === null ? '' : lines(want),
      )
      insertions = counted.added
      deletions = counted.removed
    }
    changes.push({
      key,
      action: want === null ? 'delete' : have === null ? 'recreate' : 'restore',
      insertions,
      deletions,
      binary,
    })
    sources.set(key, from)
  }
  return { changes, kept: [...new Set(kept)].sort(), sources }
}

/** HEAD's blobs a set of sides needs, by repository path. */
async function blobsOf(run: RunGit, snap: Snapshot, sides: Side[]): Promise<Blobs> {
  const wanted = sides.flatMap((side) =>
    side.k === 'b' ? [{ oid: side.oid, path: side.repo }] : [],
  )
  const git = snap.git
  if (wanted.length === 0 || !git) return { stored: new Map(), checkout: async () => null }
  return {
    stored: (await storedBlobs(run, git.top, wanted)) ?? new Map(),
    checkout: (oid, repoPath) => checkedOutBlob(run, git.top, oid, repoPath),
  }
}

export interface Applied {
  done: string[]
  failed: { key: string; reason: string }[]
}

/**
 * Restores the planned changes: removals first, then each file written beside itself and renamed
 * into place, so none is left half written. A path whose folders on the way are a file or a link,
 * or where something stands that the plan did not count on, is left as it is.
 */
export async function applyPlan(
  run: RunGit,
  objects: string,
  folder: string,
  checkpoint: Snapshot,
  plan: FolderPlan,
): Promise<Applied> {
  const done: string[] = []
  const failed: Applied['failed'] = []
  const emptied = new Set<string>()
  for (const change of plan.changes) {
    if (change.action !== 'delete') continue
    const abs = fromKey(folder, change.key)!
    try {
      const info = await lstat(abs)
      if (info.isDirectory()) throw new Error('a folder stands there')
      await rm(abs, { force: true })
      done.push(change.key)
      emptied.add(path.dirname(abs))
    } catch (error) {
      failed.push({ key: change.key, reason: (error as Error).message })
    }
  }
  const writes = plan.changes.filter((change) => change.action !== 'delete')
  const blobs = await blobsOf(
    run,
    checkpoint,
    writes.map((change) => plan.sources.get(change.key)!),
  )
  for (const change of writes) {
    const abs = fromKey(folder, change.key)!
    try {
      const now = await readFile(abs).catch(() => null)
      const content = await contentOf(objects, plan.sources.get(change.key)!, blobs, now)
      if (!content) throw new Error('its saved copy is gone')
      await clearWay(folder, abs)
      const present = await lstat(abs).then(
        (info) => info,
        () => null,
      )
      if (change.action === 'recreate' && present) throw new Error('a file not saved stands there')
      if (present?.isDirectory()) throw new Error('a folder stands there')
      await put(abs, content, objects, plan.sources.get(change.key)!)
      done.push(change.key)
    } catch (error) {
      failed.push({ key: change.key, reason: (error as Error).message })
    }
  }
  await pruneEmpty(folder, emptied)
  return { done, failed }
}

/** Makes the folders on the way to `abs`, refusing one that is a file or a link. */
async function clearWay(folder: string, abs: string): Promise<void> {
  const parts = path.relative(folder, path.dirname(abs)).split(path.sep).filter(Boolean)
  let at = folder
  for (const part of parts) {
    at = path.join(at, part)
    let info
    try {
      info = await lstat(at)
    } catch {
      await mkdir(at)
      continue
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${part} is in the way`)
  }
}

async function put(abs: string, content: Content, objects: string, side: Side): Promise<void> {
  const temp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.kite-${randomUUID().slice(0, 8)}`,
  )
  if (content.kind === 'link') {
    await rm(abs, { force: true })
    try {
      await symlink(content.target, abs)
    } catch {
      // Windows without the right to make links checks them out as files of their target, as git does.
      await writeFile(abs, content.target)
    }
    return
  }
  try {
    if (side.k === 'f') await copyFile(objectPath(objects, side.h), temp)
    else await writeFile(temp, content.data)
    if (process.platform !== 'win32') await chmod(temp, content.exec ? 0o755 : 0o644)
    await rename(temp, abs)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Removes the folders the removals left empty, up to the session's folder. */
async function pruneEmpty(folder: string, dirs: Set<string>): Promise<void> {
  const ordered = [...dirs].sort((a, b) => b.length - a.length)
  for (const start of ordered) {
    let dir = start
    while (dir.length > folder.length && dir.startsWith(folder)) {
      try {
        await rmdir(dir)
      } catch {
        break
      }
      dir = path.dirname(dir)
    }
  }
}
