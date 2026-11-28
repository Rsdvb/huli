import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/thread'
import type { TokenParts, UsageSource } from '@shared/usage'
import { SCHEMA_VERSION, topSessions, UsageDb } from './db'
import { PRICES, type UsageRow } from './model'
import { recordRows } from './record'

const dirs: string[] = []
const dbs: UsageDb[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function openDb(): UsageDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-usage-db-'))
  dirs.push(dir)
  const db = UsageDb.open(path.join(dir, 'usage.db'), () => {})
  dbs.push(db)
  return db
}

function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-usage-'))
  dirs.push(dir)
  return path.join(dir, 'state', 'usage.db')
}

const PRICED = Object.keys(PRICES.models).find((model) => {
  const price = PRICES.models[model]!
  return price.input > price.cacheRead && price.cacheRead > 0
})!

let keys = 0
function row(patch: Partial<UsageRow> & { at: number }): UsageRow {
  return {
    key: `row-${keys++}`,
    source: 'kettu',
    agentId: 'claude-code',
    sessionId: 's1',
    project: '/work/app',
    model: PRICED,
    input: 0,
    output: 0,
    reasoning: null,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    turn: 1,
    ...patch,
  }
}

const DAY = Date.parse('2026-11-10T00:00:00Z')
const HOUR = 3_600_000
const sources = (source: UsageSource) => ({ 'claude-code': source, codex: source }) as const

describe('UsageDb.summary sessions', () => {
  it('sums each counted session over the range, with its cost and cache savings', () => {
    const db = openDb()
    db.write([
      row({ at: DAY + HOUR, input: 100, output: 10, cacheRead: 1000 }),
      row({ at: DAY + 2 * HOUR, input: 50, turn: 1 }),
      row({ at: DAY + 2 * HOUR, input: 7, model: 'no-such-model', turn: 0 }),
      row({ at: DAY + 3 * HOUR, sessionId: 's2', input: 5 }),
      // Outside the range, without a session, and from the source that does not count.
      row({ at: DAY - HOUR, input: 10_000 }),
      row({ at: DAY + 25 * HOUR, input: 10_000 }),
      row({ at: DAY + HOUR, sessionId: null, input: 10_000 }),
      row({ at: DAY + HOUR, source: 'log', input: 10_000 }),
    ])
    const { sessions } = db.summary([], DAY, DAY + 24 * HOUR, sources('kettu'))
    const price = PRICES.models[PRICED]!
    const s1 = sessions.find((s) => s.agentSessionId === 's1')!
    expect(sessions).toHaveLength(2)
    expect(s1).toMatchObject({
      agentId: 'claude-code',
      project: '/work/app',
      input: 157,
      output: 10,
      cacheRead: 1000,
      requests: 3,
      turns: 2,
      unpricedTokens: 7,
      // Its latest request in the range, which names a session run outside Kettu.
      lastAt: DAY + 2 * HOUR,
    })
    expect(s1.cost).toBeCloseTo(150 * price.input + 10 * price.output + 1000 * price.cacheRead)
    expect(s1.cacheSaved).toBeCloseTo(1000 * (price.input - price.cacheRead))
    expect(sessions.find((s) => s.agentSessionId === 's2')).toMatchObject({ input: 5 })
  })

  it('counts the log rows when the logs are the source', () => {
    const db = openDb()
    db.write([
      row({ at: DAY + HOUR, input: 1 }),
      row({ at: DAY + HOUR, source: 'log', sessionId: 'log-1', input: 2, turn: 0 }),
    ])
    const { sessions } = db.summary([], DAY, DAY + 24 * HOUR, sources('log'))
    expect(sessions.map((s) => [s.agentSessionId, s.input, s.turns])).toEqual([['log-1', 2, 0]])
  })
})

describe('topSessions', () => {
  const ZERO: TokenParts = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 0,
    turns: 0,
    cost: null,
    unpricedTokens: 0,
    cacheSaved: 0,
  }
  const session = (id: string, agentId: AgentId, patch: Partial<TokenParts>) => ({
    ...ZERO,
    id,
    agentId,
    ...patch,
  })

  it("keeps each agent's top sessions by every measure, each once", () => {
    const list = [
      session('big', 'claude-code', { input: 1000, requests: 1, cost: 1 }),
      session('busy', 'claude-code', { input: 10, requests: 50, cost: 0.1 }),
      session('dear', 'claude-code', { input: 100, requests: 2, cost: 9 }),
      session('small', 'claude-code', { input: 1, requests: 1, cost: 0.01 }),
      session('long', 'claude-code', { input: 2, requests: 1, turns: 40, cost: null }),
      session('other', 'codex', { input: 5, requests: 1, cost: null }),
    ]
    const kept = topSessions(list, 1).map((s) => s.id)
    expect(kept.sort()).toEqual(['big', 'busy', 'dear', 'long', 'other'])
  })

  it('ranks no session by a measure it has nothing in', () => {
    const list = [session('a', 'codex', { input: 3, requests: 1 })]
    expect(topSessions(list, 20)).toHaveLength(1)
    expect(topSessions([session('b', 'codex', {})], 20)).toEqual([])
  })
})

