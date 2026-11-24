import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inUsageWorker } from '../testing/usage-worker'
import type { UsageRow } from './model'
import { UsageStore } from './store'

const dirs: string[] = []
const stores: UsageStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const AT = Date.UTC(2026, 0, 1, 12)
const row = (key: string, input: number): UsageRow => ({
  key,
  source: 'kettu',
  agentId: 'claude-code',
  sessionId: 's1',
  project: '/work/app',
  model: '',
  at: AT,
  input,
  output: 0,
  reasoning: null,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  turn: 1,
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

it('stops its worker once unused and answers the next request from another', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-usage-store-'))
  dirs.push(dir)
  const workers: { stopped: boolean }[] = []
  const statuses: string[] = []
  const store = new UsageStore({
    file: path.join(dir, 'usage.db'),
    createWorker: (file) => {
      const worker = inUsageWorker(file)
      const seen = { stopped: false }
      workers.push(seen)
      return {
        ...worker,
        terminate: () => {
          seen.stopped = true
          return worker.terminate()
        },
      }
    },
    log: () => {},
    onChanged: () => {},
    onProgress: () => {},
    onStatus: (status) => statuses.push(status),
    idleMs: 50,
  })
  stores.push(store)
  expect(await store.ready).toBe('created')
  expect(await store.write([row('a', 5)])).toBe(1)
  await sleep(200)
  expect(workers.map((w) => w.stopped)).toEqual([true])
  // Nothing to cancel, and no worker started for it.
  await store.cancel()
  expect(workers).toHaveLength(1)
  const sources = { 'claude-code': 'kettu' as const }
  expect(await store.totals(AT - 3_600_000, AT + 3_600_000, sources)).toMatchObject([
    { agentId: 'claude-code', input: 5 },
  ])
  expect(await store.write([row('b', 7)])).toBe(1)
  expect(await store.totals(AT - 3_600_000, AT + 3_600_000, sources)).toMatchObject([{ input: 12 }])
  expect(workers.map((w) => w.stopped)).toEqual([true, false])
  // A database that opens again as before is no news to the manager.
  expect(statuses).toEqual([])
})
