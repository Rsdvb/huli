import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../log'
import type { IdentityCipher } from '../remote-identity'
import {
  parsePayload,
  SavedStateError,
  SavedStates,
  savedStatesFile,
  type SavedPayload,
} from './saved-states'

const COOKIE_VALUE = 'sessionSECRET-0123456789abcdef'
const TOKEN_VALUE = 'eyJhbGciOiJIUzI1NiJ9.storageSECRET'

const flip = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0x5a))

function cipher(available = true, plainText = false): IdentityCipher {
  return {
    available: async () => available,
    encrypt: async (text) => flip(Buffer.from(text, 'utf8')),
    decrypt: async (encrypted) => ({
      result: flip(encrypted).toString('utf8'),
      shouldReEncrypt: false,
    }),
    plainText: () => plainText,
  }
}

const warnings: string[] = []
const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message) => void warnings.push(String(message)),
  error: (message) => void warnings.push(String(message)),
}

const payload: SavedPayload = {
  cookies: [
    {
      name: 'session',
      value: COOKIE_VALUE,
      domain: '127.0.0.1',
      path: '/',
      secure: false,
      httpOnly: true,
      sameSite: 'lax',
      hostOnly: true,
      expirationDate: 2_000_000_000,
    },
  ],
  storage: [{ origin: 'http://127.0.0.1:3000', items: [['token', TOKEN_VALUE]] }],
}

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kite-browser-states-'))
  file = savedStatesFile(dir)
  warnings.length = 0
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('saved sign-in states', () => {
  it('writes a state sealed, with only its name, sites and time in the clear', async () => {
    const store = await SavedStates.load(file, cipher(), log)
    await store.save('admin', ['127.0.0.1'], payload, 1_700_000_000_000)
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain(COOKIE_VALUE)
    expect(text).not.toContain(TOKEN_VALUE)
    expect(text).not.toContain('session')
    expect(text).toContain('"admin"')
    expect(text).toContain('127.0.0.1')
    expect(store.list()).toEqual([
      { name: 'admin', sites: ['127.0.0.1'], savedAt: 1_700_000_000_000 },
    ])
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('opens what it sealed, after a restart too', async () => {
    const store = await SavedStates.load(file, cipher(), log)
    await store.save('admin', ['127.0.0.1'], payload)
    const again = await SavedStates.load(file, cipher(), log)
    expect(await again.open('admin')).toEqual(payload)
    expect(await again.open('nobody')).toBeNull()
  })

  it('saves nothing without the system encryption, or where it protects nothing', async () => {
    for (const refusing of [cipher(false), cipher(true, true)]) {
      const store = await SavedStates.load(file, refusing, log)
      await expect(store.save('admin', ['127.0.0.1'], payload)).rejects.toBeInstanceOf(
        SavedStateError,
      )
    }
    await expect(stat(file)).rejects.toThrow()
  })

  it('replaces a state of the same name and deletes one for good', async () => {
    const store = await SavedStates.load(file, cipher(), log)
    await store.save('admin', ['a.test'], payload, 1)
    await store.save('admin', ['b.test'], payload, 2)
    expect(store.list()).toEqual([{ name: 'admin', sites: ['b.test'], savedAt: 2 }])
    expect(await store.remove('admin')).toBe(true)
    expect(await store.remove('admin')).toBe(false)
    expect(JSON.parse(await readFile(file, 'utf8')).states).toEqual([])
  })

  it('refuses a name that is not one short line', async () => {
    const store = await SavedStates.load(file, cipher(), log)
    for (const name of ['', ' padded ', 'two\nlines', 'x'.repeat(61)]) {
      await expect(store.save(name, [], payload)).rejects.toBeInstanceOf(SavedStateError)
    }
  })

  it('leaves out entries that do not fit and states it cannot open', async () => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        states: [
          {
            name: 'ok',
            sites: ['a.test'],
            savedAt: 1,
            sealed: flip(Buffer.from('{}')).toString('base64'),
          },
          { name: 'no seal', sites: [], savedAt: 1 },
          { name: '', sites: [], savedAt: 1, sealed: 'x' },
          'not an entry',
        ],
      }),
    )
    const store = await SavedStates.load(file, cipher(), log)
    expect(store.list().map((state) => state.name)).toEqual(['ok'])
    // Its contents are no state's, which is said without what they hold.
    await expect(store.open('ok')).rejects.toBeInstanceOf(SavedStateError)
  })

  it('never logs what a state holds', async () => {
    const store = await SavedStates.load(file, cipher(), log)
    await store.save('admin', ['127.0.0.1'], payload)
    await store.open('admin')
    expect(warnings.join('\n')).not.toContain(COOKIE_VALUE)
    expect(warnings.join('\n')).not.toContain(TOKEN_VALUE)
  })
})

describe('a state as unsealed', () => {
  it('takes cookies and storage of the right shape only', () => {
    expect(parsePayload(payload)).toEqual(payload)
    expect(parsePayload({ cookies: [{ name: 'a' }], storage: [] })).toBeNull()
    expect(parsePayload({ cookies: [], storage: [{ origin: 'x', items: [['k', 1]] }] })).toBeNull()
    expect(parsePayload(null)).toBeNull()
  })
})
