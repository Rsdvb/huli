// Huli: the check every path a removal plans, and runs, must pass: inside the agent's own folders,
// never a drive's root, the home folder or a folder above what must stay (Kite's data, the
// harnesses, the system's folders), and never another agent's folder or one that holds it. A path
// inside another agent's folder may go: agy keeps its own folder inside Gemini CLI's ~/.gemini.

import path from 'node:path'
import type { Platform } from '@shared/platform'

export interface RemovalGuard {
  platform: Platform
  /** The folders a removal may reach into: the agent's own, and its program's. */
  roots: readonly string[]
  /** What must stay with everything in it; nothing at or above one may go. */
  protect: readonly string[]
  /** Other agents' folders: nothing at or above one may go. */
  others: readonly string[]
}

function pathsOf(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** The path as compared: resolved, without a trailing separator, lowercase on Windows. */
export function comparable(target: string, platform: Platform): string {
  const p = pathsOf(platform)
  const resolved = p.resolve(target)
  const trimmed =
    resolved.length > p.parse(resolved).root.length ? resolved.replace(/[\\/]+$/, '') : resolved
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** Whether `child` is `parent` or lies inside it. */
export function within(parent: string, child: string, platform: Platform): boolean {
  const p = pathsOf(platform)
  const rel = p.relative(comparable(parent, platform), comparable(child, platform))
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel))
}

/** Why the removal may not take `target`, or null when it may. */
export function removalRefusal(target: string, guard: RemovalGuard): string | null {
  const { platform } = guard
  const p = pathsOf(platform)
  if (!p.isAbsolute(target)) return 'not an absolute path'
  if (/[\0\r\n]/.test(target)) return 'not a plain path'
  const at = comparable(target, platform)
  if (at === comparable(p.parse(at).root, platform)) return 'a drive’s root'
  for (const kept of guard.protect) {
    if (within(target, kept, platform)) return 'a folder that holds what must stay'
  }
  for (const other of guard.others) {
    if (within(target, other, platform)) return 'another agent’s folder'
  }
  if (!guard.roots.some((root) => within(root, target, platform))) {
    return 'outside the agent’s folders'
  }
  return null
}
