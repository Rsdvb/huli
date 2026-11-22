// Huli: Kite's own file checkpoints, for agents that keep none: each session folder's files as
// they were when each of the user's messages went, so a rewind can put them back. They live in
// Kite's data folder, never in the user's repository: a store per folder holds the copies, named
// by their SHA-256, and a small JSON snapshot per message. Taken only as a turn starts; trimmed
// and swept as checkpoints are taken and sessions deleted, never on a timer.

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { pathKey } from '../paths'
import type { RunGit } from './git'
import { applyPlan, planRestore, type FolderPlan, type PlannedChange } from './plan'
import { capture, LIMITS, objectPath, type CopyCache, type Snapshot } from './snapshot'

export const KEEP = {
  /** Checkpoints of one session kept per folder, the newest first. */
  perSession: 100,
  /** Copies of the files as a restore found them, kept per session and folder. */
  backups: 5,
  /** A checkpoint older than this goes. */
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  /** Past this the oldest checkpoints of the folder go, a quarter at a time. */
  storeBytes: 2 * 1024 * 1024 * 1024,
  /** A sweep runs at most this often per folder, unless a session was deleted. */
  sweepEveryMs: 10 * 60 * 1000,
}

export interface FileCheckpointsDeps {
  /** The folder of every store, in Kite's data folder. */
  root: string
  run: RunGit
  platform: Platform
  log: (level: 'info' | 'warn', message: string) => void
  now?: () => number
  limits?: typeof LIMITS
  keep?: typeof KEEP
}

export interface FolderChanges {
  folder: string
  changes: PlannedChange[]
  /** Paths that may differ but stay as they are, as one of the snapshots did not keep them. */
  kept: string[]
  /** No checkpoint of this folder for the message, so it stays as it is. */
  missing?: true
}

export interface FilesPreview {
  folders: FolderChanges[]
  /** Names the folders as the preview found them; a restore checks they are still so. */
  token: string
}

export interface FilesRestored {
  restored: number
  failed: { folder: string; key: string; reason: string }[]
  /** The snapshot of the files as they were before, to undo the restore with. */
  backup: string
}

/** A restore that would not write what its preview showed: the files changed since. */
export class ChangedSincePreview extends Error {
  constructor() {
    super('The files changed since the preview')
  }
}

interface Store {
  dir: string
  folder: string
  /** Captures copying into the store, which a sweep waits for. */
  active: number
  sweeping: Promise<void> | null
  lastSweep: number
  expired: boolean
  cache: CopyCache
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** A snapshot's file name for a message, or a backup's own name. */
function snapshotName(point: { entryId: string } | { backup: string }): string {
  if ('backup' in point) {
    if (!/^b-\d{1,16}$/.test(point.backup)) throw new Error('Not a backup')
    return point.backup
  }
  return `e-${Buffer.from(point.entryId, 'utf8').toString('hex')}`
}

function sessionDir(store: Store, sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error('Not a session id')
  return path.join(store.dir, 'snapshots', sessionId)
}

export class FileCheckpoints {
  private readonly stores = new Map<string, Store>()
  private readonly folders = new Map<string, string>()
  private readonly pending = new Map<string, Promise<Snapshot | null>>()

  private readonly limits: typeof LIMITS
  private readonly keep: typeof KEEP

