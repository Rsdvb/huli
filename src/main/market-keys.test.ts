import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MarketServer } from '@shared/marketplace'
import type { Logger } from './log'
import { MarketKeys, MarketKeysError, marketKeysFile, type MarketKeysPush } from './market-keys'
import type { IdentityCipher } from './remote-identity'

const TOKEN = 'ghp_0123456789abcdefSECRET'

const github: MarketServer = {
  id: 'io.github.github/github-mcp-server',
  name: 'github',
  title: 'GitHub',
  source: 'registry',
  version: '1.2.0',
  spec: {
    type: 'http',
    transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: [
      { name: 'X-Client', value: 'kettu' },
      { name: 'Authorization', input: true, secret: true, required: true },
    ],
  },
  agents: 'all',
  on: true,
}

const linear: MarketServer = {
  id: 'app.linear/linear',
  name: 'linear',
  title: 'Linear',
  source: 'registry',
  version: '1.0.0',
  spec: {
    type: 'http',
    transport: 'streamable-http',
    url: 'https://mcp.linear.app/mcp',
    headers: [],
    oauth: { flow: 'browser' },
  },
  agents: 'all',
  on: true,
}

const SIGN_IN = JSON.stringify({
  tokens: { access_token: 'at-SECRET-linear', refresh_token: 'rt-SECRET-linear' },
  client: { client_id: 'kettu-client' },
})

const notes: MarketServer = {
  id: 'manual:0f8fad5b-d9cb-469f-a165-70867728950e',
  name: 'notes',
  title: 'Notes',
  source: 'manual',
  version: null,
  spec: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@example/notes-mcp'],
    env: [
      { name: 'NOTES_TOKEN', input: true, secret: true, required: true },
      { name: 'NOTES_DIR', input: true, secret: false, required: false },
    ],
  },
  agents: ['codex'],
  on: true,
}

// Flips every byte, so the file never shows a value as it was given.
const flip = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0x5a))

function cipher(available = true): IdentityCipher {
  return {
    available: async () => available,
    encrypt: async (text) => flip(Buffer.from(text, 'utf8')),
    decrypt: async (encrypted) => ({
      result: flip(encrypted).toString('utf8'),
      shouldReEncrypt: false,
    }),
    plainText: () => false,
  }
}

