// The owner's commands: the command line takes no secret as an argument, and refuses anything it
// does not know; the running service takes the commands' requests over its admin socket alone,
// strictly read, and applies them at once; with no service, nothing answers on the socket.

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSocketPath, callAdmin, parseAdminRequest, type AdminRequest } from '../src/admin'
import { parseCommand } from '../src/cli'
import { makeServer, type ServerParts } from '../src/server'
import { makeOwner } from './accounts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'huli-admin-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('the command line', () => {
  it('reads every command it has, with only its own arguments', () => {
    expect(parseCommand([])).toEqual({ name: 'serve' })
    expect(parseCommand(['init', '--force'])).toEqual({ name: 'init', force: true })
    expect(parseCommand(['passwd'])).toEqual({ name: 'passwd' })
    expect(parseCommand(['totp'])).toEqual({ name: 'totp' })
    expect(parseCommand(['signout-all'])).toEqual({ name: 'signout-all', username: null })
    expect(parseCommand(['signout-all', 'Friend'])).toEqual({
      name: 'signout-all',
      username: 'friend',
    })
    expect(parseCommand(['user', 'list'])).toEqual({ name: 'user-list' })
    expect(parseCommand(['user', 'invite'])).toEqual({ name: 'user-invite', days: 7 })
    expect(parseCommand(['user', 'invite', '--days', '14'])).toEqual({
      name: 'user-invite',
      days: 14,
    })
    expect(parseCommand(['user', 'invite', '--days=3'])).toEqual({ name: 'user-invite', days: 3 })
    expect(parseCommand(['user', 'uninvite', 'Ab_9-xY2'])).toEqual({
      name: 'user-uninvite',
      id: 'Ab_9-xY2',
    })
    for (const action of ['disable', 'enable', 'remove'] as const) {
      expect(parseCommand(['user', action, 'bob'])).toEqual({
        name: `user-${action}`,
        username: 'bob',
      })
    }
    expect(parseCommand(['user', 'reset', 'bob', '--days', '2'])).toEqual({
      name: 'user-reset',
      username: 'bob',
      days: 2,
    })
  })

  it('takes no password, code or secret on the command line, nor anything it does not know', () => {
    const refused = [
      ['passwd', 'hunter2hunter2'],
      ['passwd', '--password=hunter2hunter2'],
      ['totp', '123456'],
      ['totp', '--secret', 'JBSWY3DPEHPK3PXP'],
      ['init', 'owner', 'hunter2hunter2'],
      ['init', '--password', 'hunter2hunter2'],
      ['init', '--force', '--password=x'],
      ['serve', '--password=x'],
      ['signout-all', 'bob', 'extra'],
      ['user', 'add', 'bob'],
      ['user', 'add', 'bob', 'hunter2hunter2'],
      ['user', 'invite', 'ABCD-EFGH-JKMN-PQRS'],
      ['user', 'invite', '--code', 'ABCD-EFGH-JKMN-PQRS'],
      ['user', 'invite', '--days', '0'],
      ['user', 'invite', '--days', '31'],
      ['user', 'invite', '--days'],
      ['user', 'uninvite'],
      ['user', 'uninvite', 'a b'],
      ['user', 'reset', 'bob', 'hunter2hunter2'],
      ['user', 'reset', 'bob', '--password', 'hunter2hunter2'],
      ['user', 'disable', 'bob', 'now'],
      ['user', 'remove'],
      ['user', 'remove', 'not a name'],
      ['user', 'list', 'all'],
      ['user'],
      ['nonsense'],
    ]
    for (const argv of refused) expect(parseCommand(argv), argv.join(' ')).toBeNull()
  })
})

describe('the admin socket', () => {
  let parts: ServerParts
  let dir: string

  beforeAll(async () => {
    dir = tempDir()
    parts = makeServer({ origin: 'http://127.0.0.1', dataDir: dir, trustProxy: false }, null, {
      log: () => {},
    })
    makeOwner(parts.store)
    await new Promise<void>((resolve) => parts.adminServer!.once('listening', resolve))
  })

  afterAll(() => {
    parts.relay.close()
    parts.adminServer?.close()
  })

  it('takes the commands’ requests and applies them to the running service at once', async () => {
    const socket = adminSocketPath(dir)
    if (process.platform !== 'win32') expect(statSync(socket).mode & 0o777).toBe(0o600)
    const made = await callAdmin(socket, { op: 'invite', days: 2 })
    if (!made?.ok) throw new Error('no answer')
    // Kept by the service itself, which is the one to write state.json.
    expect(parts.store.openInvite(made.answer.code!)).not.toBeNull()
    const listed = await callAdmin(socket, { op: 'list' })
    expect(listed).toMatchObject({
      ok: true,
      answer: { accounts: [{ username: 'owner', owner: true }], invites: [{ status: 'open' }] },
    })
    expect(await callAdmin(socket, { op: 'disable', username: 'owner' })).toEqual({
      ok: false,
      error: '机主账号不能停用。',
    })
    const bogus = { op: 'passwd', password: 'plain text' } as unknown as AdminRequest
    expect(await callAdmin(socket, bogus)).toEqual({ ok: false, error: '看不懂这个请求。' })
  })

  it('finds nobody listening for a data folder with no service', async () => {
    expect(await callAdmin(adminSocketPath(tempDir()), { op: 'list' })).toBeNull()
  })

  it('reads a request strictly', () => {
    const refused: unknown[] = [
      null,
      'list',
      { op: 'drop-table' },
      { op: 'invite', days: 0 },
      { op: 'invite', days: 31 },
      { op: 'invite', days: 1.5 },
      { op: 'reset', username: 'bob' },
      { op: 'remove', username: 7 },
      { op: 'passwd', password: 'not a hash' },
      { op: 'init', force: false, username: 'o', email: 'e', name: null, credentials: {} },
      { op: 'totp', totp: 'X', totpLastStep: 'one', recovery: [] },
      { op: 'totp', totp: 'X', totpLastStep: 1, recovery: new Array(33).fill('h') },
    ]
    for (const value of refused) expect(parseAdminRequest(value)).toBeNull()
    expect(parseAdminRequest({ op: 'remove', username: 'bob', extra: 'ignored' })).toEqual({
      op: 'remove',
      username: 'bob',
    })
  })
})