  constructor(private readonly deps: FileCheckpointsDeps) {
    this.limits = deps.limits ?? LIMITS
    this.keep = deps.keep ?? KEEP
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async store(folder: string): Promise<Store> {
    let key = this.folders.get(folder)
    if (key === undefined) {
      let real = folder
      try {
        real = await realpath(folder)
      } catch {
        // A folder that is gone keeps its own name.
      }
      key = createHash('sha256')
        .update(pathKey(real, this.deps.platform))
        .digest('hex')
        .slice(0, 24)
      this.folders.set(folder, key)
    }
    let store = this.stores.get(key)
    if (!store) {
      store = {
        dir: path.join(this.deps.root, key),
        folder,
        active: 0,
        sweeping: null,
        lastSweep: 0,
        expired: false,
        cache: new Map(),
      }
      this.stores.set(key, store)
      await mkdir(path.join(store.dir, 'objects'), { recursive: true })
      await writeFile(path.join(store.dir, 'folder.json'), JSON.stringify({ folder }))
    }
    return store
  }

  /**
   * Takes the checkpoint of the session's folders for the message `entryId`, unless one is kept
   * already. Settles once the folders are listed, which the turn waits for; `cancel` drops a
   * checkpoint whose turn did not wait.
   */
  begin(
    sessionId: string,
    entryId: string,
    folders: readonly string[],
  ): { listed: Promise<void>; cancel: () => void } {
    let cancelled = false
    const listings: Promise<unknown>[] = []
    for (const folder of folders) {
      const job = (async () => {
        const store = await this.store(folder)
        const file = path.join(sessionDir(store, sessionId), `${snapshotName({ entryId })}.json`)
        const pendingKey = `${store.dir}\0${file}`
        if (this.pending.has(pendingKey) || (await exists(file))) return
        if (store.sweeping) await store.sweeping
        store.active++
        const taking = capture({
          run: this.deps.run,
          folder,
          objects: path.join(store.dir, 'objects'),
          temp: path.join(store.dir, 'tmp'),
          cache: store.cache,
          now: () => this.now(),
          limits: this.limits,
        })
        const saved = taking.done
          .then(async (snapshot) => {
            if (cancelled) return null
            await writeJson(file, snapshot)
            return snapshot
          })
          .catch((error: unknown) => {
            this.deps.log(
              'warn',
              `File checkpoint of ${folder} failed: ${(error as Error).message}`,
            )
            return null
          })
          .finally(() => {
            store.active--
            this.pending.delete(pendingKey)
            void this.afterCheckpoint(store, sessionId)
          })
        this.pending.set(pendingKey, saved)
        await taking.listed
      })()
      listings.push(job.catch(() => {}))
    }
    return {
      listed: Promise.all(listings).then(() => {}),
      cancel: () => {
        cancelled = true
      },
    }
  }

  /** The checkpoint of a folder for the message, once its copying is done; null when none. */
  private async load(
    store: Store,
    sessionId: string,
    point: { entryId: string } | { backup: string },
  ): Promise<Snapshot | null> {
    const file = path.join(sessionDir(store, sessionId), `${snapshotName(point)}.json`)
    const pending = this.pending.get(`${store.dir}\0${file}`)
    if (pending) await pending
    try {
      const snapshot = JSON.parse(await readFile(file, 'utf8')) as Snapshot
      return snapshot.v === 1 ? snapshot : null
    } catch {
      return null
    }
  }

  /** Whether any of the folders has a checkpoint for the message. */
  async has(sessionId: string, entryId: string, folders: readonly string[]): Promise<boolean> {
    for (const folder of folders) {
      const store = await this.store(folder)
      if (await this.load(store, sessionId, { entryId })) return true
    }
    return false
  }

  /** The folders as they are now, copied as a checkpoint would, within one operation. */
  private async snapshotNow(store: Store): Promise<Snapshot> {
    if (store.sweeping) await store.sweeping
    store.active++
    try {
      return await capture({
        run: this.deps.run,
        folder: store.folder,
        objects: path.join(store.dir, 'objects'),
        temp: path.join(store.dir, 'tmp'),
        cache: store.cache,
        now: () => this.now(),
        limits: this.limits,
      }).done
    } finally {
      store.active--
    }
  }

  private async plans(
    sessionId: string,
    point: { entryId: string } | { backup: string },
    folders: readonly string[],
  ): Promise<
    { store: Store; checkpoint: Snapshot | null; now: Snapshot; plan: FolderPlan | null }[]
  > {
    const out = []
    for (const folder of folders) {
      const store = await this.store(folder)
      const checkpoint = await this.load(store, sessionId, point)
      const now = await this.snapshotNow(store)
      const plan = checkpoint
        ? await planRestore(this.deps.run, path.join(store.dir, 'objects'), folder, checkpoint, now)
        : null
      out.push({ store, checkpoint, now, plan })
    }
    return out
  }

  /** What restoring the folders to the message's checkpoint would change. */
  async preview(
    sessionId: string,
    point: { entryId: string } | { backup: string },
    folders: readonly string[],
  ): Promise<FilesPreview | null> {
    const plans = await this.plans(sessionId, point, folders)
    if (plans.every((item) => item.checkpoint === null)) return null
    return {
      folders: plans.map(({ store, plan }) =>
        plan
          ? { folder: store.folder, changes: plan.changes, kept: plan.kept }
          : { folder: store.folder, changes: [], kept: [], missing: true as const },
      ),
      token: tokenOf(plans.map((item) => item.now)),
    }
  }

  /**
   * Restores the folders to the message's checkpoint, if they are still as the preview `token`
   * found them; the files as they were go first into a backup the restore can be undone from.
   */
  async restore(
    sessionId: string,
    point: { entryId: string } | { backup: string },
    folders: readonly string[],
    token: string,
  ): Promise<FilesRestored> {
    const plans = await this.plans(sessionId, point, folders)
    if (plans.every((item) => item.checkpoint === null)) throw new Error('No checkpoint')
    if (tokenOf(plans.map((item) => item.now)) !== token) throw new ChangedSincePreview()
    const backup = `b-${this.now()}`
    for (const { store, now } of plans) {
      await writeJson(path.join(sessionDir(store, sessionId), `${backup}.json`), now)
    }
    let restored = 0
    const failed: FilesRestored['failed'] = []
    for (const { store, checkpoint, plan } of plans) {
      if (!checkpoint || !plan || plan.changes.length === 0) continue
      const applied = await applyPlan(
        this.deps.run,
        path.join(store.dir, 'objects'),
        store.folder,
        checkpoint,
        plan,
      )
      restored += applied.done.length
      for (const item of applied.failed) failed.push({ folder: store.folder, ...item })
      void this.afterCheckpoint(store, sessionId)
    }
    return { restored, failed, backup }
  }

  /** Drops the checkpoints of messages a rewind took out of the session. */
  async drop(
    sessionId: string,
    entryIds: readonly string[],
    folders: readonly string[],
  ): Promise<void> {
    for (const folder of folders) {
      const store = await this.store(folder)
      const dir = sessionDir(store, sessionId)
      for (const entryId of entryIds) {
        await rm(path.join(dir, `${snapshotName({ entryId })}.json`), { force: true })
      }
    }
  }

  /** Drops every checkpoint of a deleted session, in every folder, and sweeps those folders. */
  async forget(sessionId: string): Promise<void> {
    if (!SAFE_ID.test(sessionId)) return
    let keys: string[]
    try {
      keys = await readdir(this.deps.root)
    } catch {
      return
    }
    for (const key of keys) {
      if (!/^[0-9a-f]{24}$/.test(key)) continue
      const dir = path.join(this.deps.root, key, 'snapshots', sessionId)
      if (!(await exists(dir))) continue
      await rm(dir, { recursive: true, force: true })
      const store = this.stores.get(key)
      if (store) await this.sweep(store, true)
      else await this.sweepDir(path.join(this.deps.root, key))
    }
  }

  private async afterCheckpoint(store: Store, sessionId: string): Promise<void> {
    try {
      let removed = await this.trim(store, sessionId)
      if (!store.expired) {
        store.expired = true
        removed = (await this.expire(store)) || removed
      }
      if (removed) await this.sweep(store, false)
    } catch (error) {
      this.deps.log('warn', `File checkpoints of ${store.folder}: ${(error as Error).message}`)
    }
  }

  /** Keeps the newest checkpoints and backups of the session in the store. */
  private async trim(store: Store, sessionId: string): Promise<boolean> {
    const dir = sessionDir(store, sessionId)
    const files = await listed(dir)
    let removed = false
    for (const [prefix, most] of [
      ['e-', this.keep.perSession],
      ['b-', this.keep.backups],
    ] as const) {
      const mine = files.filter((file) => file.name.startsWith(prefix))
      mine.sort((a, b) => b.mtimeMs - a.mtimeMs)
      for (const file of mine.slice(most)) {
        await rm(path.join(dir, file.name), { force: true })
        removed = true
      }
    }
    return removed
  }

  /** Drops checkpoints past their age; a folder left without any loses its store. */
  private async expire(store: Store): Promise<boolean> {
    const root = path.join(store.dir, 'snapshots')
    const cutoff = this.now() - this.keep.maxAgeMs
    let removed = false
    for (const session of await names(root)) {
      const dir = path.join(root, session)
      const files = await listed(dir)
      for (const file of files) {
        if (file.mtimeMs >= cutoff) continue
        await rm(path.join(dir, file.name), { force: true })
        removed = true
      }
      if ((await names(dir)).length === 0) await rm(dir, { recursive: true, force: true })
    }
    return removed
  }

  /**
   * Removes the copies no checkpoint names, once no capture copies into the store; past the
   * store's size the oldest checkpoints go first.
   */
  private async sweep(store: Store, force: boolean): Promise<void> {
    if (store.sweeping) return store.sweeping
    if (!force && this.now() - store.lastSweep < this.keep.sweepEveryMs) return
    if (store.active > 0) return
    store.sweeping = (async () => {
      try {
        await this.sweepDir(store.dir)
      } finally {
        store.lastSweep = this.now()
        store.sweeping = null
      }
    })()
    return store.sweeping
  }

  private async sweepDir(dir: string): Promise<void> {
    for (let pass = 0; pass < 2; pass++) {
      const snapshots = await allSnapshots(dir)
      if (snapshots.length === 0) {
        // Nothing to restore from: the folder's store goes whole.
        await rm(dir, { recursive: true, force: true })
        for (const [key, store] of this.stores) if (store.dir === dir) this.stores.delete(key)
        return
      }
      const named = new Set<string>()
      for (const { snapshot } of snapshots) {
        for (const file of Object.values(snapshot.files)) if (file.k === 'f') named.add(file.h)
      }
      const objects = path.join(dir, 'objects')
      let bytes = 0
      for (const prefix of await names(objects)) {
        for (const file of await listed(path.join(objects, prefix))) {
          const h = `${prefix}${file.name}`
          if (named.has(h)) bytes += file.size
          else await rm(objectPath(objects, h), { force: true })
        }
      }
      await rm(path.join(dir, 'tmp'), { recursive: true, force: true })
      if (bytes <= this.keep.storeBytes) return
      snapshots.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const item of snapshots.slice(0, Math.max(1, Math.floor(snapshots.length / 4)))) {
        await rm(item.file, { force: true })
      }
    }
  }
}

/** One token for the folders as a set of snapshots found them, their times aside. */
function tokenOf(snapshots: readonly Snapshot[]): string {
  const hash = createHash('sha256')
  for (const snapshot of snapshots) {
    hash.update(
      JSON.stringify({
        git: snapshot.git,
        files: snapshot.files,
        skipped: snapshot.skipped,
        partial: snapshot.partial,
      }),
    )
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value))
  await rename(temp, file)
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function listed(dir: string): Promise<{ name: string; mtimeMs: number; size: number }[]> {
  const out = []
  for (const name of await names(dir)) {
    try {
      const info = await stat(path.join(dir, name))
      if (info.isFile()) out.push({ name, mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      // Gone meanwhile.
    }
  }
  return out
}

async function allSnapshots(
  dir: string,
): Promise<{ file: string; mtimeMs: number; snapshot: Snapshot }[]> {
  const root = path.join(dir, 'snapshots')
  const out = []
  for (const session of await names(root)) {
    for (const file of await listed(path.join(root, session))) {
      if (!file.name.endsWith('.json')) continue
      const full = path.join(root, session, file.name)
      try {
        const snapshot = JSON.parse(await readFile(full, 'utf8')) as Snapshot
        out.push({ file: full, mtimeMs: file.mtimeMs, snapshot })
      } catch {
        await rm(full, { force: true })
      }
    }
  }
  return out
}
