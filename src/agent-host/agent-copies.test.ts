// Huli: what Kite removes of a deleted session from the agents' own folders, against fake agent
// homes: exactly the session's id, inside the agent's folder, and nothing else.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentCopies,
  agyFolders,
  claudeCopyPaths,
  dshCopyPaths,
  removeAgyCopies,
  removeClaudeCopies,
  removeDshCopies,
  withoutEntries,
} from './agent-copies'
import { fixture, testHome, type TestHome } from './dsh/testing'
import { linkFolder } from './testing/links'
import { tempFolder } from './testing/temp'

const homes: TestHome[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => home.remove()))
})

const ID = '3f1c2a9e-7b4d-4c1a-9e2f-0a1b2c3d4e5f'
const CHILD = '5a6b7c8d-1e2f-4a3b-8c9d-0e1f2a3b4c5d'
const FORK = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'
const OTHER = '0b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e'

async function put(file: string, content: string | Buffer = 'x'): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
  return file
}

async function exists(file: string): Promise<boolean> {
  return readdir(path.dirname(file)).then(
    (names) => names.includes(path.basename(file)),
    () => false,
  )
}

const sorted = (paths: string[]): string[] => [...paths].sort()

describe("Claude Code's copies", () => {
  async function claudeHome() {
    const root = await tempFolder('kite-copies-claude-')
    const config = path.join(root, '.claude')
    const projects = path.join(config, 'projects')
    const planned = [
      await put(path.join(projects, 'E--work', `${ID}.jsonl`)),
      await put(path.join(projects, 'E--work', ID, 'subagents', 'agent-1.jsonl')),
      // Continued by the Claude app in a scratch folder, and Kite's backup of the transcript.
      await put(path.join(projects, 'C--scratch', `${ID}.jsonl`)),
      await put(path.join(projects, 'E--work', `${ID}.jsonl.kite-bak-2026-11-19T12-00-00-000Z`)),
      await put(path.join(config, 'file-history', ID, 'a@v1')),
      await put(path.join(config, 'session-env', ID, 'env')),
      await put(path.join(config, 'tasks', ID, '1.json')),
      await put(path.join(config, 'uploads', ID, 'image.png')),
      await put(path.join(config, 'todos', `${ID}.json`)),
      await put(path.join(config, 'todos', `${ID}-agent-${CHILD}.json`)),
      await put(path.join(config, 'debug', `${ID}.txt`)),
    ].map((file) => {
      const relative = path.relative(config, file).split(path.sep)
      // A folder of the session's goes whole.
      const at = relative.indexOf(ID)
      return at >= 0 ? path.join(config, ...relative.slice(0, at + 1)) : file
    })
    const kept = [
      await put(path.join(projects, 'E--work', `${OTHER}.jsonl`)),
      await put(path.join(projects, 'E--work', `${ID}x.jsonl`)),
      await put(path.join(projects, 'E--work', `x${ID}.jsonl`)),
      await put(path.join(projects, 'E--work', `${ID}.jsonl.bak`)),
      await put(path.join(projects, 'E--work', OTHER, 'subagents', `${ID}.jsonl`)),
      await put(path.join(config, 'file-history', OTHER, 'a@v1')),
      await put(path.join(config, 'todos', `${OTHER}-agent-${ID}.json`)),
      await put(path.join(config, 'debug', 'latest')),
      await put(path.join(config, 'history.jsonl'), `{"sessionId":"${ID}"}\n`),
      await put(path.join(config, 'implicit', `${ID}.jsonl`)),
      // Another Claude Code folder, and one a project folder links to: neither is this one.
      await put(path.join(root, '.claude-work', 'projects', 'E--work', `${ID}.jsonl`)),
      await put(path.join(root, 'elsewhere', `${ID}.jsonl`)),
    ]
    await linkFolder(path.join(root, 'elsewhere'), path.join(projects, 'E--linked'))
    return { config, planned: [...new Set(planned)], kept }
  }

  it('plans the transcript in every project folder, its backups and its own files', async () => {
    const { config, planned } = await claudeHome()
    expect(sorted(await claudeCopyPaths(config, ID))).toEqual(sorted(planned))
  })

  it('removes them and leaves everything else', async () => {
    const { config, planned, kept } = await claudeHome()
    const result = await removeClaudeCopies(config, ID)
    expect(sorted(result.removed)).toEqual(sorted(planned))
    expect(result.failed).toEqual([])
    for (const file of planned) expect(await exists(file)).toBe(false)
    for (const file of kept) expect(await exists(file)).toBe(true)
    expect(await exists(path.join(config, 'projects', 'E--linked'))).toBe(true)
  })

  it('takes only an id Claude Code gives a session', async () => {
    const { config } = await claudeHome()
    expect(await claudeCopyPaths(config, '..')).toEqual([])
    expect(await claudeCopyPaths(config, `${ID}/..`)).toEqual([])
    expect(await claudeCopyPaths(config, '*')).toEqual([])
  })
})

