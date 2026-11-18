import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/thread'
import type { TokenParts, UsageSource } from '@shared/usage'
import { topSessions, UsageDb } from './db'
import { PRICES, type UsageRow } from './model'

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
