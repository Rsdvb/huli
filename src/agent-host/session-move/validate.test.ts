// Huli: what each host takes of a move's requests from the other computer: ids by their shape,
// the pack's file names one of a few kinds and never a path out of the move's folder, parts and
// packs within the limits, a clone only by a repository URL, and a transcript's folder only as
// an absolute path of the system that sent it.

import { describe, expect, it } from 'vitest'
import { MOVE_MAX_BYTES, MOVE_PART_BYTES } from '@shared/session-move'
import { moveValidators } from './validate'

const linux = moveValidators('linux')
const windows = moveValidators('win32')
const MOVE = 'a'.repeat(32)
const OID = '1'.repeat(40)
const ID = '0c1f2e3d-4b5a-4697-8a8b-9c0d1e2f3a4b'

const apply = (changes: Record<string, unknown> = {}) => ({
  moveId: MOVE,
  files: [{ name: 'transcript', size: 3, sha256: 'f'.repeat(64) }],
  git: { head: OID, branch: 'feat/x', upstream: null, wip: null, bundled: false },
  conversation: { kind: 'claude', acpSessionId: ID, cwd: 'C:\\code\\kite', platform: 'win32' },
  agentId: 'claude-code',
  title: 'T',
  createdAt: 1,
  worktree: null,
  ...changes,
})

describe('the move requests', () => {
  it('names a pack’s files only as a pack does', () => {
    const part = (name: string) => () => linux['moves.part']({ moveId: MOVE, name, offset: 0 })
    for (const name of ['bundle', 'transcript', 'thread', 'extra/subagents/agent-1.jsonl']) {
      expect(part(name)()).toMatchObject({ name })
    }
    for (const name of [
      '../journal.json',
      'journal.json',
      'extra/../../x',
      'extra/.hidden',
      'extra//x',
      '/etc/passwd',
      'extra/a/b/c/d/e',
      'C:\\x',
    ]) {
      expect(part(name)).toThrow()
    }
  })

  it('takes parts and packs within the limits', () => {
    const receive = (bytes: Uint8Array, size = 10) =>
      linux['moves.receive']({ moveId: MOVE, name: 'bundle', offset: 0, size, bytes })
    expect(receive(new Uint8Array(3)).bytes).toHaveLength(3)
    expect(() => receive(new Uint8Array(0))).toThrow()
    expect(() => receive(new Uint8Array(MOVE_PART_BYTES + 1))).toThrow()
    expect(() => receive(new Uint8Array(3), MOVE_MAX_BYTES + 1)).toThrow()
    expect(() =>
      linux['moves.receive']({ moveId: MOVE, name: 'bundle', offset: 0, size: 3, bytes: 'abc' }),
    ).toThrow()
    expect(() =>
      linux['moves.apply'](
        apply({
          files: [
            { name: 'bundle', size: MOVE_MAX_BYTES, sha256: 'f'.repeat(64) },
            { name: 'transcript', size: 1, sha256: 'f'.repeat(64) },
          ],
        }),
      ),
    ).toThrow(/too large/)
  })

  it('refuses ids that are not ones', () => {
    expect(() => linux['moves.abort']({ moveId: 'x' })).toThrow()
    expect(() => linux['moves.pack']({ sessionId: 's', moveId: MOVE, haves: ['HEAD'] })).toThrow()
    expect(() =>
      linux['moves.apply'](
        apply({
          conversation: { kind: 'claude', acpSessionId: '../x', cwd: '/x', platform: 'linux' },
        }),
      ),
    ).toThrow()
    expect(() => linux['moves.apply'](apply({ git: { head: 'HEAD' } }))).toThrow()
    expect(() =>
      linux['moves.apply'](
        apply({ git: { head: OID, branch: '--force', upstream: null, wip: null, bundled: true } }),
      ),
    ).toThrow()
  })

  it('reads the source’s folder as a path of the source’s own system', () => {
    // A Windows folder sent to a Linux target, and the other way round.
    expect(linux['moves.apply'](apply()).conversation.cwd).toBe('C:\\code\\kite')
    expect(
      windows['moves.apply'](
        apply({ conversation: { kind: 'carry', cwd: '/home/me/kite', platform: 'linux' } }),
      ).conversation,
    ).toEqual({ kind: 'carry', acpSessionId: '', cwd: '/home/me/kite', platform: 'linux' })
    expect(() =>
      linux['moves.apply'](
        apply({ conversation: { kind: 'carry', cwd: 'kite', platform: 'linux' } }),
      ),
    ).toThrow()
  })

  it('takes a project as this computer’s absolute path, or a clone of a repository', () => {
    const prepare = (project: unknown, url = 'git@github.com:me/kite.git') =>
      linux['moves.prepare']({ moveId: MOVE, project, url })
    expect(prepare({ clone: true }).project).toEqual({ clone: true })
    expect(prepare({ path: '/home/me/kite' }).project).toEqual({ path: '/home/me/kite' })
    expect(() => prepare({ path: 'kite' })).toThrow()
    expect(() => prepare({ clone: true, path: '/x' })).toThrow()
    expect(() => prepare({ clone: true }, 'not a url')).toThrow()
  })
})
