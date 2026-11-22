// Agent sync's MCP formats: a server read from one agent's file and written for another keeps
// what both formats carry, and reads back the same, in every pair of formats.

import { describe, expect, it } from 'vitest'
import type { SyncFormat } from '@shared/agent-sync'
import { CODECS, type NeutralServer } from './formats'
import { secretsOf, maskLine, targetOf } from './mask'

const stdio: NeutralServer = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@upstash/context7-mcp', '--api-key', 'ctx7-secret-0123456789'],
  env: { CONTEXT7_TOKEN: 'tok-abcdefghijklmnop' },
  cwd: null,
  url: '',
  headers: {},
  enabled: true,
}

const http: NeutralServer = {
  transport: 'http',
  command: '',
  args: [],
  env: {},
  cwd: null,
  url: 'https://mcp.example.com/mcp',
  headers: { Authorization: 'Bearer sk-live-0123456789abcdef' },
  enabled: true,
}

const sse: NeutralServer = { ...http, transport: 'sse', url: 'https://old.example.com/sse' }

const FORMATS = Object.keys(CODECS) as SyncFormat[]

/** A format that keeps only a remote server's URL reads an SSE server back as remote HTTP. */
const asRead = (server: NeutralServer, auto: boolean): NeutralServer =>
  auto && server.transport === 'sse' ? { ...server, transport: 'http' } : server

describe('MCP formats', () => {
  for (const format of FORMATS) {
    const codec = CODECS[format]
    for (const server of [stdio, http, sse]) {
      if (!codec.transports.includes(server.transport)) continue
      it(`round-trips a ${server.transport} server in ${format}`, () => {
        const read = codec.read(structuredClone(codec.write(server)))
        expect(read).toEqual({ ok: true, server: asRead(server, codec.remoteAuto), extras: [] })
      })
    }
  }

  it('carries a server between every pair of formats that take its transport', () => {
    for (const from of FORMATS) {
      for (const to of FORMATS) {
        for (const server of [stdio, http, sse]) {
          if (!CODECS[from].transports.includes(server.transport)) continue
          if (!CODECS[to].transports.includes(server.transport)) continue
          const read = CODECS[from].read(CODECS[from].write(server))
          if (!read.ok) throw new Error(`${from} could not read its own ${server.transport}`)
          const back = CODECS[to].read(CODECS[to].write(read.server))
          const auto = CODECS[from].remoteAuto || CODECS[to].remoteAuto
          expect(back, `${from} -> ${to}`).toEqual({
            ok: true,
            server: asRead(server, auto),
            extras: [],
          })
        }
      }
    }
  })

  it('writes each format the way its docs give', () => {
    expect(CODECS.claude.write(http)).toEqual({
      type: 'http',
      url: http.url,
      headers: http.headers,
    })
    expect(CODECS.codex.write({ ...stdio, enabled: false, cwd: '/work' })).toEqual({
      command: 'npx',
      args: stdio.args,
      cwd: '/work',
      env: stdio.env,
      enabled: false,
    })
    expect(CODECS.gemini.write(http)).toEqual({
      url: http.url,
      type: 'http',
      headers: http.headers,
    })
    expect(CODECS.qwen.write(http)).toEqual({ httpUrl: http.url, headers: http.headers })
    expect(CODECS.opencode.write(stdio)).toEqual({
      type: 'local',
      command: ['npx', ...stdio.args],
      environment: stdio.env,
      enabled: true,
    })
    expect(CODECS.copilot.write(stdio)).toMatchObject({ type: 'local', tools: ['*'] })
    expect(CODECS.cursor.write(http)).toEqual({ url: http.url, headers: http.headers })
  })

  it('names what another format cannot carry', () => {
    const codex = CODECS.codex.read({
      command: 'x',
      cwd: '/srv',
      enabled: false,
      startup_timeout_sec: 20,
    })
    if (!codex.ok) throw new Error('unread')
    expect(codex.extras).toEqual(['startup_timeout_sec'])
    expect(CODECS.claude.loses(codex.server)).toEqual(['cwd', 'enabled'])
    expect(CODECS.codex.transports).not.toContain('sse')
  })

  it('reads the forms each agent accepts', () => {
    expect(CODECS.gemini.read({ httpUrl: 'https://a' })).toMatchObject({
      server: { transport: 'http', url: 'https://a' },
    })
    expect(CODECS.qwen.read({ url: 'https://a' })).toMatchObject({ server: { transport: 'sse' } })
    expect(CODECS.claude.read({ url: 'https://a' })).toEqual({
      ok: false,
      reason: 'unknown-transport',
    })
    expect(CODECS.claude.read({ type: 'ws', url: 'wss://a' })).toEqual({
      ok: false,
      reason: 'unknown-transport',
    })
    expect(CODECS.claude.read({ command: 'x', args: ['a'] })).toMatchObject({
      server: { transport: 'stdio', command: 'x', args: ['a'] },
    })
    expect(
      CODECS['opencode-v2'].read({ type: 'local', command: ['a'], disabled: true }),
    ).toMatchObject({ server: { enabled: false } })
  })
})

describe('masking', () => {
  it('keeps every secret of a server out of what the page shows', () => {
    const secrets = secretsOf(stdio)
    expect(targetOf(stdio)).not.toContain('ctx7-secret-0123456789')
    for (const format of ['claude', 'opencode'] as const) {
      const lines = JSON.stringify(CODECS[format].write(stdio), null, 2).split('\n')
      const shown = lines.map((line) => maskLine(line, secrets)).join('\n')
      expect(shown).not.toContain('tok-abcdefghijklmnop')
      expect(shown).not.toContain('ctx7-secret-0123456789')
    }
    const header = maskLine('Authorization = "Bearer sk-live-0123456789abcdef"', secretsOf(http))
    expect(header).not.toContain('sk-live')
    expect(maskLine('  "apiKey": "unknown-but-named-secret",', [])).not.toContain('unknown')
  })
})
