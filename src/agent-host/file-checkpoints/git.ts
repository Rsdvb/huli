// Huli: git for the file checkpoints, read only on the user's repository: its status, its trees and
// the working-tree form of its blobs. Never through a shell, always with a timeout, and with
// binary output, which the git service's runner does not give.

import { spawn, type ChildProcess } from 'node:child_process'
import type { Platform } from '@shared/platform'
import { CHILD_ENV } from '../git/exec'
import { findExecutable } from '../git/executable'

export interface GitRun {
  code: number | null
  stdout: Buffer
  stderr: string
}

export interface GitOptions {
  cwd: string
  timeoutMs: number
  /** Written to the command's input, then closed. */
  input?: string
  maxBytes?: number
}

export type RunGit = (args: readonly string[], options: GitOptions) => Promise<GitRun>

export interface GitRunner {
  run: RunGit
  /** Ends every running command; later ones fail at once. */
  stop(): void
}

const MAX_BYTES = 256 * 1024 * 1024

// Nothing of the user's own setup may change what is read: no fsmonitor daemon is started for a
// folder, no pager or prompt, and no lock is taken on the user's index.
const READ_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'status.relativePaths=false',
]

export function createGitRunner(
  getEnv: () => NodeJS.ProcessEnv,
  platform: Platform,
  find: (env: NodeJS.ProcessEnv) => Promise<string | null> = (env) =>
    findExecutable('git', platform, env),
): GitRunner {
  const children = new Set<ChildProcess>()
  let stopped = false
  let command: string | null = null
  const run: RunGit = async (args, options) => {
    if (stopped) return { code: null, stdout: Buffer.alloc(0), stderr: 'stopped' }
    const env: NodeJS.ProcessEnv = {
      ...getEnv(),
      ...CHILD_ENV,
      GIT_OPTIONAL_LOCKS: '0',
      // A repository the environment names would replace the folder's own.
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      GIT_CEILING_DIRECTORIES: undefined,
      GIT_PAGER: 'cat',
    }
    command ??= await find(env)
    if (command === null) return { code: null, stdout: Buffer.alloc(0), stderr: 'git not found' }
    const max = options.maxBytes ?? MAX_BYTES
    return new Promise<GitRun>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(command!, [...READ_CONFIG, ...args], {
          cwd: options.cwd,
          env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        resolve({ code: null, stdout: Buffer.alloc(0), stderr: String(error) })
        return
      }
      children.add(child)
      const out: Buffer[] = []
      let size = 0
      let err = ''
      let over = false
      const timer = setTimeout(() => {
        over = true
        child.kill()
      }, options.timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > max) {
          over = true
          child.kill()
          return
        }
        out.push(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (err.length < 8192) err += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        err += String(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        children.delete(child)
        resolve({ code: over ? null : code, stdout: Buffer.concat(out), stderr: err })
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.input ?? '')
    })
  }
  return {
    run,
    stop() {
      stopped = true
      for (const child of children) child.kill()
      children.clear()
    },
  }
}

export interface RepoInfo {
  /** The working tree's top folder, as git names it. */
  top: string
  /** The folder's place in it, `/`-separated with a trailing slash; empty at the top. */
  prefix: string
}

/** The repository the folder is in, or null outside one. */
export async function repoOf(run: RunGit, folder: string): Promise<RepoInfo | null> {
  const result = await run(['rev-parse', '--show-toplevel', '--show-prefix'], {
    cwd: folder,
    timeoutMs: 15_000,
  })
  if (result.code !== 0) return null
  const [top, prefix = ''] = result.stdout.toString('utf8').split('\n')
  if (!top) return null
  return { top, prefix: prefix.trim() }
}

export interface StatusEntry {
  /** Relative to the repository's top. */
  path: string
  /** Whether a file is in the working tree at the path. */
  present: boolean
  untracked: boolean
}

export interface RepoStatus {
  /** HEAD's commit; null before the first commit. */
  head: string | null
  entries: StatusEntry[]
}

