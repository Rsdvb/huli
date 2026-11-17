// An agent's settings file that Kettu edits: never rewritten when it cannot be read, and its
// error says which file and which line.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { jsonErrorLine, readSettings } from './settings-file'

describe('the line of a JSON error', () => {
  it('is null for valid JSON of any kind', () => {
    for (const text of [
      '{}',
      '[1, 2.5e3, -0, "a\\u00e9\\n"]',
      ' { "a": { "b": [true, null] } } ',
    ]) {
      expect(jsonErrorLine(text), text).toBeNull()
      JSON.parse(text)
    }
  })

  it('is where the text stops being JSON, whatever JSON.parse says of it', () => {
    expect(jsonErrorLine('{\n  "a": 1,\n  "b": \n}')).toBe(4)
    expect(jsonErrorLine('{\n  "a": 1\n  "b": 2\n}')).toBe(3)
    expect(jsonErrorLine('{\n "a": 1,\n}\n')).toBe(3)
    expect(jsonErrorLine('{\n "a": tru\n}')).toBe(2)
    expect(jsonErrorLine('{ "modelSettings": ')).toBe(1)
    expect(jsonErrorLine('{\n "a": "line\nbreak"\n}')).toBe(2)
    expect(jsonErrorLine('{ "a": "\\x" }')).toBe(1)
    expect(jsonErrorLine('{}\n\n{}')).toBe(3)
    expect(jsonErrorLine('// comment\n{}')).toBe(1)
  })
})

describe('reading a settings file', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-settings-file-'))
    file = path.join(dir, 'settings.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('names the agent, the file and the line of what is not JSON', async () => {
    await writeFile(file, '{\n  "env": {\n    "A": "1",\n  }\n}\n')
    await expect(readSettings(file)).rejects.toThrow(
      `Claude Code’s settings file ${file} is not valid JSON (line 4).`,
    )
    await expect(readSettings(file, 'Codebuddy Code')).rejects.toThrow(/^Codebuddy Code’s/)
  })

  it('reads a file a Windows editor started with a byte order mark', async () => {
    await writeFile(file, '\uFEFF{ "model": "opus" }\n')
    expect(await readSettings(file)).toEqual({ model: 'opus' })
  })

  it('reads a missing or empty file as empty', async () => {
    expect(await readSettings(file)).toEqual({})
    await writeFile(file, '  \n')
    expect(await readSettings(file)).toEqual({})
  })
})
