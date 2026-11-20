// Taking an agent's ids and sign-in out of a JSON file that also holds the user's configuration:
// every other byte stays, a file that does not parse is never written, and the write is whole.

import { readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FILE_LINKS } from '../testing/links'
import { tempFolder } from '../testing/temp'
import { editJsonKeys, presentKeys, removeJsonKeys } from './json-keys'

const CLAUDE_JSON = `{
  "numStartups": 12,
  "userID": "abc123",
  "mcpServers": {
    "local": { "command": "npx", "args": ["-y", "server", "--flag=\\"x\\""] }
  },
  "oauthAccount": { "emailAddress": "someone@example.com", "nested": [1, { "a": "}" }] },
  "projects": {"C:\\\\work": {"allowedTools": []}},
  "firstStartTime": "2026-11-01T00:00:00.000Z"
}
`

describe('removeJsonKeys', () => {
  it('takes out only the keys named and keeps every other byte', () => {
    const { text, removed } = removeJsonKeys(CLAUDE_JSON, ['userID', 'oauthAccount'])
    expect(removed).toEqual(['userID', 'oauthAccount'])
    expect(text).toBe(`{
  "numStartups": 12,
  "mcpServers": {
    "local": { "command": "npx", "args": ["-y", "server", "--flag=\\"x\\""] }
  },
  "projects": {"C:\\\\work": {"allowedTools": []}},
  "firstStartTime": "2026-11-01T00:00:00.000Z"
}
`)
  })

  it('takes out the first and the last member and leaves valid JSON', () => {
    const { text } = removeJsonKeys(CLAUDE_JSON, ['numStartups', 'firstStartTime'])
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['userID', 'mcpServers', 'oauthAccount', 'projects'])
    expect(text.startsWith('{\n  "userID"')).toBe(true)
    expect(text.endsWith('"projects": {"C:\\\\work": {"allowedTools": []}}\n}\n')).toBe(true)
  })

  it('leaves an empty object when every member goes', () => {
    const { text } = removeJsonKeys('{"a": 1, "b": [2]}', ['a', 'b'])
    expect(JSON.parse(text)).toEqual({})
  })

  it('keeps nested keys of the same name and the text when none is there', () => {
    const text = '{"keep": {"userID": "inner"}}'
    expect(removeJsonKeys(text, ['userID'])).toEqual({ text, removed: [] })
  })

  it('keeps a byte order mark and minified text', () => {
    const { text } = removeJsonKeys('\uFEFF{"a":1,"userID":"x","b":true}', ['userID'])
    expect(text).toBe('\uFEFF{"a":1,"b":true}')
  })

  it('refuses text that is not a JSON object', () => {
    for (const text of ['{"a": 1,}', '[1, 2]', '', 'null', '{"a": 1} trailing', '{"a" 1}']) {
      expect(() => removeJsonKeys(text, ['a']), text).toThrow()
    }
  })

  it('names the keys a file has, and none for one that does not parse', () => {
    expect(presentKeys(CLAUDE_JSON, ['userID', 'machineID', 'oauthAccount'])).toEqual([
      'userID',
      'oauthAccount',
    ])
    expect(presentKeys('{oops', ['userID'])).toBeNull()
  })
})

describe('editJsonKeys', () => {
  it('replaces the file whole and leaves nothing beside it', async () => {
    const dir = await tempFolder('kite-json-keys-')
    const file = path.join(dir, '.claude.json')
    await writeFile(file, CLAUDE_JSON)
    expect(await editJsonKeys(file, ['userID', 'machineID'])).toEqual(['userID'])
    const text = await readFile(file, 'utf8')
    expect(text).toBe(CLAUDE_JSON.replace('  "userID": "abc123",\n', ''))
    expect(await readdir(dir)).toEqual(['.claude.json'])
  })

  it('never writes over a file that does not parse', async () => {
    const dir = await tempFolder('kite-json-keys-')
    const file = path.join(dir, '.claude.json')
    const broken = '{\n  "userID": "abc",\n  "mcpServers": {\n'
    await writeFile(file, broken)
    await expect(editJsonKeys(file, ['userID'])).rejects.toThrow(/not a JSON object/)
    expect(await readFile(file, 'utf8')).toBe(broken)
    expect(await readdir(dir)).toEqual(['.claude.json'])
  })

  it.skipIf(!FILE_LINKS)('changes the file a link points at and keeps the link', async () => {
    const dir = await tempFolder('kite-json-keys-')
    const target = path.join(dir, 'dotfiles.json')
    const link = path.join(dir, '.claude.json')
    await writeFile(target, '{"userID": "x", "theme": "dark"}')
    await symlink(target, link, 'file')
    await editJsonKeys(link, ['userID'])
    expect(await readFile(target, 'utf8')).toBe('{"theme": "dark"}')
    expect((await readdir(dir)).sort()).toEqual(['.claude.json', 'dotfiles.json'])
  })
})