/** A map entry of agy's summary store: the id as field 1, a value as field 2. */
function entry(field: number, id: string, value: Buffer): Buffer {
  const key = Buffer.from(id)
  const body = Buffer.concat([Buffer.from([0x0a, key.length]), key, Buffer.from([0x12]), value])
  return Buffer.concat([Buffer.from([(field << 3) | 2, body.length]), body])
}

/** An entry of the app's map of times: the id as field 1, a number as field 2. */
function stamp(id: string): Buffer {
  const key = Buffer.from(id)
  const body = Buffer.concat([Buffer.from([0x0a, key.length]), key, Buffer.from([0x10, 0x2a])])
  return Buffer.concat([Buffer.from([0x12, body.length]), body])
}

const summary = (text: string): Buffer =>
  Buffer.concat([Buffer.from([Buffer.byteLength(text)]), Buffer.from(text)])

function storeKeys(bytes: Buffer): string[] {
  const keys: string[] = []
  let at = 0
  while (at < bytes.length) {
    const length = bytes[at + 1]!
    const body = bytes.subarray(at + 2, at + 2 + length)
    keys.push(body.subarray(2, 2 + body[1]!).toString())
    at += 2 + length
  }
  return keys
}

interface Row {
  id: string
  steps: number
  parent?: string
  depth?: number
}

