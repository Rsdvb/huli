// A fake disk of any platform for the removal planners' tests: files, folders and links by path,
// with every folder above an entry there too.

import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { FileKind, RemovalFiles } from '../agent-removal/steps'

export interface FakeEntry {
  kind: FileKind
  /** A link's target, absolute or from the link's folder. */
  target?: string
  text?: string
}

export function fakeRemovalFiles(
  platform: Platform,
  entries: Record<string, FakeEntry>,
): RemovalFiles {
  const p = platform === 'win32' ? path.win32 : path.posix
  const key = (target: string): string =>
    platform === 'win32' ? p.resolve(target).toLowerCase() : p.resolve(target)
  const all = new Map<string, { at: string; entry: FakeEntry }>()
  for (const [at, entry] of Object.entries(entries)) {
    all.set(key(at), { at: p.resolve(at), entry })
    for (let dir = p.dirname(at); dir !== p.dirname(dir); dir = p.dirname(dir)) {
      if (!all.has(key(dir))) all.set(key(dir), { at: p.resolve(dir), entry: { kind: 'folder' } })
    }
  }
  return {
    kind: async (target) => all.get(key(target))?.entry.kind ?? null,
    realpath: async (target) => {
      let at = p.resolve(target)
      for (let hops = 0; hops < 16; hops++) {
        const found = all.get(key(at))
        if (!found) throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
        if (found.entry.kind !== 'link' || !found.entry.target) return found.at
        at = p.resolve(p.dirname(at), found.entry.target)
      }
      throw new Error(`Too many links: ${target}`)
    },
    list: async (folder) =>
      [...all.values()]
        .filter(({ at }) => key(p.dirname(at)) === key(folder) && key(at) !== key(folder))
        .map(({ at }) => p.basename(at)),
    readText: async (file) => {
      const found = all.get(key(file))
      if (found?.entry.kind !== 'file') throw new Error(`ENOENT: ${file}`)
      return found.entry.text ?? ''
    },
  }
}
