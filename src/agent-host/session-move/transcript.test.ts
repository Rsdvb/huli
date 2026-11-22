// Huli: a moved session's transcript, rewritten for the target's folder: every `cwd` and every
// path under the source's folder in the target's, across Windows and Linux or macOS, the folder
// Claude Code keeps it in named as Claude Code names the target's folder.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeProjectFolder } from '../prompt-cache'
import {
  mapPath,
  rewriteLine,
  rewriteTranscript,
  rewriteTranscriptFile,
  type MoveRoot,
  type TranscriptRewrite,
} from './transcript'

const WIN: MoveRoot = { root: 'C:\\Users\\dvb\\code\\kite', platform: 'win32' }
const LINUX: MoveRoot = { root: '/home/dvb/code/kite', platform: 'linux' }
const MAC: MoveRoot = {
  root: '/Users/dvb/Projects/kite-worktrees/feat-move-1a2b3c4d',
  platform: 'darwin',
}

describe('paths under the source’s folder', () => {
  it('maps Windows paths to Linux ones, whatever their case or separators', () => {
    expect(mapPath('C:\\Users\\dvb\\code\\kite', WIN, LINUX)).toBe('/home/dvb/code/kite')
    expect(mapPath('C:\\Users\\dvb\\code\\kite\\src\\a.ts', WIN, LINUX)).toBe(
      '/home/dvb/code/kite/src/a.ts',
    )
    expect(mapPath('c:/users/DVB/code/kite/src/a.ts', WIN, LINUX)).toBe(
      '/home/dvb/code/kite/src/a.ts',
    )
    expect(mapPath('C:\\Users\\dvb\\code\\kite-other\\a.ts', WIN, LINUX)).toBeNull()
    expect(mapPath('D:\\kite\\a.ts', WIN, LINUX)).toBeNull()
  })

  it('maps Linux and macOS paths to Windows ones, exactly by case', () => {
    expect(mapPath('/home/dvb/code/kite/src/a.ts', LINUX, WIN)).toBe(
      'C:\\Users\\dvb\\code\\kite\\src\\a.ts',
    )
    expect(mapPath('/home/dvb/code/Kite/src/a.ts', LINUX, WIN)).toBeNull()
    expect(mapPath(`${MAC.root}/README.md`, MAC, LINUX)).toBe('/home/dvb/code/kite/README.md')
    expect(mapPath('/home/dvb/code/kite2', LINUX, WIN)).toBeNull()
    // A text that only mentions the folder is no path.
    expect(mapPath('see /home/dvb/code/kite/a.ts', LINUX, WIN)).toBeNull()
  })
})

