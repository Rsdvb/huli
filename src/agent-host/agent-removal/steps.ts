// Huli: a removal's steps as the host plans them, with what running them needs, and the file
// access the planners use, which tests replace with a fake disk of any platform.

import { lstat, readdir, realpath } from 'node:fs/promises'
import type { RemovalPart, RemovalStepKind } from '@shared/agent-removal'
import type { SecretRef } from '../agent-reset/plan'
import { CLI_FILES } from '../installed-cli'

export interface PlannedStep {
  part: RemovalPart
  kind: RemovalStepKind
  path: string
  kite?: true
  except?: string[]
  secret?: SecretRef
  /** A command's program and arguments, the flags the line leaves out included. */
  run?: { program: string; args: string[] }
  /** The folder a command removes, which its size is read from. */
  measure?: string
  /** Folders removed after the step when it left them empty, innermost first. */
  prune?: string[]
}

export type FileKind = 'file' | 'folder' | 'link'

export interface RemovalFiles {
  /** What is at the path, a link not followed; null for nothing. */
  kind(target: string): Promise<FileKind | null>
  realpath(target: string): Promise<string>
  /** The names in a folder; none for one that is not there. */
  list(folder: string): Promise<string[]>
  /** The first `limit` bytes of a file, as text: an npm shim's. */
  readText(file: string, limit: number): Promise<string>
}

export const DISK: RemovalFiles = {
  kind: async (target) => {
    const info = await lstat(target).catch(() => null)
    if (!info) return null
    if (info.isSymbolicLink()) return 'link'
    return info.isDirectory() ? 'folder' : 'file'
  },
  realpath: (target) => realpath(target),
  list: (folder) => readdir(folder).catch(() => [] as string[]),
  readText: (file, limit) => CLI_FILES.readText(file, limit),
}
