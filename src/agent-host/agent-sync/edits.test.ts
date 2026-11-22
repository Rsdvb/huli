// Agent sync's edits of agents' files: a JSON or TOML member and the instructions block change,
// and every byte outside them stays as the user left it.

import { describe, expect, it } from 'vitest'
import { parseJsonc, removeMember, setMember } from './jsonc'
import { BLOCK_END, BLOCK_START, blockContent, BlockError, withBlock } from './managed-block'
import { addTomlTable, parseToml, removeTomlTable } from './toml'

/** The parts of `after` outside `[start, start + inserted)` equal `before` around `start`. */
function onlyInserted(before: string, after: string): string {
  let head = 0
  while (head < before.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }
  expect(head + tail).toBe(before.length)
  return after.slice(head, after.length - tail)
}

describe('JSONC members', () => {
  const claude = `{
  "numStartups": 12,
  "projects": {
    "/work": { "mcpServers": { "inner": { "command": "x" } } }
  },
  "mcpServers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "env": {}
    }
  },
  "theme": "dark"
}
`

  it('adds a server as the last member and changes nothing else', () => {
    const next = setMember(claude, ['mcpServers'], 'web', { type: 'http', url: 'https://x.dev' })
    const inserted = onlyInserted(claude, next)
    expect(inserted).toBe(
      ',\n    "web": {\n      "type": "http",\n      "url": "https://x.dev"\n    }',
    )
    const value = parseJsonc(next) as Record<string, Record<string, unknown>>
    expect(Object.keys(value.mcpServers!)).toEqual(['context7', 'web'])
    expect(value.projects).toEqual((parseJsonc(claude) as Record<string, unknown>).projects)
  })

  it('removes a server and gives back the original bytes', () => {
    const added = setMember(claude, ['mcpServers'], 'web', { type: 'http', url: 'https://x.dev' })
    expect(removeMember(added, ['mcpServers'], 'web')).toBe(claude)
  })

  it('removes the first of several members with its comma', () => {
    const two = setMember(claude, ['mcpServers'], 'web', { url: 'u' })
    const next = removeMember(two, ['mcpServers'], 'context7')
    expect((parseJsonc(next) as { mcpServers: object }).mcpServers).toEqual({ web: { url: 'u' } })
    expect(next.startsWith(claude.slice(0, claude.indexOf('"context7"')))).toBe(true)
  })

  it('closes up an object left empty, and makes the container when there is none', () => {
    const none = removeMember(claude, ['mcpServers'], 'context7')
    expect(none).toContain('"mcpServers": {},')
    const bare = '{\n  "theme": "dark"\n}\n'
    const made = setMember(bare, ['mcpServers'], 'a', { command: 'c' })
    expect(onlyInserted(bare, made)).toBe(
      ',\n  "mcpServers": {\n    "a": {\n      "command": "c"\n    }\n  }',
    )
  })

  it('keeps comments, trailing commas, CRLF and a byte order mark', () => {
    const text =
      '﻿{\r\n  // servers\r\n  "mcp": {\r\n    "a": { "type": "local", "command": ["x"] }, // first\r\n  },\r\n}\r\n'
    const next = setMember(text, ['mcp'], 'b', { type: 'remote', url: 'u' })
    expect(next.startsWith('﻿{\r\n  // servers\r\n')).toBe(true)
    expect(next).toContain('// first')
    expect(next).not.toMatch(/[^\r]\n/)
    const value = parseJsonc(next) as { mcp: Record<string, unknown> }
    expect(Object.keys(value.mcp)).toEqual(['a', 'b'])
    expect(removeMember(next, ['mcp'], 'b')).toBe(text)
  })

  it('edits compact JSON on its one line', () => {
    const text = '{"mcpServers":{"a":{"command":"x"}},"z":1}'
    const next = setMember(text, ['mcpServers'], 'b', { command: 'y' })
    expect(next).toBe('{"mcpServers":{"a":{"command":"x"}, "b": {"command":"y"}},"z":1}')
    expect(removeMember(next, ['mcpServers'], 'b')).toBe(text)
  })

  it('writes a new file for an empty one', () => {
    expect(setMember('', ['mcp', 'servers'], 'a', { url: 'u' })).toBe(
      '{\n  "mcp": {\n    "servers": {\n      "a": {\n        "url": "u"\n      }\n    }\n  }\n}\n',
    )
  })

  it('refuses a container that is not an object', () => {
    expect(() => setMember('{"mcpServers": []}', ['mcpServers'], 'a', {})).toThrow()
  })
})

