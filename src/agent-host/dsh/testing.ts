// A DeepSeek Harness home for tests, with sessions placed from the fixtures as dsh writes them.
// The fixtures are logs dsh 0.2.2-rc.5 (format 4) and 0.1.6-alpha.2 (format 3) wrote in a scratch
// home against a scripted model, the working directory as `__CWD__` and the context dsh injects
// trimmed.

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { encodeSegment, projectKey, sessionsRoot } from './history'

export type Fixture =
  | 'tools.v4'
  | 'tools.v3'
  | 'subagent-parent.v4'
  | 'subagent-child.v4'
  | 'kite.v4'
  | 'titled.v4'
  | 'blank.v4'

export function fixture(name: Fixture): string {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8')
}

export interface Place {
  /** The working directory the log names; the home's own `work` folder by default. */
  cwd?: string
  /** Kept as written, as with dsh's `compression: none`; zstd frames otherwise. */
  plain?: boolean
  /** The format version its file name gives; the header's own by default. */
  version?: number
  /** The project folder it lies in; the one dsh names for its working directory by default. */
  project?: string
}

export interface TestHome {
  home: string
  root: string
  cwd: string
  /** Writes a log as dsh does: a frame for its header, then one for the rest. */
  place(text: string, options?: Place): Promise<string>
  remove(): Promise<void>
}

export async function testHome(): Promise<TestHome> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'kite-dsh-history-'))
  const home = path.join(base, '.dsh')
  const cwd = path.join(base, 'work', 'demo-project')
  await mkdir(cwd, { recursive: true })
  const root = sessionsRoot(home)
  return {
    home,
    root,
    cwd,
    async place(text, options = {}) {
      const at = options.cwd ?? cwd
      const filled = text.split('__CWD__').join(JSON.stringify(at).slice(1, -1))
      const end = filled.indexOf('\n')
      const header = JSON.parse(end < 0 ? filled : filled.slice(0, end)) as {
        id: string
        version: number
      }
      const version = options.version ?? header.version
      const dir = path.join(root, options.project ?? projectKey(at), encodeSegment(header.id))
      await mkdir(dir, { recursive: true })
      const name = version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`
      const file = path.join(dir, options.plain ? name : `${name}.zstd`)
      const bytes = options.plain
        ? Buffer.from(filled)
        : Buffer.concat([
            zstdCompressSync(Buffer.from(filled.slice(0, end + 1))),
            ...(end + 1 < filled.length
              ? [zstdCompressSync(Buffer.from(filled.slice(end + 1)))]
              : []),
          ])
      await writeFile(file, bytes)
      return file
    },
    remove: () => rm(base, { recursive: true, force: true }),
  }
}

/** The bytes dsh stored for the fixtures' one image, a 1x1 PNG, by its attachment id. */
export const IMAGE = {
  id: 'sha256:c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77',
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
}

export async function placeImage(home: string): Promise<void> {
  const sha = IMAGE.id.slice('sha256:'.length)
  const dir = path.join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2))
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, sha), Buffer.from(IMAGE.base64, 'base64'))
}