const NO_ENCRYPTION: IdentityCipher = {
  available: async () => false,
  encrypt: () => Promise.reject(new Error('no encryption')),
  decrypt: () => Promise.reject(new Error('no encryption')),
  plainText: () => true,
}

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let dir: string
let servers: MarketServer[]
let pushed: MarketKeysPush[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-market-keys-'))
  servers = [github, notes, linear]
  pushed = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function load(
  options: { cipher?: IdentityCipher; plainTextAllowed?: boolean } = {},
): Promise<MarketKeys> {
  return MarketKeys.load({
    file: marketKeysFile(dir),
    cipher: options.cipher ?? cipher(),
    plainTextAllowed: options.plainTextAllowed ?? false,
    servers: () => servers,
    changed: (contents) => pushed.push(contents),
    log: silent,
  })
}

const fileText = (): Promise<string> => readFile(marketKeysFile(dir), 'utf8')

describe('the Marketplace key store', () => {
  it('keeps values encrypted and reads them back', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: `Bearer ${TOKEN}` } })
    await keys.set({ serverId: notes.id, values: { NOTES_TOKEN: 'n0tes', NOTES_DIR: '/tmp/n' } })
    expect(await fileText()).not.toContain(TOKEN)
    const again = await load()
    expect(again.values()).toEqual({
      [github.id]: { Authorization: `Bearer ${TOKEN}` },
      [notes.id]: { NOTES_TOKEN: 'n0tes', NOTES_DIR: '/tmp/n' },
    })
  })

  it('tells clients which inputs are set, never their values', async () => {
    const keys = await load()
    const state = await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    expect(state).toEqual({ [github.id]: ['Authorization'] })
    expect(JSON.stringify(keys.state())).not.toContain(TOKEN)
  })

  it('hands every change to the agent host', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    await keys.set({ serverId: github.id, values: { Authorization: null } })
    expect(pushed).toEqual([
      {
        values: { [github.id]: { Authorization: TOKEN } },
        oauth: {},
        agentEnv: {},
        profiles: {},
        pluginSecrets: {},
      },
      { values: {}, oauth: {}, agentEnv: {}, profiles: {}, pluginSecrets: {} },
    ])
    expect(keys.state()).toEqual({})
  })

  it.each([
    ['a patch that is no object', 'github'],
    ['an unknown field', { serverId: github.id, values: {}, extra: 1 }],
    ['values that are no object', { serverId: github.id, values: [TOKEN] }],
    ['a value that is no string', { serverId: github.id, values: { Authorization: 1 } }],
    ['a server not installed', { serverId: 'io.github.other/server', values: { A: 'x' } }],
    ['an input the spec does not declare', { serverId: github.id, values: { Cookie: 'x' } }],
    ['a fixed header', { serverId: github.id, values: { 'X-Client': 'other' } }],
    ['an empty value', { serverId: github.id, values: { Authorization: '' } }],
    ['a value over 8 KB', { serverId: github.id, values: { Authorization: 'a'.repeat(8193) } }],
    [
      'a header value with a line break',
      { serverId: github.id, values: { Authorization: 'a\nb' } },
    ],
    ['a value with a NUL', { serverId: notes.id, values: { NOTES_TOKEN: 'a\0b' } }],
  ])('rejects %s and keeps nothing', async (_, patch) => {
    const keys = await load()
    await expect(keys.set(patch)).rejects.toBeInstanceOf(MarketKeysError)
    expect(keys.state()).toEqual({})
    expect(pushed).toEqual([])
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it('takes a value of 8 KB, counted in bytes', async () => {
    const keys = await load()
    await keys.set({ serverId: notes.id, values: { NOTES_TOKEN: 'a'.repeat(8192) } })
    await expect(
      keys.set({
        serverId: notes.id,
        values: { NOTES_TOKEN: String.fromCharCode(0xe9).repeat(4097) },
      }),
    ).rejects.toBeInstanceOf(MarketKeysError)
  })

  it('drops the keys of a server that is uninstalled', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    await keys.set({ serverId: notes.id, values: { NOTES_TOKEN: 'n0tes' } })
    servers = [notes]
    keys.prune()
    await keys.flush()
    expect(keys.values()).toEqual({ [notes.id]: { NOTES_TOKEN: 'n0tes' } })
    expect(pushed.at(-1)).toEqual({
      values: { [notes.id]: { NOTES_TOKEN: 'n0tes' } },
      oauth: {},
      agentEnv: {},
      profiles: {},
      pluginSecrets: {},
    })
    expect((await load()).values()).toEqual({ [notes.id]: { NOTES_TOKEN: 'n0tes' } })
  })

  it('drops the value of an input the spec no longer declares', async () => {
    const keys = await load()
    await keys.set({ serverId: notes.id, values: { NOTES_TOKEN: 'n0tes', NOTES_DIR: '/tmp/n' } })
    const spec = notes.spec as Extract<MarketServer['spec'], { type: 'stdio' }>
    servers = [github, { ...notes, spec: { ...spec, env: [spec.env[0]!] } }]
    keys.prune()
    await keys.flush()
    expect(keys.state()).toEqual({ [notes.id]: ['NOTES_TOKEN'] })
  })

  it('removes the file once no key is left, and prunes on load', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    servers = []
    const again = await load()
    await again.flush()
    expect(again.values()).toEqual({})
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('writes a file only the user can read', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    expect((await stat(marketKeysFile(dir))).mode & 0o777).toBe(0o600)
  })

  it('refuses to keep keys where the system cannot encrypt them', async () => {
    const keys = await load({ cipher: cipher(false) })
    await expect(
      keys.set({ serverId: github.id, values: { Authorization: TOKEN } }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(keys.state()).toEqual({})
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')(
    "keeps them in the user's file alone where that is allowed, as under the daemon",
    async () => {
      const keys = await load({ cipher: NO_ENCRYPTION, plainTextAllowed: true })
      await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
      expect((await stat(marketKeysFile(dir))).mode & 0o777).toBe(0o600)
      const again = await load({ cipher: NO_ENCRYPTION, plainTextAllowed: true })
      expect(again.values()).toEqual({ [github.id]: { Authorization: TOKEN } })
    },
  )

  it('moves an invalid file aside and starts with no keys', async () => {
    await writeFile(marketKeysFile(dir), '{"version":1,"encrypted":false,"values":[1]}')
    const keys = await load()
    expect(keys.values()).toEqual({})
    const names = await readdir(dir)
    expect(names.some((name) => name.startsWith('market-keys.corrupt-'))).toBe(true)
  })

  it('leaves a file from a newer version as it is and refuses to change it', async () => {
    const text = '{"version":4,"encrypted":true,"contents":"x"}'
    await writeFile(marketKeysFile(dir), text)
    const keys = await load()
    await expect(
      keys.set({ serverId: github.id, values: { Authorization: TOKEN } }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(await fileText()).toBe(text)
  })
})

describe('OAuth sign-ins in the key store', () => {
  const empty: MarketKeysPush = {
    values: {},
    oauth: {},
    agentEnv: {},
    profiles: {},
    pluginSecrets: {},
  }

  it('keeps a sign-in encrypted beside the keys and reads it back', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    expect(await keys.setOAuth(linear.id, SIGN_IN)).toBe(true)
    const pushedLast: MarketKeysPush = {
      values: { [github.id]: { Authorization: TOKEN } },
      oauth: { [linear.id]: SIGN_IN },
      agentEnv: {},
      profiles: {},
      pluginSecrets: {},
    }
    expect(pushed.at(-1)).toEqual(pushedLast)
    expect(await fileText()).not.toContain('SECRET')
    expect((await load()).contentsForHost()).toEqual(pushedLast)
  })

  it('never tells a client anything of a sign-in', async () => {
    const keys = await load()
    await keys.setOAuth(linear.id, SIGN_IN)
    expect(keys.state()).toEqual({})
    await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    expect(keys.state()).toEqual({ [github.id]: ['Authorization'] })
    expect(JSON.stringify(keys.state())).not.toContain('SECRET')
  })

  it.each([
    ['a server not installed', 'app.example/other', SIGN_IN],
    ['a remote server without OAuth', github.id, SIGN_IN],
    ['a local server', notes.id, SIGN_IN],
    ['a server id that is no string', 7, SIGN_IN],
    ['a sign-in that is not JSON', linear.id, 'access_token=x'],
    ['an empty sign-in', linear.id, ''],
    ['a sign-in that is no string', linear.id, { access_token: 'x' }],
    ['a sign-in over 64 KB', linear.id, JSON.stringify('a'.repeat(64 * 1024))],
  ])('refuses %s, keeps nothing and sends the host what it holds', async (_, id, state) => {
    const keys = await load()
    expect(await keys.setOAuth(id, state)).toBe(false)
    expect(keys.contentsForHost()).toEqual(empty)
    expect(pushed).toEqual([empty])
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it('clears a sign-in with null', async () => {
    const keys = await load()
    await keys.setOAuth(linear.id, SIGN_IN)
    expect(await keys.setOAuth(linear.id, null)).toBe(true)
    expect(pushed.at(-1)).toEqual(empty)
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it('refuses to keep a sign-in where the system cannot encrypt it', async () => {
    const keys = await load({ cipher: cipher(false) })
    expect(await keys.setOAuth(linear.id, SIGN_IN)).toBe(false)
    expect(pushed).toEqual([empty])
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it('drops the sign-in of a server that is uninstalled', async () => {
    const keys = await load()
    await keys.setOAuth(linear.id, SIGN_IN)
    servers = [github, notes]
    keys.prune()
    await keys.flush()
    expect(keys.contentsForHost()).toEqual(empty)
    expect(pushed.at(-1)).toEqual(empty)
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it('drops the sign-in of a server that no longer signs in with OAuth', async () => {
    const keys = await load()
    await keys.setOAuth(linear.id, SIGN_IN)
    const spec = { ...(linear.spec as Extract<MarketServer['spec'], { type: 'http' }>) }
    delete spec.oauth
    servers = [{ ...linear, spec }]
    keys.prune()
    await keys.flush()
    expect(keys.contentsForHost().oauth).toEqual({})
  })

  it.skipIf(process.platform === 'win32')(
    "keeps a sign-in in the user's file alone under the daemon",
    async () => {
      const keys = await load({ cipher: NO_ENCRYPTION, plainTextAllowed: true })
      expect(await keys.setOAuth(linear.id, SIGN_IN)).toBe(true)
      expect((await stat(marketKeysFile(dir))).mode & 0o777).toBe(0o600)
      const again = await load({ cipher: NO_ENCRYPTION, plainTextAllowed: true })
      expect(again.contentsForHost().oauth).toEqual({ [linear.id]: SIGN_IN })
    },
  )

  it('reads the keys of a file from before sign-ins and writes it anew', async () => {
    const values = { [github.id]: { Authorization: TOKEN } }
    const sealed = flip(Buffer.from(JSON.stringify(values), 'utf8')).toString('base64')
    await writeFile(
      marketKeysFile(dir),
      JSON.stringify({ version: 1, encrypted: true, values: sealed }),
    )
    const keys = await load()
    await keys.flush()
    expect(keys.contentsForHost()).toEqual({
      values,
      oauth: {},
      agentEnv: {},
      profiles: {},
      pluginSecrets: {},
    })
    const stored = JSON.parse(await fileText()) as Record<string, unknown>
    expect(stored.version).toBe(3)
    expect((await load()).values()).toEqual(values)
  })
})

describe('agent environment keys in the key store', () => {
  it('stores, pushes, and clears values without exposing them in key state', async () => {
    const keys = await load()
    await keys.setAgentEnv('glm-agent', 'ZHIPU_API_KEY', 'SECRET')
    expect(keys.agentEnvState()).toEqual({ 'glm-agent': ['ZHIPU_API_KEY'] })
    expect(pushed.at(-1)?.agentEnv).toEqual({ 'glm-agent': { ZHIPU_API_KEY: 'SECRET' } })
    expect(await fileText()).not.toContain('SECRET')
    expect((await load()).contentsForHost().agentEnv).toEqual({
      'glm-agent': { ZHIPU_API_KEY: 'SECRET' },
    })
    await keys.setAgentEnv('glm-agent', 'ZHIPU_API_KEY', null)
    expect(keys.agentEnvState()).toEqual({})
  })
})

// Huli: an agent's API provider profiles, kept with their keys beside the Marketplace's.
describe('API provider profiles in the key store', () => {
  const KEY = 'sk-profile-SECRET-0123456789abcd'
  const draft = {
    agentId: 'claude-code',
    name: 'DeepSeek',
    preset: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-flash[1m]',
    key: KEY,
  }

  it('keeps a profile encrypted with its key and pushes it to the agent host alone', async () => {
    const keys = await load()
    const id = await keys.saveProfile({ ...draft, makeDefault: true })
    expect(await fileText()).not.toContain('SECRET')
    expect(await fileText()).not.toContain('deepseek-flash')
    expect(pushed.at(-1)?.profiles).toEqual({
      'claude-code': {
        defaultId: id,
        items: [
          {
            id,
            name: 'DeepSeek',
            preset: 'deepseek',
            baseUrl: 'https://api.deepseek.com/anthropic',
            model: 'deepseek-flash[1m]',
            key: KEY,
          },
        ],
      },
    })
    expect((await load()).contentsForHost().profiles).toEqual(pushed.at(-1)?.profiles)
    // Nothing a client is answered holds a profile.
    expect(JSON.stringify(keys.state())).not.toContain('SECRET')
    expect(JSON.stringify(keys.agentEnvState())).not.toContain('SECRET')
  })

  it('keeps the key of a profile changed without one, and takes a new one', async () => {
    const keys = await load()
    const id = await keys.saveProfile(draft)
    await keys.saveProfile({ ...draft, id, name: 'Work', key: undefined })
    let saved = keys.contentsForHost().profiles['claude-code']!.items[0]!
    expect(saved).toMatchObject({ id, name: 'Work', key: KEY })
    await keys.saveProfile({ ...draft, id, key: 'sk-another-SECRET' })
    saved = keys.contentsForHost().profiles['claude-code']!.items[0]!
    expect(saved.key).toBe('sk-another-SECRET')
  })

  it('refuses a draft that is not one, naming no key in its error', async () => {
    const keys = await load()
    const refused = async (raw: unknown): Promise<string> => {
      const error = await keys.saveProfile(raw).then(
        () => null,
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(MarketKeysError)
      expect((error as MarketKeysError).code).toBe('invalid_params')
      return (error as Error).message
    }
    expect(await refused({ ...draft, key: undefined })).not.toContain('SECRET')
    expect(await refused({ ...draft, key: 'sk with SECRET spaces' })).not.toContain('SECRET')
    await refused({ ...draft, baseUrl: 'file:///etc/passwd' })
    await refused({ ...draft, baseUrl: 'https://user:pass@example.com' })
    await refused({ ...draft, model: 'two words' })
    await refused({ ...draft, preset: 'nobody' })
    await refused({ ...draft, name: '' })
    await refused({ ...draft, agentId: 'codex' })
    await refused({ ...draft, agentId: 'nobody~at-all' })
    await refused({ ...draft, extra: true })
    await refused({ ...draft, id: 'no-such-profile' })
    expect(keys.contentsForHost().profiles).toEqual({})
  })

  it('removes a profile, and its agent then starts sessions on its own sign-in', async () => {
    const keys = await load()
    const id = await keys.saveProfile({ ...draft, makeDefault: true })
    const other = await keys.saveProfile({ ...draft, name: 'Second' })
    await keys.removeProfile('claude-code', id)
    expect(keys.contentsForHost().profiles['claude-code']).toMatchObject({
      defaultId: null,
      items: [{ id: other }],
    })
    await keys.setDefaultProfile('claude-code', other)
    expect(keys.contentsForHost().profiles['claude-code']!.defaultId).toBe(other)
    await expect(keys.setDefaultProfile('claude-code', 'gone')).rejects.toThrow(MarketKeysError)
    await keys.removeProfile('claude-code', other)
    expect(keys.contentsForHost().profiles).toEqual({})
  })

  it('reads a file from before profiles with none', async () => {
    const stored = { values: {}, oauth: {}, agentEnv: { a: { X: 'y' } } }
    await writeFile(
      marketKeysFile(dir),
      JSON.stringify({ version: 3, encrypted: false, contents: stored }),
    )
    const keys = await load({ plainTextAllowed: true })
    expect(keys.contentsForHost().profiles).toEqual({})
    expect(keys.contentsForHost().agentEnv).toEqual({ a: { X: 'y' } })
  })
})

describe('values saved from secret cards', () => {
  const VALUE = 'sk-live-SECRET-0123'

  it('keeps them encrypted by project and reads them back', async () => {
    const keys = await load()
    await keys.setProjectSecrets('/p', { OPENAI_API_KEY: VALUE })
    expect(keys.contentsForHost().projectSecrets).toEqual({ '/p': { OPENAI_API_KEY: VALUE } })
    expect(await fileText()).not.toContain('SECRET')
    expect((await load()).contentsForHost().projectSecrets).toEqual({
      '/p': { OPENAI_API_KEY: VALUE },
    })
    expect(keys.state()).toEqual({})
  })

  it('forgets a value with null, and the project once it has none', async () => {
    const keys = await load()
    await keys.setProjectSecrets('/p', { A: VALUE, B: 'b' })
    await keys.setProjectSecrets('/p', { A: null })
    expect(keys.contentsForHost().projectSecrets).toEqual({ '/p': { B: 'b' } })
    await keys.setProjectSecrets('/p', { B: null })
    expect(keys.contentsForHost().projectSecrets).toBeUndefined()
  })

  it.each([
    ['no project', '', { A: VALUE }],
    ['a name that is no variable', '/p', { 'a-b': VALUE }],
    ['a reserved name', '/p', { PATH: VALUE }],
    ['a value of two lines', '/p', { A: 'a\nB=b' }],
    ['a value that is no text', '/p', { A: 1 }],
  ])('refuses %s without naming the value', async (_, project, values) => {
    const keys = await load()
    const refused = keys.setProjectSecrets(project, values)
    await expect(refused).rejects.toThrow(MarketKeysError)
    await refused.catch((error: Error) => expect(error.message).not.toContain('SECRET'))
    expect(keys.contentsForHost().projectSecrets).toBeUndefined()
  })
})

describe("Huli: webhook routines' secrets", () => {
  const SECRET = 'SECRETabcdefghijklmnopqrstuvwxyz0123456789_'

  it('keeps one encrypted by routine, and forgets it with null', async () => {
    const keys = await load()
    await keys.setWebhookSecret('r-0123456789ab', SECRET)
    expect(keys.contentsForHost().webhookSecrets).toEqual({ 'r-0123456789ab': SECRET })
    expect(await fileText()).not.toContain('SECRET')
    expect((await load()).contentsForHost().webhookSecrets).toEqual({
      'r-0123456789ab': SECRET,
    })
    await keys.setWebhookSecret('r-0123456789ab', null)
    expect(keys.contentsForHost().webhookSecrets).toBeUndefined()
  })

  it.each([
    ['no routine', 'routine', SECRET],
    ['a secret of another shape', 'r-0123456789ab', `${SECRET}x`],
    ['a secret that is no text', 'r-0123456789ab', 7],
  ])('refuses %s without naming the value', async (_, routineId, secret) => {
    const keys = await load()
    const refused = keys.setWebhookSecret(routineId, secret)
    await expect(refused).rejects.toThrow(MarketKeysError)
    await refused.catch((error: Error) => expect(error.message).not.toContain('SECRET'))
    expect(keys.contentsForHost().webhookSecrets).toBeUndefined()
  })
})

describe('the secrets of plugins in the key store', () => {
  const PLUGIN = 'p0123456789ab'
  const OTHER = 'pba9876543210'
  const SECRET = 'sk-plugin-SECRET-value'

  it('keeps a secret encrypted by plugin and key, and gives it to the agent host alone', async () => {
    const keys = await load()
    await keys.setPluginSecret(PLUGIN, 'token', SECRET)
    await keys.setPluginSecret(OTHER, 'token', 'other-SECRET')
    const held = { [PLUGIN]: { token: SECRET }, [OTHER]: { token: 'other-SECRET' } }
    expect(pushed.at(-1)).toMatchObject({ pluginSecrets: held })
    expect(await fileText()).not.toContain('SECRET')
    expect((await load()).contentsForHost().pluginSecrets).toEqual(held)
    // A client is told nothing of it: neither the inputs of servers nor anything else.
    expect(keys.state()).toEqual({})
    expect(JSON.stringify(keys.agentEnvState())).not.toContain('SECRET')
  })

  it('clears one secret, or with no key every secret of the plugin, and writes no file when none is left', async () => {
    const keys = await load()
    await keys.setPluginSecret(PLUGIN, 'one', 'a')
    await keys.setPluginSecret(PLUGIN, 'two', 'b')
    await keys.setPluginSecret(PLUGIN, 'one', null)
    expect(pushed.at(-1)?.pluginSecrets).toEqual({ [PLUGIN]: { two: 'b' } })
    await keys.setPluginSecret(PLUGIN, null, null)
    expect(pushed.at(-1)?.pluginSecrets).toEqual({})
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it('keeps them through the pruning of servers, which only drops what a server no longer has', async () => {
    const keys = await load()
    await keys.setPluginSecret(PLUGIN, 'token', SECRET)
    servers = []
    keys.prune()
    await keys.flush()
    expect((await load()).contentsForHost().pluginSecrets).toEqual({ [PLUGIN]: { token: SECRET } })
  })

  it.each([
    ['an id that is no plugin', 'not-a-plugin', 'token', SECRET],
    ['a plugin that is no string', 7, 'token', SECRET],
    ['an empty key', PLUGIN, '', SECRET],
    ['a key that is no string', PLUGIN, 3, SECRET],
    ['a value that is no string', PLUGIN, 'token', 5],
    ['an empty value', PLUGIN, 'token', ''],
    ['a value past 8 KB', PLUGIN, 'token', 'x'.repeat(8193)],
    ['a value with a NUL', PLUGIN, 'token', 'a\0b'],
  ])('refuses %s and keeps nothing', async (_, id, key, value) => {
    const keys = await load()
    await expect(keys.setPluginSecret(id, key, value)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    expect(keys.contentsForHost().pluginSecrets).toEqual({})
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it('refuses to keep one where the system cannot encrypt it', async () => {
    const keys = await load({ cipher: cipher(false) })
    await expect(keys.setPluginSecret(PLUGIN, 'token', SECRET)).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(keys.contentsForHost().pluginSecrets).toEqual({})
  })

  it('reads a file from before plugins had secrets as holding none', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    expect((await load()).contentsForHost().pluginSecrets).toEqual({})
  })
})