/**
 * The folder's paths that differ from HEAD, by `git status`: staged, changed, deleted, unmerged
 * and untracked ones, each untracked file on its own. A clean path is HEAD's blob as checked out.
 */
export async function statusOf(run: RunGit, folder: string): Promise<RepoStatus | null> {
  const result = await run(
    [
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--untracked-files=all',
      '--ignore-submodules=all',
      '--no-renames',
      '--',
      '.',
    ],
    { cwd: folder, timeoutMs: 60_000 },
  )
  if (result.code !== 0) return null
  return parseStatus(result.stdout.toString('utf8'))
}

export function parseStatus(text: string): RepoStatus {
  let head: string | null = null
  const entries: StatusEntry[] = []
  for (const record of text.split('\0')) {
    if (record === '') continue
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length).trim()
      head = /^[0-9a-f]{40,64}$/.test(oid) ? oid : null
      continue
    }
    const kind = record[0]
    if (kind === '?') {
      entries.push({ path: record.slice(2), present: true, untracked: true })
    } else if (kind === '1' || kind === 'u') {
      // 1 XY sub mH mI mW hH hI path; u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = kind === '1' ? 8 : 10
      const parts = record.split(' ')
      const sub = parts[2] ?? ''
      if (sub.startsWith('S')) continue
      const worktreeMode = parts[kind === '1' ? 5 : 6] ?? ''
      const path = parts.slice(fields).join(' ')
      if (!path) continue
      entries.push({ path, present: worktreeMode !== '000000', untracked: false })
    }
  }
  return { head, entries }
}

export interface TreeEntry {
  mode: string
  oid: string
}

/**
 * HEAD's files under `prefix`, by path relative to the repository's top: only blobs and links,
 * a submodule being another repository's to keep.
 */
export async function treeOf(
  run: RunGit,
  top: string,
  head: string,
  prefix: string,
  paths?: readonly string[],
): Promise<Map<string, TreeEntry> | null> {
  const spec = paths
    ? paths.map((path) => `:(literal)${path}`)
    : [prefix ? `:(literal)${prefix}` : '.']
  const result = await run(['ls-tree', '-r', '-z', '--full-tree', head, '--', ...spec], {
    cwd: top,
    timeoutMs: 60_000,
  })
  if (result.code !== 0) return null
  const tree = new Map<string, TreeEntry>()
  for (const record of result.stdout.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    if (type !== 'blob' || !mode || !oid) continue
    tree.set(record.slice(tab + 1), { mode, oid })
  }
  return tree
}

/**
 * Blobs as the user's checkout writes them, through their filters and line endings, by
 * `git cat-file --batch --filters`; a blob the repository lacks is missing from the result.
 */
export async function checkedOut(
  run: RunGit,
  top: string,
  wanted: readonly { oid: string; path: string }[],
): Promise<Map<string, Buffer> | null> {
  const out = new Map<string, Buffer>()
  for (let at = 0; at < wanted.length; at += 200) {
    const batch = wanted.slice(at, at + 200)
    // A path with a line break cannot be named on the command's input.
    const named = batch.filter((item) => !/[\r\n]/.test(item.path))
    if (named.length === 0) continue
    const result = await run(['cat-file', '--batch', '--filters'], {
      cwd: top,
      timeoutMs: 120_000,
      input: named.map((item) => `${item.oid} ${item.path}\n`).join(''),
    })
    if (result.code !== 0) return null
    const data = result.stdout
    let offset = 0
    for (const item of named) {
      const end = data.indexOf(0x0a, offset)
      if (end < 0) break
      const header = data.subarray(offset, end).toString('utf8').split(' ')
      offset = end + 1
      if (header[1] !== 'blob') continue
      const size = Number(header[2])
      if (!Number.isSafeInteger(size) || offset + size > data.length) break
      out.set(item.path, Buffer.from(data.subarray(offset, offset + size)))
      offset += size + 1
    }
  }
  return out
}
