import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatBridgeConfig, ChatBridgeView } from '@shared/chat-bridge'
import { ChatBridgeError, ChatBridgeStore, chatBridgeFile, parseStatus } from './chat-bridge'
import type { Logger } from './log'
import type { IdentityCipher } from './remote-identity'

const SECRET = 'feishuSECRETvalue0123456789'
const TOKEN = '123456789:AAHsecretTELEGRAMtoken_xyz'

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

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let dir: string
let now: number
let pushed: ChatBridgeConfig[]
let views: ChatBridgeView[]

function open(options: { cipher?: IdentityCipher } = {}): ChatBridgeStore {
  return new ChatBridgeStore({
    file: chatBridgeFile(dir),
    cipher: options.cipher ?? cipher(),
    pushed: (config) => pushed.push(config),
    changed: (view) => views.push(view),
    log: silent,
    now: () => now,
  })
}

async function withTelegram(store: ChatBridgeStore): Promise<void> {
  await store.save('telegram', { credentials: { token: TOKEN }, enabled: true })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kite-chat-bridge-'))
  now = 1_700_000_000_000
  pushed = []
  views = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ChatBridgeStore', () => {
  it('keeps the credentials encrypted, in a file only the user reads', async () => {
    const store = open()
    await store.save('feishu', {
      credentials: { appId: 'cli_a1b2c3d4e5f60718', appSecret: SECRET },
    })
    const text = await readFile(chatBridgeFile(dir), 'utf8')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('cli_a1b2c3d4e5f60718')
    expect(JSON.parse(text)).toMatchObject({ version: 1, encrypted: true })
    if (process.platform !== 'win32') {
      expect((await stat(chatBridgeFile(dir))).mode & 0o777).toBe(0o600)
    }
    const again = open()
    expect((await again.state()).platforms.feishu.credentials.appSecret).toEqual({
      set: true,
      shown: '••••6789',
    })
    expect(pushed.at(-1)!.platforms.feishu!.credentials.appSecret).toBe(SECRET)
  })

  it('shows a window no secret, and the host all of them', async () => {
    const store = open()
    await withTelegram(store)
    const view = await store.state()
    expect(JSON.stringify(view)).not.toContain(TOKEN)
    expect(JSON.stringify(views)).not.toContain('AAHsecret')
    expect(view.platforms.telegram).toMatchObject({ enabled: true, ready: true })
    expect(store.configForHost().platforms.telegram!.credentials.token).toBe(TOKEN)
  })

  it('keeps nothing where the system cannot encrypt it', async () => {
    for (const store of [open({ cipher: cipher(false) }), open({ cipher: cipher(true, true) })]) {
      await expect(
        store.save('telegram', { credentials: { token: TOKEN } }),
      ).rejects.toBeInstanceOf(ChatBridgeError)
    }
    await expect(stat(chatBridgeFile(dir))).rejects.toThrow()
  })

  it('refuses a patch it cannot keep, naming no value', async () => {
    const store = open()
    const refusals = [
      ['slack', { enabled: true }],
      ['telegram', { enabled: 'yes' }],
      ['telegram', { credentials: { token: 'has a space' } }],
      ['telegram', { credentials: { appSecret: 'x' } }],
      ['telegram', { credentials: { token: 'x'.repeat(600) } }],
      ['telegram', { extra: true }],
      ['telegram', { enabled: true }],
    ] as const
    for (const [platform, patch] of refusals) {
      const error = await store.save(platform, patch).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ChatBridgeError)
      expect(String((error as Error).message)).not.toContain('has a space')
    }
  })

  it('binds an account only with the code it made, once, in time', async () => {
    const store = open()
    await withTelegram(store)
    const { binding } = await store.startBinding('telegram')
    expect(binding?.code).toMatch(/^\d{6}$/)
    expect(pushed.at(-1)!.binding).toEqual(binding)
    const account = { id: '42', name: 'Owner', chatId: null }
    expect(
      await store.bind('telegram', '000000' === binding!.code ? '111111' : '000000', account),
    ).toBe(false)
    expect(await store.bind('feishu', binding!.code, account)).toBe(false)
    expect(await store.bind('telegram', binding!.code, account)).toBe(true)
    expect((await store.state()).platforms.telegram.accounts).toEqual([
      { ...account, boundAt: now },
    ])
    expect((await store.state()).binding).toBeNull()
    // Used up: the same code binds nobody else.
    expect(await store.bind('telegram', binding!.code, { id: '7', name: 'X', chatId: null })).toBe(
      false,
    )
  })

  it('takes no code past its time', async () => {
    const store = open()
    await withTelegram(store)
    const { binding } = await store.startBinding('telegram')
    now = binding!.expiresAt
    expect(await store.bind('telegram', binding!.code, { id: '42', name: '', chatId: null })).toBe(
      false,
    )
    expect(store.configForHost().binding).toBeNull()
  })

  it('binds only to a bridge that is on', async () => {
    const store = open()
    await store.save('telegram', { credentials: { token: TOKEN } })
    await expect(store.startBinding('telegram')).rejects.toBeInstanceOf(ChatBridgeError)
    await store.save('telegram', { enabled: true })
    await store.startBinding('telegram')
    await store.save('telegram', { enabled: false })
    expect(store.configForHost().binding).toBeNull()
  })

  it('forgets the accounts of a bot whose credentials changed to another', async () => {
    const store = open()
    await withTelegram(store)
    const { binding } = await store.startBinding('telegram')
    await store.bind('telegram', binding!.code, { id: '42', name: '', chatId: null })
    await store.save('telegram', { enabled: false })
    expect((await store.state()).platforms.telegram.accounts).toHaveLength(1)
    await store.save('telegram', { credentials: { token: '987654321:AAHanotherBOTtoken' } })
    expect((await store.state()).platforms.telegram.accounts).toEqual([])
  })

  it('unbinds an account', async () => {
    const store = open()
    await withTelegram(store)
    const { binding } = await store.startBinding('telegram')
    await store.bind('telegram', binding!.code, { id: '42', name: '', chatId: null })
    await store.unbind('telegram', '42')
    expect(pushed.at(-1)!.platforms.telegram!.accounts).toEqual([])
  })

  it('refuses an account that is not one', async () => {
    const store = open()
    await withTelegram(store)
    const { binding } = await store.startBinding('telegram')
    expect(await store.bind('telegram', binding!.code, { id: '', name: '', chatId: null })).toBe(
      false,
    )
    expect(await store.bind('telegram', binding!.code, 'nobody')).toBe(false)
  })
})

describe('parseStatus', () => {
  it('takes a status and refuses what is not one', () => {
    const status = {
      state: 'error',
      problem: 'credentials',
      detail: 'Telegram refused the bot token',
      errorAt: 1,
      connectedAt: null,
      botName: '@kite_bot',
    }
    expect(parseStatus(status)).toEqual(status)
    expect(parseStatus({ ...status, state: 'up' })).toBeNull()
    expect(parseStatus({ ...status, problem: 'other' })).toBeNull()
    expect(parseStatus({ ...status, detail: 'x'.repeat(1000) })).toBeNull()
  })
})
