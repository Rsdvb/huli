// DeepSeek Harness's credential file: the key Kettu hands it, and nothing else of the file touched.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { clearApiKey, readAccountGrant, readApiKey, readProvider, writeApiKey } from './credentials'

let home: string
const file = () => path.join(home, '.credentials.yaml')

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'kettu-dsh-credentials-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('dsh credentials', () => {
  it('writes the key into a new file only its owner can read', async () => {
    const folder = path.join(home, 'agent')
    await writeApiKey(folder, 'sk-new')
    const written = path.join(folder, '.credentials.yaml')
    expect(parse(await readFile(written, 'utf8'))).toEqual({
      version: 1,
      refs: { DEEPSEEK_API_KEY: 'sk-new' },
    })
    if (process.platform !== 'win32') expect((await stat(written)).mode & 0o777).toBe(0o600)
  })

  it('keeps the other keys, records and comments of the file', async () => {
    await writeFile(
      file(),
      [
        'version: 1',
        '# mine',
        'refs:',
        '  DEEPSEEK_API_KEY: sk-old',
        '  OPENAI_API_KEY: sk-openai',
        'records:',
        '  llm-pi-ai/openai-codex:',
        '    kind: grant',
        '',
      ].join('\n'),
    )
    await writeApiKey(home, 'sk-new')
    const text = await readFile(file(), 'utf8')
    expect(text).toContain('# mine')
    expect(parse(text)).toEqual({
      version: 1,
      refs: { DEEPSEEK_API_KEY: 'sk-new', OPENAI_API_KEY: 'sk-openai' },
      records: { 'llm-pi-ai/openai-codex': { kind: 'grant' } },
    })
    await clearApiKey(home)
    expect(parse(await readFile(file(), 'utf8')).refs).toEqual({ OPENAI_API_KEY: 'sk-openai' })
  })

  it('refuses to rewrite a file it cannot read as YAML', async () => {
    await writeFile(file(), 'refs: [unclosed\n')
    await expect(writeApiKey(home, 'sk-new')).rejects.toThrow(/not valid YAML/)
    expect(await readFile(file(), 'utf8')).toBe('refs: [unclosed\n')
  })

  it('tells the route from what is stored, the account before a key', async () => {
    const env = { DSH_HOME: home }
    expect(await readProvider(env)).toBeNull()
    expect(await readProvider({ ...env, DEEPSEEK_API_KEY: 'sk-env' })).toBe('deepseek-official')
    await writeFile(path.join(home, '.env'), 'DEEPSEEK_API_KEY=sk-dotenv\n')
    expect(await readProvider(env)).toBe('deepseek-official')
    await writeFile(
      file(),
      'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-x\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n',
    )
    expect(await readProvider(env)).toBe('deepseek-account')
    expect(await readApiKey(env)).toBe('sk-x')
  })

  // The layout dsh 0.2.2-rc.5 writes on a DeepSeek sign-in, with the records it keeps beside it.
  const ACCOUNT_FILE = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: browser-secret',
    '  deepseek-account-platform/device:',
    '    kind: grant',
    '    payload:',
    '      id: 00000000-0000-4000-8000-000000000000',
    '  deepseek-account-platform/default:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      token: account-token-secret',
    '      issuer: https://platform.deepseek.com',
    '',
  ].join('\n')

  it('reads the account grant of a DeepSeek sign-in, and only a whole one', async () => {
    const env = { DSH_HOME: home }
    expect(await readAccountGrant(env)).toBeNull()
    await writeFile(file(), ACCOUNT_FILE)
    expect(await readProvider(env)).toBe('deepseek-account')
    expect(await readAccountGrant(env)).toEqual({
      token: 'account-token-secret',
      issuer: 'https://platform.deepseek.com',
    })
    expect(await readApiKey(env)).toBeNull()
    for (const broken of [
      ACCOUNT_FILE.replace(
        'kind: grant\n    payload:\n      version: 1\n      token',
        'kind: other\n    payload:\n      version: 1\n      token',
      ),
      ACCOUNT_FILE.replace('      version: 1\n      token', '      version: 2\n      token'),
      ACCOUNT_FILE.replace('token: account-token-secret', 'token: ""'),
      'refs: [unclosed\n',
    ]) {
      await writeFile(file(), broken)
      expect(await readAccountGrant(env)).toBeNull()
    }
  })

  it('reads the key dsh runs with: the file’s, the environment’s, then the home’s .env', async () => {
    const env = { DSH_HOME: home }
    await writeFile(path.join(home, '.env'), 'OTHER=1\nexport DEEPSEEK_API_KEY="sk-dotenv"\n')
    expect(await readProvider(env)).toBe('deepseek-official')
    expect(await readApiKey(env)).toBe('sk-dotenv')
    await writeFile(path.join(home, '.env'), 'DEEPSEEK_API_KEY=sk-plain # a note\n')
    expect(await readApiKey(env)).toBe('sk-plain')
    expect(await readApiKey({ ...env, DEEPSEEK_API_KEY: ' sk-env ' })).toBe('sk-env')
    await writeFile(file(), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-stored\n')
    expect(await readApiKey({ ...env, DEEPSEEK_API_KEY: 'sk-env' })).toBe('sk-stored')
  })
})
