// Huli: what the daily backup keeps of the data folder, and what a restore puts back. Paths are
// relative to the data folder and `/`-separated, as the zip names them.
//
// Kept: the settings, the host's state (sessions, projects, agents, routines, workflows...), the
// thread and usage databases, memory, artifacts and the threads' media, attachments, themes and
// what the Marketplace installed. Left out:
// - `remote/`: this computer's keys, its sign-in to Kite Cloud and its paired devices. The system
//   encrypts them for this user on this computer, so a copy opens nowhere else, and on Linux
//   without a keyring they are plain text; a restore keeps the ones in place, so pairings and the
//   sign-in carry on.
// - `market-keys.json`, `published-artifacts.json` and `chat-bridge.json`: the Marketplace
//   servers' keys, the sharing token and the chat bots' credentials, encrypted the same way;
//   they are entered again after a loss.
// - `agent-network/`: the proxy subscriptions' addresses and nodes, which hold the provider's
//   tokens and passwords in plain text; the subscriptions are added again after a loss.
// - What is rebuilt or fetched again: the search index, thumbnails, the Marketplace's catalogs and
//   caches, logs, reports, scratch folders, and Chromium's own folders.

export type Part = 'file' | 'database' | 'content'

/** Files at the top of the data folder that are kept: main's settings and the user's choices. */
const TOP_FILES = new Set(['settings.json', 'theme-sources.json', 'editors.json'])

/** Folders at the top of the data folder that are kept, apart from what `skipped` leaves out. */
const TOP_FOLDERS = new Set([
  'state',
  'memory',
  'artifacts',
  'attachments',
  'themes',
  'workflows',
  'marketplace',
])

/** The SQLite databases, copied through SQLite rather than as files while they are open. */
export const DATABASES: readonly string[] = ['state/threads.db', 'state/usage.db']

/**
 * Folders of files named by their content, which the databases name. They are copied before the
 * databases and topped up after, so every file a database copy names is in the backup.
 */
export const CONTENT_FOLDERS: readonly string[] = ['state/thread-media', 'artifacts/content']

/** Files of `state/` left out: caches fetched again, a process's runtime records, secrets. */
const STATE_SKIPPED = new Set([
  'acp-registry.json',
  'agent-network.json',
  'agent-processes.json',
  'brought-sign-ins.json',
  'device-leases.json',
  'harness-manifest.json',
  'market-catalog.json',
  'market-plugins.json',
  'site-icons.json',
])

/** Folders under a kept one that are left out, as caches. */
const SKIPPED_FOLDERS: readonly string[] = [
  'artifacts/thumbnails',
  'artifacts/remote',
  'marketplace/catalog',
]

/** What the manifest says was left out, for whoever reads it. */
export const LEFT_OUT: readonly string[] = [
  'remote/: this computer’s keys, Kite Cloud sign-in and paired devices (kept in place on restore)',
  'market-keys.json, published-artifacts.json, chat-bridge.json: keys and tokens, encrypted for this computer',
  'agent-network/: proxy subscriptions, which carry their tokens in plain text',
  'state/search-*.db, artifacts/thumbnails/: rebuilt from the threads and artifacts',
  'caches, logs, reports, scratch folders and Chromium’s folders',
]

function under(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`)
}

/** A SQLite database's write-ahead log, shared memory or rollback journal. */
function isJournal(name: string): boolean {
  return /\.db-(?:wal|shm|journal)$/.test(name)
}

function isTemporary(name: string): boolean {
  return name.endsWith('.tmp') || name.endsWith('.partial') || /\.corrupt-/.test(name)
}

/** What the backup keeps a file at `path` as, or null when it leaves it out. */
export function partOf(path: string): Part | null {
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  const name = parts.at(-1)!
  if (parts.length === 1) return TOP_FILES.has(name) ? 'file' : null
  if (!TOP_FOLDERS.has(parts[0]!)) return null
  if (isJournal(name) || isTemporary(name)) return null
  if (SKIPPED_FOLDERS.some((folder) => under(path, folder))) return null
  if (DATABASES.includes(path)) return 'database'
  if (CONTENT_FOLDERS.some((folder) => under(path, folder))) return 'content'
  if (parts[0] === 'state') {
    if (parts.length === 2 && (STATE_SKIPPED.has(name) || /^search-.*\.db$/.test(name))) {
      return null
    }
    // Another database beside the threads', such as a newer search index, is left out rather
    // than copied as a file while open.
    if (parts.length === 2 && name.endsWith('.db')) return null
  }
  return 'file'
}

/** The folders a backup walks, at the top of the data folder. */
export function keptRoots(): { files: string[]; folders: string[] } {
  return { files: [...TOP_FILES], folders: [...TOP_FOLDERS] }
}

/**
 * Files a restore removes without a copy, since they belong to the data it replaces: the
 * databases' journals, which would be replayed into the restored databases, the search index,
 * which is rebuilt from the threads, and the artifacts' thumbnails.
 */
export function dropOnRestore(path: string): boolean {
  if (DATABASES.some((database) => path.startsWith(database) && isJournal(path))) return true
  if (/^state\/search-[^/]*$/.test(path)) return true
  return under(path, 'artifacts/thumbnails')
}

export interface RestorePlan {
  /** Files in place that the backup's parts cover: moved aside, then removed once it is in. */
  replace: string[]
  /** Files removed with no copy kept: see `dropOnRestore`. */
  drop: string[]
  /** The backup's files, put in place. */
  place: string[]
}

/**
 * What a restore does, from the files in the data folder now and the backup's. Everything the
 * backup's parts cover is replaced, so a session made since the backup goes with the rest of the
 * data it was made in; what the backup leaves out, `remote/` above all, stays as it is.
 * A backup path no part covers is refused, so a backup never writes outside what it may hold.
 */
export function restorePlan(current: readonly string[], backup: readonly string[]): RestorePlan {
  const refused = backup.find((path) => partOf(path) === null)
  if (refused !== undefined) throw new Error(`A backup may not hold ${refused}`)
  const replace: string[] = []
  const drop: string[] = []
  for (const path of current) {
    if (partOf(path) !== null) replace.push(path)
    else if (dropOnRestore(path)) drop.push(path)
  }
  return { replace, drop, place: [...backup] }
}
