// Huli: a host's paths as Settings' agent dialogs list them, shortened under the agent's folder or
// the host's home folder.

/** Where the host's paths are shortened: the agent's folder, then the home folder as `~`. */
export interface Places {
  folder: string | null
  home: string | null
}

function under(target: string, base: string): string | null {
  for (const sep of ['/', '\\']) {
    const prefix = base.endsWith(sep) ? base : base + sep
    if (target.startsWith(prefix)) return target.slice(prefix.length)
  }
  return null
}

/** The path as the list shows it: from the agent's folder inside it, else from `~`. */
export function shortPath(target: string, places: Places): string {
  const inFolder = places.folder ? under(target, places.folder) : null
  if (inFolder !== null) return inFolder
  const inHome = places.home ? under(target, places.home) : null
  if (inHome !== null) return `~${target.includes('\\') ? '\\' : '/'}${inHome}`
  return target
}
