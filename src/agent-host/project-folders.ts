// Huli: the folders a project could add, found only when asked: the Git repositories one level
// inside its folder, and the folders a `.code-workspace` file in it lists. Nothing is added here;
// each one is the user's to add, as adding it lets agents work where they could not before.

import { readdir, readFile, realpath as fsRealpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FolderSuggestion } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import { canonicalizePath, folderName, isAbsolutePath, pathKey } from './paths'

/** The most entries of the project's folder looked at, and the most suggestions given. */
const MAX_ENTRIES = 400
const MAX_SUGGESTIONS = 64
/** The most `.code-workspace` files read, and the largest one read. */
const MAX_WORKSPACE_FILES = 4
const MAX_WORKSPACE_BYTES = 512 * 1024

/** Folders one level down that are never a repository of the project's own. */
const SKIPPED = new Set(['node_modules', '.git', 'vendor', 'target', 'dist', 'build', 'out'])

export interface SuggestDeps {
  platform: Platform
  realpath?: (value: string) => Promise<string>
  isDirectory?: (value: string) => Promise<boolean>
  /** Whether the folder holds a `.git` folder or file, as a repository or a worktree does. */
  hasGit?: (folder: string) => Promise<boolean>
  readDir?: (folder: string) => Promise<{ name: string; directory: boolean; file: boolean }[]>
  readText?: (file: string) => Promise<string>
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory()
  } catch {
    return false
  }
}

async function hasGit(folder: string): Promise<boolean> {
  try {
    await stat(path.join(folder, '.git'))
    return true
  } catch {
    return false
  }
}

async function readDir(
  folder: string,
): Promise<{ name: string; directory: boolean; file: boolean }[]> {
  const entries = await readdir(folder, { withFileTypes: true })
  return entries.map((entry) => ({
    name: entry.name,
    directory: entry.isDirectory(),
    file: entry.isFile(),
  }))
}

async function readText(file: string): Promise<string> {
  const info = await stat(file)
  if (info.size > MAX_WORKSPACE_BYTES) throw new Error(`${file} is too large`)
  return readFile(file, 'utf8')
}

/**
 * The folders the project at `projectPath` (canonical) could add, `existing` (its further folders)
 * left out, as is the project's own folder. A folder that cannot be read gives none.
 */
export async function suggestFolders(
  projectPath: string,
  existing: readonly string[],
  deps: SuggestDeps,
): Promise<FolderSuggestion[]> {
  const { platform } = deps
  const api = platform === 'win32' ? path.win32 : path.posix
  const real = deps.realpath ?? ((value: string) => fsRealpath(value))
  const directory = deps.isDirectory ?? isDirectory
  const git = deps.hasGit ?? hasGit
  const list = deps.readDir ?? readDir
  const text = deps.readText ?? readText
  const taken = new Set([projectPath, ...existing].map((folder) => pathKey(folder, platform)))
  const found: FolderSuggestion[] = []
  const add = (suggestion: FolderSuggestion): void => {
    const key = pathKey(suggestion.path, platform)
    if (taken.has(key) || found.length >= MAX_SUGGESTIONS) return
    taken.add(key)
    found.push(suggestion)
  }

  let entries: Awaited<ReturnType<typeof list>>
  try {
    entries = (await list(projectPath)).slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
  const repositories = await Promise.all(
    entries
      .filter((entry) => entry.directory && !entry.name.startsWith('.') && !SKIPPED.has(entry.name))
      .map(async (entry) => {
        const folder = api.join(projectPath, entry.name)
        return (await git(folder)) ? folder : null
      }),
  )
  for (const folder of repositories) {
    if (folder)
      add({ path: folder, name: folderName(folder, platform), source: 'repository', repo: true })
  }

  const workspaces = entries
    .filter((entry) => entry.file && entry.name.toLowerCase().endsWith('.code-workspace'))
    .map((entry) => api.join(projectPath, entry.name))
    .slice(0, MAX_WORKSPACE_FILES)
  for (const file of workspaces) {
    let listed: { path: string; name: string | null }[]
    try {
      listed = workspaceFolders(await text(file))
    } catch {
      continue
    }
    for (const item of listed) {
      const written = isAbsolutePath(item.path, platform)
        ? item.path
        : api.join(projectPath, item.path)
      let canonical: string
      try {
        canonical = await canonicalizePath(written, platform, real)
      } catch {
        continue
      }
      if (!(await directory(canonical))) continue
      add({
        path: canonical,
        name: item.name?.trim() || folderName(canonical, platform),
        source: 'workspace',
        repo: await git(canonical),
      })
    }
  }
  return found
}

/**
 * The folders a `.code-workspace` file lists, as VS Code reads it: JSON with comments and trailing
 * commas, its `folders` each with a `path` and an optional `name`. Throws when it does not read.
 */
export function workspaceFolders(source: string): { path: string; name: string | null }[] {
  const data: unknown = JSON.parse(plainJson(source))
  const folders = (data as { folders?: unknown } | null)?.folders
  if (!Array.isArray(folders)) return []
  const out: { path: string; name: string | null }[] = []
  for (const item of folders) {
    const folder = item as { path?: unknown; name?: unknown } | null
    if (typeof folder?.path !== 'string' || folder.path === '' || folder.path.includes('\0')) {
      continue
    }
    out.push({ path: folder.path, name: typeof folder.name === 'string' ? folder.name : null })
  }
  return out
}

/** JSON with comments and trailing commas as plain JSON; strings are left as they are. */
function plainJson(source: string): string {
  return outsideStrings(
    outsideStrings(source, (text) => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, '')),
    (text) => text.replace(/,(\s*[}\]])/g, '$1'),
  )
}

/** `source` with `change` applied to each run of text outside its strings, comments included. */
function outsideStrings(source: string, change: (text: string) => string): string {
  let out = ''
  let from = 0
  let i = 0
  const n = source.length
  while (i < n) {
    if (source[i] === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? n : end
    } else if (source[i] === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
    } else if (source[i] === '"') {
      let j = i + 1
      while (j < n && source[j] !== '"') j += source[j] === '\\' ? 2 : 1
      out += change(source.slice(from, i)) + source.slice(i, j + 1)
      i = j + 1
      from = i
    } else {
      i++
    }
  }
  return out + change(source.slice(from))
}
