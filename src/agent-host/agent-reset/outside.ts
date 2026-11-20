// Huli: Claude Code processes outside Kite that have a configuration folder open, which could
// write a reset's files back from what they hold in memory. Each running Claude Code keeps
// `<folder>/sessions/<pid>.json`; an SDK host's, such as Kite's own, is not counted.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** How many such processes run now. */
export async function outsideClaudeProcesses(
  folder: string,
  isOwn: (pid: number, entrypoint: string | null) => boolean,
  isAlive: (pid: number) => boolean = alive,
): Promise<number> {
  const sessions = path.join(folder, 'sessions')
  const names = await readdir(sessions).catch(() => [] as string[])
  const pids = new Set<number>()
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    let entry: unknown
    try {
      entry = JSON.parse(await readFile(path.join(sessions, name), 'utf8'))
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const { pid, entrypoint } = entry as { pid?: unknown; entrypoint?: unknown }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue
    const label = typeof entrypoint === 'string' && entrypoint !== '' ? entrypoint : null
    if (label?.startsWith('sdk') || isOwn(pid, label) || !isAlive(pid)) continue
    pids.add(pid)
  }
  return pids.size
}
