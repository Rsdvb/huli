// File references in what a session shows, as the desktop's file-refs.ts reads them: `src/x.ts`,
// `./src/x.ts:12`, `src/x.ts#L12`, or an absolute path or a `file:` URI inside the session's
// folder. A reference that names one of the folder's files opens it on the file screen.

import { createContext, useContext } from 'react'
import { router } from 'expo-router'
import { relativePath } from './format'

export interface FileRef {
  /** Relative to the folder's root, with `/`. */
  path: string
  line: number | null
}

export interface FileRefsContext {
  sessionId: string
  /** The session's folder; null for a session without a project. */
  root: string | null
  /** The folder's files, once read; null until then, when nothing reads as a file. */
  known: ReadonlySet<string> | null
}

export const FileRefs = createContext<FileRefsContext | null>(null)

export function useFileRefs(): FileRefsContext | null {
  return useContext(FileRefs)
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const FILE_URI = /^file:/i
const LINE_SUFFIX = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/

function fileUriPath(uri: string): string | null {
  const match = /^file:\/\/([^/]*)(\/.*)$/i.exec(uri)
  if (!match || (match[1] !== '' && match[1] !== 'localhost')) return null
  try {
    const path = decodeURIComponent(match[2]!)
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path
  } catch {
    return null
  }
}

/** A file reference as replies write them; null for anything else, such as a URL. */
export function parseFileRef(text: string, root: string): FileRef | null {
  let value = text.trim()
  if (!value || /\s/.test(value) || value.startsWith('#') || value.startsWith('//')) return null
  if (FILE_URI.test(value)) {
    const path = fileUriPath(value)
    if (path === null) return null
    value = path
  } else {
    if (SCHEME.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null
    try {
      value = decodeURI(value)
    } catch {
      return null
    }
  }
  let line: number | null = null
  const suffix = LINE_SUFFIX.exec(value)
  if (suffix) {
    value = suffix[1]!
    line = Number(suffix[2] ?? suffix[3])
  }
  const inside = relativePath(value, root)
  if (inside !== value) value = inside
  else if (value.startsWith('/') || /^[a-z]:[\\/]/i.test(value)) return null
  value = value.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (!value || value.split('/').includes('..')) return null
  return { path: value, line: line && line > 0 ? line : null }
}

/** The reference when it names one of the folder's files, else null. */
export function knownFileRef(text: string, refs: FileRefsContext | null): FileRef | null {
  if (!refs?.root || !refs.known) return null
  const ref = parseFileRef(text, refs.root)
  return ref && refs.known.has(ref.path) ? ref : null
}

const foldersKept = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>()

/** Every folder that holds one of the files, each with its trailing `/`. */
export function foldersOf(files: ReadonlySet<string>): ReadonlySet<string> {
  const known = foldersKept.get(files)
  if (known) return known
  const folders = new Set<string>()
  for (const path of files) {
    for (let cut = path.indexOf('/'); cut > 0; cut = path.indexOf('/', cut + 1)) {
      folders.add(path.slice(0, cut + 1))
    }
  }
  foldersKept.set(files, folders)
  return folders
}

/** Opens a file of a session's folder on the file screen, at a line when one is named. */
export function openFile(sessionId: string, path: string, line: number | null = null): void {
  router.push({
    pathname: '/file',
    params: { id: sessionId, path, ...(line !== null ? { line: String(line) } : {}) },
  })
}
