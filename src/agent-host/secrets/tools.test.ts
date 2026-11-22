import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { summarizeParams } from '@shared/log/requests'
import { secretPath } from '@shared/secret-request'
import { mergeLines, writeDotenv } from './deliver'
import {
  parseSecretRequest,
  REQUEST_SECRETS,
  SecretTools,
  type SecretAnswer,
  type SecretAsk,
} from './tools'

const SECRET = 'sk-live-0123456789abcdef'
const OTHER = "pa ss'word"
const DOLLAR = "pa ss'wo$rd"
const platform = process.platform === 'win32' ? 'win32' : 'linux'

function text(result: CallToolResult): string {
  return result.content.map((part) => ('text' in part ? part.text : '')).join('\n')
}

let dir: string
let folder: string
let envDir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kite-secrets-'))
  folder = path.join(dir, 'project')
  envDir = path.join(dir, 'data', 'session-env')
  await mkdir(folder, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function harness(options: { loads?: boolean; saved?: Record<string, string> } = {}) {
  const asked: SecretAsk[] = []
  const answers: SecretAnswer[] = []
  const saves: { project: string; values: Record<string, string | null> }[] = []
  const waits = new Map<string, (answer: SecretAnswer) => void>()
  let next = 1
  const tools = new SecretTools({
    platform,
    envDir,
    saved: () => new Map(Object.entries(options.saved ?? {})),
    save: (project, values) => saves.push({ project, values }),
    loadsEnv: () => options.loads === true,
    ask: (_, ask) => {
      asked.push(ask)
      const entryId = `e${next++}`
      return { entryId, answer: new Promise((resolve) => waits.set(entryId, resolve)) }
    },
    answer: (_, entryId, answer: SecretAnswer) => {
      answers.push(answer)
      waits.get(entryId)?.(answer)
      waits.delete(entryId)
    },
    check: (_, entryId) => {
      if (!waits.has(entryId)) throw new Error('already answered')
    },
    ignored: async () => false,
  })
  const caller = { sessionId: 's1', project: folder }
  return { tools, asked, answers, saves, caller }
}

const request = (extra: Record<string, unknown> = {}) => ({
  title: 'OpenAI API key',
  reason: 'The tests call the API.',
  fields: [
    { name: 'OPENAI_API_KEY', label: 'API key' },
    { name: 'OPENAI_ORG', label: 'Organization', plain: true, optional: true },
  ],
  ...extra,
})

describe('request_secrets', () => {
  it('delivers a dotenv file and tells the agent only the names', async () => {
    const { tools, asked, saves, caller } = harness()
    await writeFile(path.join(folder, '.env.local'), 'KEEP=1\nOPENAI_API_KEY=old\n')
    const call = tools.call(caller, REQUEST_SECRETS, request({ file: '.env.local' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toHaveLength(1)
    await tools.answer('s1', 'e1', {
      decision: 'provide',
      values: { OPENAI_API_KEY: ` ${SECRET} `, OPENAI_ORG: OTHER },
      save: true,
    })
    const result = await call
    const written = await readFile(path.join(folder, '.env.local'), 'utf8')
    expect(written).toBe(`KEEP=1\nOPENAI_API_KEY=${SECRET}\nOPENAI_ORG="${OTHER}"\n`)
    // The thread's card, the agent's result and everything else hold the names alone.
    for (const shown of [JSON.stringify(asked), text(result), JSON.stringify(result)]) {
      expect(shown).not.toContain(SECRET)
      expect(shown).not.toContain(OTHER)
    }
    expect(text(result)).toContain('OPENAI_API_KEY')
    expect(text(result)).toContain('not ignored by git')
    // A saved value goes to the encrypted store alone.
    expect(saves).toEqual([
      { project: folder, values: { OPENAI_API_KEY: SECRET, OPENAI_ORG: OTHER } },
    ])
  })

  it('writes the session’s file of exports and names how to load it', async () => {
    const { tools, caller } = harness()
    const call = tools.call(caller, REQUEST_SECRETS, request())
    await new Promise((resolve) => setTimeout(resolve, 0))
    await tools.answer('s1', 'e1', { decision: 'provide', values: { OPENAI_API_KEY: DOLLAR } })
    const result = await call
    const sh = await readFile(path.join(envDir, 's1.sh'), 'utf8')
    expect(sh).toBe(`export OPENAI_API_KEY='pa ss'\\''wo$rd'\n`)
    expect(text(result)).toContain(path.join(envDir, 's1.sh').replace(/\\/g, '/'))
    expect(JSON.stringify(result)).not.toContain('wo$rd')
  })

  it('says the variables are set when the agent loads the file itself', async () => {
    const { tools, caller } = harness({ loads: true })
    const call = tools.call(caller, REQUEST_SECRETS, request())
    await new Promise((resolve) => setTimeout(resolve, 0))
    await tools.answer('s1', 'e1', { decision: 'provide', values: { OPENAI_API_KEY: SECRET } })
    const result = await call
    expect(text(result)).toContain('$OPENAI_API_KEY')
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('uses a saved value without sending it anywhere but its target', async () => {
    const { tools, asked, saves, caller } = harness({ saved: { OPENAI_API_KEY: SECRET } })
    const call = tools.call(caller, REQUEST_SECRETS, request({ file: '.env' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked[0]!.saved).toEqual(['OPENAI_API_KEY'])
    expect(JSON.stringify(asked)).not.toContain(SECRET)
    await tools.answer('s1', 'e1', {
      decision: 'provide',
      useSaved: ['OPENAI_API_KEY'],
      save: true,
    })
    const result = await call
    expect(await readFile(path.join(folder, '.env'), 'utf8')).toBe(`OPENAI_API_KEY=${SECRET}\n`)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(saves).toEqual([])
  })

  it('forgets the saved values when the user unchecks saving', async () => {
    const { tools, saves, caller } = harness({ saved: { OPENAI_API_KEY: SECRET } })
    const call = tools.call(caller, REQUEST_SECRETS, request())
    await new Promise((resolve) => setTimeout(resolve, 0))
    await tools.answer('s1', 'e1', { decision: 'provide', values: { OPENAI_API_KEY: 'new' } })
    await call
    expect(saves).toEqual([{ project: folder, values: { OPENAI_API_KEY: null } }])
  })

  it('refuses an answer that leaves a required field empty or breaks a line, and keeps waiting', async () => {
    const { tools, answers, caller } = harness()
    void tools.call(caller, REQUEST_SECRETS, request())
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(tools.answer('s1', 'e1', { decision: 'provide', values: {} })).rejects.toThrow(
      /empty/,
    )
    await expect(
      tools.answer('s1', 'e1', { decision: 'provide', values: { OPENAI_API_KEY: 'a\nB=c' } }),
    ).rejects.toThrow(/one line/)
    await expect(
      tools.answer('s1', 'e1', { decision: 'provide', values: { UNASKED: SECRET } }),
    ).rejects.toThrow(/asks for no UNASKED/)
    expect(answers).toEqual([])
  })

  it('tells the agent not to ask again in the chat after a decline', async () => {
    const { tools, caller } = harness()
    const call = tools.call(caller, REQUEST_SECRETS, request())
    await new Promise((resolve) => setTimeout(resolve, 0))
    await tools.answer('s1', 'e1', { decision: 'decline' })
    expect(text(await call)).toMatch(/declined.*Do not ask/)
  })

  it('refuses a subagent', async () => {
    const { tools, caller } = harness()
    const result = await tools.call({ ...caller, subagent: true }, REQUEST_SECRETS, request())
    expect(result.isError).toBe(true)
  })
})

describe('the request’s fields and target', () => {
  it.each([
    ['a name that is no variable', { fields: [{ name: 'my-key', label: 'Key' }] }],
    ['a name the shell uses', { fields: [{ name: 'PATH', label: 'Path' }] }],
    ['a loader variable', { fields: [{ name: 'LD_PRELOAD', label: 'x' }] }],
    [
      'a name twice',
      {
        fields: [
          { name: 'A', label: 'a' },
          { name: 'A', label: 'b' },
        ],
      },
    ],
    ['only optional fields', { fields: [{ name: 'A', label: 'a', optional: true }] }],
    ['no fields', { fields: [] }],
    [
      'nine fields',
      { fields: Array.from({ length: 9 }, (_, i) => ({ name: `K${i}`, label: 'k' })) },
    ],
    ['an unknown field key', { fields: [{ name: 'A', label: 'a', value: SECRET }] }],
    ['a value in the request', { value: SECRET }],
    ['a page that is not http', { url: 'javascript:alert(1)' }],
  ])('refuses %s', (_, extra) => {
    expect(() => parseSecretRequest(request(extra))).toThrow()
  })

  it.each([
    '../.env',
    'a/../../.env',
    '/etc/.env',
    'C:\\Users\\x\\.env',
    '~/.env',
    '.git/.env',
    'src/config.ts',
    '.env/../x',
    '',
  ])('refuses the file %j', (file) => {
    if (file === '') expect(parseSecretRequest(request({ file })).target).toEqual({ kind: 'env' })
    else expect(() => parseSecretRequest(request({ file }))).toThrow()
  })

  it.each([
    ['.env.local', '.env.local'],
    ['./.env', '.env'],
    ['apps\\web\\.env.production.local', 'apps/web/.env.production.local'],
    ['app.env', 'app.env'],
    ['.dev.vars', '.dev.vars'],
  ])('takes the file %j', (raw, normalized) => {
    expect(secretPath(raw)).toEqual({ path: normalized })
  })

  it('never writes through a link out of the folder', async () => {
    const outside = path.join(dir, 'outside')
    await mkdir(outside)
    try {
      await symlink(outside, path.join(folder, 'linked'), 'junction')
    } catch {
      return
    }
    await expect(
      writeDotenv(folder, 'linked/.env', new Map([['A', SECRET]]), platform),
    ).rejects.toThrow(/outside/)
    await expect(readFile(path.join(outside, '.env'), 'utf8')).rejects.toThrow()
  })

  it('keeps a file’s other lines and replaces each name once', () => {
    const merged = mergeLines(
      '# keys\nA=1\nexport B=2\nA=3\n',
      new Map([
        ['A', 'A=new'],
        ['C', 'C=c'],
      ]),
      'dotenv',
    )
    expect(merged).toBe('# keys\nA=new\nexport B=2\nC=c\n')
  })

  it('logs an answer’s request without its values', () => {
    const logged = JSON.stringify(
      summarizeParams({
        sessionId: 's1',
        entryId: 'e1',
        decision: 'provide',
        values: { OPENAI_API_KEY: SECRET },
        useSaved: ['OPENAI_ORG'],
      }),
    )
    expect(logged).not.toContain(SECRET)
  })
})