describe('the images the requests uploaded', () => {
  it('sums them with the tokens, in the buckets and the sessions', () => {
    const db = openDb()
    db.write([
      row({ at: DAY + HOUR, input: 100, images: 7, imageBytes: 2_800_000 }),
      row({ at: DAY + 2 * HOUR, input: 50, images: 3, imageBytes: 1_200_000, turn: 0 }),
      row({ at: DAY + 2 * HOUR, input: 5 }),
    ])
    const summary = db.summary([DAY, DAY + 24 * HOUR], DAY, DAY + 24 * HOUR, sources('kettu'))
    expect(summary.days).toMatchObject([{ input: 155, images: 10, imageBytes: 4_000_000 }])
    expect(summary.sessions).toMatchObject([{ images: 10, imageBytes: 4_000_000 }])
    expect(db.totals(DAY, DAY + 24 * HOUR, sources('kettu'))).toMatchObject([
      { images: 10, imageBytes: 4_000_000 },
    ])
  })

  it('moves a grown row by its difference, images too', () => {
    const db = openDb()
    const first = row({ at: DAY + HOUR, source: 'log', output: 1, images: 2, imageBytes: 800 })
    db.write([first])
    db.write([{ ...first, output: 5, images: 3, imageBytes: 1200 }])
    const { days } = db.summary([DAY, DAY + 24 * HOUR], DAY, DAY + 24 * HOUR, sources('log'))
    expect(days).toMatchObject([{ output: 5, images: 3, imageBytes: 1200, requests: 1 }])
  })

  it('takes the turn’s images on its first row', () => {
    const rows = recordRows({
      sessionId: 's1',
      acpSessionId: 'acp-1',
      agentId: 'claude-code',
      project: null,
      turnEntryId: 'end-1',
      at: DAY,
      tokens: null,
      models: [
        {
          model: 'a',
          tokens: { total: 10, input: 10, output: 0, thought: null, cacheRead: 0, cacheWrite: 0 },
        },
        {
          model: 'b',
          tokens: { total: 5, input: 5, output: 0, thought: null, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      model: null,
      images: { sent: 4, bytes: 1_600_000 },
    })
    expect(rows.map((r) => [r.turn, r.images ?? 0, r.imageBytes ?? 0])).toEqual([
      [1, 4, 1_600_000],
      [0, 0, 0],
    ])
  })
})

describe("the usage database's upgrade to version 4", () => {
  it('adds the image columns to a file of version 3, its rows counting none', () => {
    const file = tempFile()
    UsageDb.open(file, () => {}).close()
    const raw = new DatabaseSync(file)
    for (const table of ['usage', 'buckets']) {
      raw.exec(
        `ALTER TABLE ${table} DROP COLUMN images; ALTER TABLE ${table} DROP COLUMN image_bytes`,
      )
    }
    raw
      .prepare(
        `INSERT INTO usage (key, source, agent_id, session_id, project, model, at, input, output,
          reasoning, cache_read, cache_write, cache_write_1h, turn)
        VALUES ('old', 'kettu', 'claude-code', 's', '/p', 'm', 0, 5, 1, NULL, 0, 0, 0, 1)`,
      )
      .run()
    raw.exec('PRAGMA user_version = 3')
    raw.close()

    const db = UsageDb.open(file, () => {})
    expect(db.status).toBe('ok')
    db.write([row({ key: 'new', at: 0, input: 1, images: 2, imageBytes: 900 })])
    db.close()
    const check = new DatabaseSync(file)
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(SCHEMA_VERSION)
    expect(check.prepare('SELECT key, images, image_bytes FROM usage ORDER BY key').all()).toEqual([
      { key: 'new', images: 2, image_bytes: 900 },
      { key: 'old', images: 0, image_bytes: 0 },
    ])
    check.close()
  })
})

describe("the usage database's upgrade to version 3", () => {
  it("takes the cache out of the input of Kettu's rows for agents that held it there", () => {
    const file = tempFile()
    UsageDb.open(file, () => {}).close()
    const raw = new DatabaseSync(file)
    const insert = raw.prepare(
      `INSERT INTO usage (key, source, agent_id, session_id, project, model, at, input, output,
        reasoning, cache_read, cache_write, cache_write_1h, turn)
      VALUES (?, ?, ?, 's', '/p', 'm', 0, ?, 10, NULL, ?, ?, 0, 1)`,
    )
    const rows: [string, string, string, number, number, number, number][] = [
      // key, source, agent, input as stored, cache read, cache write, input after
      ['pi', 'kettu', 'pi', 1_584_482, 1_402_752, 0, 181_730],
      ['dsh', 'kettu', 'deepseek~work', 1500, 300, 0, 1200],
      ['cline', 'kettu', 'cline', 100, 60, 5, 35],
      ['gemini', 'kettu', 'gemini', 3150, 3000, 0, 150],
      ['qoder', 'kettu', 'qoder-cn~cn', 3150, 3000, 50, 100],
      ['pi-plain', 'kettu', 'pi', 100, 0, 0, 100],
      // An input under its cache never held it.
      ['pi-apart', 'kettu', 'pi', 10, 300, 0, 10],
      ['claude', 'kettu', 'claude-code', 8, 80_289, 85_417, 8],
      ['codex', 'log', 'codex', 100, 3000, 0, 100],
      ['picky', 'kettu', 'pinata', 1500, 300, 0, 1500],
    ]
    for (const [key, source, agent, input, read, write] of rows) {
      insert.run(key, source, agent, input, read, write)
    }
    raw.exec('PRAGMA user_version = 2')
    raw.close()

    const db = UsageDb.open(file, () => {})
    expect(db.status).toBe('ok')
    db.close()
    const check = new DatabaseSync(file)
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(SCHEMA_VERSION)
    const input = (key: string) =>
      (check.prepare('SELECT input FROM usage WHERE key = ?').get(key) as { input: number }).input
    for (const [key, , , , , , after] of rows) expect(input(key), key).toBe(after)
    const bucket = (agent: string) =>
      check
        .prepare("SELECT input, cache_read FROM buckets WHERE source = 'kettu' AND agent_id = ?")
        .get(agent)
    expect(bucket('pi')).toEqual({ input: 181_730 + 100 + 10, cache_read: 1_402_752 + 300 })
    expect(bucket('claude-code')).toEqual({ input: 8, cache_read: 80_289 })
    check.close()
  })
})