describe('TOML tables', () => {
  const codex = `model = "gpt-5.5"
# my servers
[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]

[mcp_servers.docs.env]
DOCS_KEY = "secret-value-1234"

# Remote one, keep this note
[mcp_servers.remote]
url = 'https://mcp.example.com/mcp'
http_headers = { "X-Team" = "a" }

[profiles.fast]
model = "gpt-5.5-mini"
`

  it('reads servers in every form of key and string', () => {
    const { value } = parseToml(
      `${codex}\n[mcp_servers."with space"]\ncommand = """\nmulti"""\nargs = [\n  "a", # one\n  'b',\n]\n`,
    )
    expect(value.mcp_servers).toEqual({
      docs: { command: 'npx', args: ['-y', 'docs-mcp'], env: { DOCS_KEY: 'secret-value-1234' } },
      remote: { url: 'https://mcp.example.com/mcp', http_headers: { 'X-Team': 'a' } },
      'with space': { command: 'multi', args: ['a', 'b'] },
    })
  })

  it('appends a server and takes it out again byte for byte', () => {
    const next = addTomlTable(codex, 'mcp_servers', 'new one', {
      command: 'uvx',
      args: ['tool'],
      env: { A: 'b"c' },
    })
    expect(next.startsWith(codex)).toBe(true)
    expect(next.slice(codex.length)).toBe(
      '\n[mcp_servers."new one"]\ncommand = "uvx"\nargs = ["tool"]\n\n[mcp_servers."new one".env]\nA = "b\\"c"\n',
    )
    expect(parseToml(next).value.mcp_servers).toHaveProperty('new one.env.A', 'b"c')
    expect(removeTomlTable(next, 'mcp_servers', 'new one')).toBe(codex)
  })

  it('removes a server with its sub-tables and keeps the next one’s comment', () => {
    const next = removeTomlTable(codex, 'mcp_servers', 'docs')
    expect(next).toBe(`model = "gpt-5.5"
# my servers
# Remote one, keep this note
[mcp_servers.remote]
url = 'https://mcp.example.com/mcp'
http_headers = { "X-Team" = "a" }

[profiles.fast]
model = "gpt-5.5-mini"
`)
  })

  it('leaves a server written as an inline table in place', () => {
    const inline = '[mcp_servers]\nx = { command = "a" }\n'
    expect(removeTomlTable(inline, 'mcp_servers', 'x')).toBe(inline)
  })

  it('refuses TOML it cannot read', () => {
    expect(() => parseToml('[a]\nb = \n')).toThrow()
    expect(() => parseToml('[a]\n[a]\n')).toThrow()
  })
})

describe('the instructions block', () => {
  const rules = '# My rules\n\nNever overwrite my notes.\n- keep this\n'

  it('goes at the end, after a blank line, leaving the file before it as it was', () => {
    const next = withBlock(rules, ['Use pnpm.', 'Answer in English.'])
    expect(next.startsWith(rules)).toBe(true)
    expect(next.slice(rules.length)).toBe(
      `\n${BLOCK_START}\n<!-- Managed by Kite (纸鸢): edit these in Kite, changes made here are replaced. -->\nUse pnpm.\n\nAnswer in English.\n${BLOCK_END}\n`,
    )
    expect(blockContent(next)).toBe('Use pnpm.\n\nAnswer in English.')
  })

  it('changes only the lines between the markers, wherever the block is', () => {
    const middle = `${rules}\n${withBlock('', ['old'])}\n## After\nmore\n`
    const next = withBlock(middle, ['new', 'two'])
    const start = middle.indexOf(BLOCK_START)
    const end = middle.indexOf(BLOCK_END) + BLOCK_END.length + 1
    expect(next.slice(0, start)).toBe(middle.slice(0, start))
    expect(next.slice(next.length - (middle.length - end))).toBe(middle.slice(end))
    expect(blockContent(next)).toBe('new\n\ntwo')
  })

  it('comes out leaving the file as it was', () => {
    for (const text of [rules, '', 'no newline at the end\n\n', 'crlf\r\nfile\r\n']) {
      const added = withBlock(text, ['shared'])
      expect(withBlock(added, [])).toBe(text)
    }
  })

  it('keeps CRLF line breaks', () => {
    const next = withBlock('a\r\nb\r\n', ['x\ny'])
    expect(next).not.toMatch(/[^\r]\n/)
    expect(blockContent(next)).toBe('x\r\ny')
  })

  it('refuses a file whose markers do not pair', () => {
    expect(() => withBlock(`${rules}${BLOCK_START}\nhalf\n`, ['x'])).toThrow(BlockError)
    const two = withBlock(rules, ['x'])
    expect(() => withBlock(two + two, ['x'])).toThrow(BlockError)
  })
})