describe('a Claude Code transcript', () => {
  const rewrite: TranscriptRewrite = { from: WIN, to: LINUX }

  it('rewrites cwd, tool inputs, structured results and path keys, and leaves prose alone', () => {
    const line = JSON.stringify({
      type: 'assistant',
      cwd: 'C:\\Users\\dvb\\code\\kite',
      sessionId: '11111111-1111-4111-8111-111111111111',
      gitBranch: 'feat/move',
      message: {
        content: [
          { type: 'text', text: 'I edited C:\\Users\\dvb\\code\\kite\\a.ts' },
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: 'C:\\Users\\dvb\\code\\kite\\a.ts', old_string: 'x' },
          },
        ],
      },
      toolUseResult: { filePath: 'C:\\Users\\dvb\\code\\kite\\a.ts' },
      snapshot: { trackedFileBackups: { 'C:\\Users\\dvb\\code\\kite\\a.ts': { version: 1 } } },
    })
    const out = JSON.parse(rewriteLine(line, rewrite))
    expect(out.cwd).toBe('/home/dvb/code/kite')
    expect(out.message.content[0].text).toBe('I edited C:\\Users\\dvb\\code\\kite\\a.ts')
    expect(out.message.content[1].input.file_path).toBe('/home/dvb/code/kite/a.ts')
    expect(out.toolUseResult.filePath).toBe('/home/dvb/code/kite/a.ts')
    expect(Object.keys(out.snapshot.trackedFileBackups)).toEqual(['/home/dvb/code/kite/a.ts'])
    // The id and the branch stay unless the target renamed them.
    expect(out.sessionId).toBe('11111111-1111-4111-8111-111111111111')
    expect(out.gitBranch).toBe('feat/move')
  })

  it('takes a new session id and branch where the target gave them', () => {
    const line = JSON.stringify({
      cwd: '/home/dvb/code/kite',
      sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      gitBranch: 'feat/move',
      message: { content: 'feat/move is the branch' },
    })
    const out = JSON.parse(
      rewriteLine(line, {
        from: LINUX,
        to: WIN,
        sessionId: { from: 'aaaaaaaa-1111-4111-8111-111111111111', to: 'new-id' },
        branch: { from: 'feat/move', to: 'feat/move-2' },
      }),
    )
    expect(out).toEqual({
      cwd: 'C:\\Users\\dvb\\code\\kite',
      sessionId: 'new-id',
      gitBranch: 'feat/move-2',
      message: { content: 'feat/move is the branch' },
    })
  })

  it('keeps lines that are not JSON, blank lines and CRLF line ends', () => {
    const text = '{"cwd":"C:\\\\Users\\\\dvb\\\\code\\\\kite"}\r\nnot json\r\n\r\n'
    expect(rewriteTranscript(text, rewrite)).toBe(
      '{"cwd":"/home/dvb/code/kite"}\r\nnot json\r\n\r\n',
    )
    const untouched = '{"cwd":"/elsewhere","n":1}'
    expect(rewriteLine(untouched, rewrite)).toBe(untouched)
  })

  it('names the target’s project folder as Claude Code does on each system', () => {
    expect(claudeProjectFolder('C:\\Users\\dvb\\code\\kite')).toBe('C--Users-dvb-code-kite')
    expect(claudeProjectFolder('/home/dvb/code/kite')).toBe('-home-dvb-code-kite')
    expect(claudeProjectFolder('/Users/dvb/Projects/kite.app')).toBe('-Users-dvb-Projects-kite-app')
    const long = `/home/dvb/${'deep/'.repeat(60)}kite`
    const name = claudeProjectFolder(long)
    expect(name.length).toBeGreaterThan(200)
    expect(name.startsWith(long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200))).toBe(true)
  })
})

describe('a Codex rollout', () => {
  it('rewrites the session’s and each turn’s folder, and the thread id when renamed', () => {
    const from = 'ffffffff-1111-7111-8111-111111111111'
    const lines = [
      {
        type: 'session_meta',
        payload: { id: from, cwd: '/home/dvb/code/kite', git: { branch: 'main' } },
      },
      { type: 'turn_context', payload: { cwd: '/home/dvb/code/kite/src', model: 'gpt' } },
    ].map((line) => JSON.stringify(line))
    const out = rewriteTranscript(lines.join('\n'), {
      from: LINUX,
      to: WIN,
      sessionId: { from, to: 'eeeeeeee-1111-7111-8111-111111111111' },
    })
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(out[0].payload).toEqual({
      id: 'eeeeeeee-1111-7111-8111-111111111111',
      cwd: 'C:\\Users\\dvb\\code\\kite',
      git: { branch: 'main' },
    })
    expect(out[1].payload.cwd).toBe('C:\\Users\\dvb\\code\\kite\\src')
  })
})

describe('the file rewrite', () => {
  let dir: string

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes a new file line by line and never replaces one that is there', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'kite-move-transcript-'))
    const from = path.join(dir, 'in.jsonl')
    const to = path.join(dir, 'out.jsonl')
    const lines = Array.from({ length: 5_000 }, (_, i) =>
      JSON.stringify({ n: i, cwd: '/home/dvb/code/kite' }),
    )
    await writeFile(from, `${lines.join('\n')}\n`)
    await rewriteTranscriptFile(from, to, { from: LINUX, to: WIN })
    const written = (await readFile(to, 'utf8')).trimEnd().split('\n')
    expect(written).toHaveLength(5_000)
    expect(JSON.parse(written[4_999]!)).toEqual({ n: 4_999, cwd: 'C:\\Users\\dvb\\code\\kite' })
    await expect(rewriteTranscriptFile(from, to, { from: LINUX, to: WIN })).rejects.toThrow()
    expect((await readFile(to, 'utf8')).trimEnd().split('\n')).toHaveLength(5_000)
  })
})
