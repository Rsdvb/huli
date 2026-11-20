// Huli: the names of the backup files, by the local time each was made, and which ones go once
// the folder holds more than the setting keeps.

/** A daily or manual backup, which the setting's count prunes. */
export const BACKUP_PREFIX = 'Kite-backup-'
/** The copy a restore makes of the data it replaces, which pruning never removes. */
export const SAFETY_PREFIX = 'Kite-before-restore-'
export const BACKUP_EXTENSION = '.zip'
/** The name a backup is written under until it is whole. */
export const PARTIAL_SUFFIX = '.partial'

const STAMP = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?$/

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** `Kite-backup-2026-11-20-030012.zip`, in local time; `taken` names that come first. */
export function backupName(
  at: Date,
  prefix: string = BACKUP_PREFIX,
  taken: ReadonlySet<string> = new Set(),
): string {
  const stamp =
    `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  let name = `${prefix}${stamp}${BACKUP_EXTENSION}`
  for (let n = 2; taken.has(name); n++) name = `${prefix}${stamp}-${n}${BACKUP_EXTENSION}`
  return name
}

/** The sortable stamp of a backup's name with this prefix, or null for any other file. */
export function backupStamp(name: string, prefix: string = BACKUP_PREFIX): string | null {
  if (!name.startsWith(prefix) || !name.endsWith(BACKUP_EXTENSION)) return null
  const stamp = name.slice(prefix.length, -BACKUP_EXTENSION.length)
  const match = STAMP.exec(stamp)
  if (!match) return null
  // The counter after a same-second name sorts after it.
  return `${match.slice(1, 7).join('')}${(match[7] ?? '1').padStart(4, '0')}`
}

/**
 * The daily backups to remove so `keep` remain, oldest first. Only names this app gives its daily
 * and manual backups count: a restore's safety copy or any other file in the folder stays.
 */
export function toPrune(names: readonly string[], keep: number): string[] {
  const backups = names
    .map((name) => ({ name, stamp: backupStamp(name) }))
    .filter((item): item is { name: string; stamp: string } => item.stamp !== null)
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0))
  return backups
    .slice(Math.max(keep, 1))
    .map((item) => item.name)
    .reverse()
}

/** A backup left half-written by a run that stopped, which the next run removes. */
export function isPartial(name: string): boolean {
  return (
    (name.startsWith(BACKUP_PREFIX) || name.startsWith(SAFETY_PREFIX)) &&
    name.endsWith(`${BACKUP_EXTENSION}${PARTIAL_SUFFIX}`)
  )
}