function summariesDb(file: string, rows: Row[]): void {
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE conversation_summaries (conversation_id text, title text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0, parent_conversation_id text NOT NULL DEFAULT "",
      nesting_depth integer NOT NULL DEFAULT 0, PRIMARY KEY (conversation_id))`)
  const insert = db.prepare(
    'INSERT INTO conversation_summaries (conversation_id, step_count, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?)',
  )
  for (const row of rows) insert.run(row.id, row.steps, row.parent ?? '', row.depth ?? 0)
  db.close()
}

function rowIds(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db
      .prepare('SELECT conversation_id FROM conversation_summaries ORDER BY conversation_id')
      .all()
      .map((row) => String(row.conversation_id))
  } finally {
    db.close()
  }
}

describe("DeepSeek Harness's copies", () => {
  const PARENT = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
  const KID = '4bc9ed73-787d-40e6-83cb-71a91ee4c8a1'
  const TOOLS = '3f2a9c1e-5b7d-4e8a-9c0b-1d2e3f4a5b6c'

  async function dshHome() {
    const home = await testHome()
    homes.push(home)
    const parent = path.dirname(await home.place(fixture('subagent-parent.v4')))
    const kid = path.dirname(await home.place(fixture('subagent-child.v4')))
    // A copy left in another project folder, as after the folder moved.
    const moved = path.dirname(
      await home.place(fixture('subagent-parent.v4'), { project: '--old--' }),
    )
    const other = path.dirname(await home.place(fixture('tools.v4')))
    const projections = path.join(home.home, 'storages', 'session_projcache', 'sessions')
    const views = [
      await put(path.join(projections, `${PARENT}.json`)),
      await put(path.join(projections, `${KID}.json`)),
    ]
    const kept = [other, await put(path.join(projections, `${TOOLS}.json`))]
    const workspace = await put(path.join(home.home, 'storages', 'workspace.json'), '{}')
    return { home, planned: [parent, moved, kid, ...views], kept: [...kept, workspace] }
  }

  it('plans the session in every project folder, its subagents and their projections', async () => {
    const { home, planned } = await dshHome()
    expect(sorted(await dshCopyPaths(home.home, PARENT))).toEqual(sorted(planned))
  })

  it('removes them and leaves the other sessions and the registry', async () => {
    const { home, planned, kept } = await dshHome()
    const result = await removeDshCopies(home.home, PARENT)
    expect(result.failed).toEqual([])
    expect(sorted(result.removed)).toEqual(sorted(planned))
    for (const file of planned) expect(await exists(file)).toBe(false)
    for (const file of kept) expect(await exists(file)).toBe(true)
  })

  it('follows no subagent whose own log names another parent, and takes no unsafe id', async () => {
    const { home } = await dshHome()
    // The child's log names PARENT, so asked for it alone its own folder goes, and nothing above.
    const own = await dshCopyPaths(home.home, KID)
    expect(own.every((file) => file.includes(KID))).toBe(true)
    expect(await dshCopyPaths(home.home, '../sessions')).toEqual([])
    expect(await dshCopyPaths(home.home, '')).toEqual([])
  })

  it("reports through the host's service whether all of it went", async () => {
    const { home } = await dshHome()
    const copies = new AgentCopies({
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      configFolder: () => home.home,
      env: () => ({}),
      log: () => {},
    })
    expect(await copies.removeDeleted('deepseek', PARENT)).toBe(true)
    expect(await copies.removeDeleted('doubao', '10000000000025552')).toBeNull()
  })
})

describe("agy's copies", () => {
  async function agyHome({ steps = 4 }: { steps?: number } = {}) {
    const home = await tempFolder('kite-copies-agy-')
    const [cli, app] = agyFolders(home)
    const at = (...parts: string[]): string => path.join(cli!, ...parts)
    const planned = [
      await put(at('conversations', `${ID}.db`)),
      await put(at('conversations', `${ID}.db-wal`)),
      await put(at('conversations', `${ID}.db-shm`)),
      await put(at('brain', ID, 'task.md')),
      await put(at('annotations', `${ID}.pbtxt`), 'title:"x"'),
      await put(at('conversations', `${CHILD}.db`)),
      await put(at('brain', CHILD, 'notes.md')),
    ].map((file) => {
      const relative = path.relative(cli!, file).split(path.sep)
      return relative[0] === 'brain' ? path.join(cli!, 'brain', relative[1]!) : file
    })
    const kept = [
      await put(at('conversations', `${OTHER}.db`)),
      await put(at('conversations', `${FORK}.db`)),
      await put(at('conversations', `${ID}x.db`)),
      await put(at('brain', OTHER, 'task.md')),
      await put(at('annotations', `${OTHER}.pbtxt`)),
      // Editor activity under ids of its own, never a conversation's.
      await put(at('implicit', `${ID}.pb`)),
      await put(at('installation_id'), ID),
    ]
    summariesDb(at('conversation_summaries.db'), [
      { id: ID, steps },
      { id: CHILD, steps: 9, parent: ID, depth: 1 },
      // A conversation that names it as its parent at the top level stays: it is no sub-agent's.
      { id: FORK, steps: 3, parent: ID, depth: 0 },
      { id: OTHER, steps: 2 },
    ])
    await put(
      at('jetbox_summaries_proto.pb'),
      Buffer.concat(
        [ID, CHILD, FORK, OTHER].map((id) => entry(1, id, summary(`summary of ${id}`))),
      ),
    )
    await put(
      at('cache', 'conversation_metadata.json'),
      JSON.stringify(
        { conversations: { [ID]: {}, [CHILD]: { is_internal: true }, [OTHER]: {} } },
        null,
        2,
      ),
    )
    // The Antigravity app's index, which lists the CLI's conversations too.
    await mkdir(app!, { recursive: true })
    summariesDb(path.join(app!, 'conversation_summaries.db'), [
      { id: ID, steps },
      { id: OTHER, steps: 2 },
    ])
    await put(
      path.join(app!, 'agyhub_summaries_proto.pb'),
      Buffer.concat([
        entry(1, ID, summary('s')),
        entry(1, OTHER, summary('s')),
        stamp(ID),
        stamp(OTHER),
      ]),
    )
    return { home, cli: cli!, app: app!, planned, kept }
  }

  it('removes the conversation and its sub-agents everywhere agy indexes them', async () => {
    const { home, cli, app, planned, kept } = await agyHome()
    const pass = await removeAgyCopies(home, ID)
    expect(pass.ids.sort()).toEqual([ID, CHILD].sort())
    expect(pass.held).toEqual([])
    expect(pass.failed).toEqual([])
    for (const file of planned) expect(await exists(file)).toBe(false)
    for (const file of kept) expect(await exists(file)).toBe(true)
    expect(rowIds(path.join(cli, 'conversation_summaries.db'))).toEqual([FORK, OTHER].sort())
    expect(rowIds(path.join(app, 'conversation_summaries.db'))).toEqual([OTHER])
    expect(storeKeys(await readFile(path.join(cli, 'jetbox_summaries_proto.pb')))).toEqual([
      FORK,
      OTHER,
    ])
    expect(storeKeys(await readFile(path.join(app, 'agyhub_summaries_proto.pb')))).toEqual([
      OTHER,
      OTHER,
    ])
    const metadata = JSON.parse(
      await readFile(path.join(cli, 'cache', 'conversation_metadata.json'), 'utf8'),
    )
    expect(Object.keys(metadata.conversations)).toEqual([OTHER])
  })

  it('leaves a dropped session alone once it was prompted', async () => {
    const { home, planned } = await agyHome({ steps: 3 })
    const pass = await removeAgyCopies(home, ID, { unprompted: true })
    expect(pass.kept).toBe(true)
    expect(pass.removed).toEqual([])
    for (const file of planned) expect(await exists(file)).toBe(true)
  })

  it('removes a dropped session that never got a prompt, without following sub-agents', async () => {
    const { home, cli } = await agyHome({ steps: 0 })
    const pass = await removeAgyCopies(home, ID, { unprompted: true })
    expect(pass.kept).toBe(false)
    expect(await exists(path.join(cli, 'conversations', `${ID}.db`))).toBe(false)
    expect(await exists(path.join(cli, 'conversations', `${CHILD}.db`))).toBe(true)
  })

  it('touches nothing for a conversation it does not have', async () => {
    const { home, cli } = await agyHome()
    const before = await readFile(path.join(cli, 'jetbox_summaries_proto.pb'))
    const pass = await removeAgyCopies(home, '7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c')
    expect(pass.touched).toEqual([])
    expect(pass.removed).toEqual([])
    expect(await readFile(path.join(cli, 'jetbox_summaries_proto.pb'))).toEqual(before)
    // Not even opened: SQLite would leave its journal beside a database it opened.
    expect(await exists(path.join(cli, 'conversation_summaries.db-wal'))).toBe(false)
  })

  it('goes on past a part it cannot remove', async () => {
    const { home, cli } = await agyHome()
    await writeFile(path.join(cli, 'conversation_summaries.db'), 'not a database')
    await writeFile(path.join(cli, 'jetbox_summaries_proto.pb'), Buffer.from([0xff, 0xff]))
    const pass = await removeAgyCopies(home, ID)
    expect(pass.failed.map((failure) => path.basename(failure.path)).sort()).toEqual(
      [
        'conversation_summaries.db',
        'conversation_summaries.db',
        'jetbox_summaries_proto.pb',
      ].sort(),
    )
    expect(await exists(path.join(cli, 'conversations', `${ID}.db`))).toBe(false)
    expect(await exists(path.join(cli, 'brain', ID))).toBe(false)
    const metadata = JSON.parse(
      await readFile(path.join(cli, 'cache', 'conversation_metadata.json'), 'utf8'),
    )
    expect(Object.keys(metadata.conversations)).not.toContain(ID)
  })

  it.runIf(process.platform === 'win32')(
    'leaves a conversation another agy holds open whole, and removes it once let go',
    async () => {
      const { home, cli } = await agyHome()
      const db = path.join(cli, 'conversations', `${ID}.db`)
      await writeFile(db, '')
      const holder = new DatabaseSync(db)
      holder.exec('CREATE TABLE steps (id integer)')
      let pass
      try {
        pass = await removeAgyCopies(home, ID)
        expect(pass.held).toEqual([db])
        expect(await exists(db)).toBe(true)
        expect(await exists(path.join(cli, 'brain', ID))).toBe(true)
        expect(rowIds(path.join(cli, 'conversation_summaries.db'))).toContain(ID)
        // Its sub-agent's conversation, which nothing holds, goes.
        expect(await exists(path.join(cli, 'brain', CHILD))).toBe(false)
      } finally {
        holder.close()
      }
      const again = await removeAgyCopies(home, ID, { known: pass.touched })
      expect(again.held).toEqual([])
      expect(await exists(db)).toBe(false)
      expect(await exists(path.join(cli, 'brain', ID))).toBe(false)
      expect(rowIds(path.join(cli, 'conversation_summaries.db'))).not.toContain(ID)
    },
  )

  it('tries again later what was held, and once more after the agents stop', async () => {
    const { home, cli } = await agyHome()
    const logs: string[] = []
    const copies = new AgentCopies({
      platform: process.platform,
      configFolder: () => null,
      env: () => ({ HOME: home, USERPROFILE: home }),
      log: (_level, message) => logs.push(message),
      retryMs: [60_000, 60_000],
    })
    await copies.removeDeleted('antigravity', ID)
    expect(await exists(path.join(cli, 'conversations', `${ID}.db`))).toBe(false)
    // Something written back as agy's process exits goes with the pass after it.
    await put(path.join(cli, 'brain', ID, 'late.md'))
    await copies.flush()
    expect(await exists(path.join(cli, 'brain', ID))).toBe(false)
    expect(
      logs.some((line) => line.startsWith(`Removed antigravity's copy of session ${ID}`)),
    ).toBe(true)
    expect(logs.join('\n')).not.toContain('summary of')
  })
})

describe("agy's summary store", () => {
  it('drops the entries of the ids alone, byte for byte', () => {
    const kept = entry(1, OTHER, summary(`mentions ${ID}`))
    const bytes = Buffer.concat([entry(1, ID, summary('a')), kept, entry(2, ID, summary('b'))])
    const next = withoutEntries(bytes, new Set([ID]))
    expect(next?.dropped).toBe(2)
    expect(next?.bytes).toEqual(kept)
  })

  it('leaves a file of another shape alone', () => {
    expect(withoutEntries(Buffer.from([0x08, 0x01]), new Set([ID]))).toBeNull()
    expect(withoutEntries(Buffer.from([0x0a, 0x05, 0x01]), new Set([ID]))).toBeNull()
    expect(withoutEntries(Buffer.from([0x0a, 0x02, 0x08, 0x01]), new Set([ID]))).toBeNull()
  })
})
