// Huli: a session deleted in Kite is deleted from the agent's own history too, here agy's, which
// keeps its conversations in files under the home folder it runs with; and a session Kite opened
// and let go unused leaves no empty conversation behind there.

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startTestHost, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const OTHER = '0b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e'

async function put(file: string, content = 'x'): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

async function exists(file: string): Promise<boolean> {
  return readdir(path.dirname(file)).then(
    (names) => names.includes(path.basename(file)),
    () => false,
  )
}

/** agy's files of `id` and of another conversation, in its own folder under `home`. */
async function agyConversation(home: string, id: string): Promise<string> {
  const folder = path.join(home, '.gemini', 'antigravity-cli')
  for (const each of [id, OTHER]) {
    await put(path.join(folder, 'conversations', `${each}.db`))
    await put(path.join(folder, 'brain', each, 'task.md'))
    await put(path.join(folder, 'annotations', `${each}.pbtxt`))
  }
  return folder
}

async function agyHost(home: string): Promise<TestHost> {
  const host = await startTestHost({
    fakeThroughRouter: { agentIds: ['antigravity'] },
    agentEnv: { HOME: home, USERPROFILE: home, FAKE_AGENT_UUID_IDS: '1' },
  })
  hosts.push(host)
  return host
}

it("deletes agy's own copy with the session from the recycle bin, past a part it cannot remove", async () => {
  const home = await tempFolder('kite-agy-home-')
  const host = await agyHost(home)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'antigravity',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'hello' }],
  })
  await window.untilEntry(id, (entry) => entry.kind === 'agent')
  await window.untilStatus(id, 'ready')
  const conversation = window.summary(id)?.acpSessionId
  expect(conversation).toMatch(/^[0-9a-f-]{36}$/)
  const folder = await agyConversation(home, conversation!)
  // A summaries database agy's own could not open: removing its row fails, the rest goes on.
  await put(path.join(folder, 'conversation_summaries.db'), 'not a database')

  await window.request('sessions.delete', { sessionId: id })

  const sessions = await window.request('sessions.list', {})
  expect(sessions.some((session) => session.id === id)).toBe(false)
  // Huli: in the recycle bin, agy's own copy stays until it is deleted for good.
  const bin = await window.request('bin.list', undefined)
  expect(bin.items.map((item) => item.key)).toContain(`session:${id}`)
  expect(await exists(path.join(folder, 'conversations', `${conversation}.db`))).toBe(true)
  await window.request('bin.purge', { keys: [`session:${id}`] })
  expect(await exists(path.join(folder, 'conversations', `${conversation}.db`))).toBe(false)
  expect(await exists(path.join(folder, 'brain', conversation!))).toBe(false)
  expect(await exists(path.join(folder, 'annotations', `${conversation}.pbtxt`))).toBe(false)
  expect(await exists(path.join(folder, 'conversation_summaries.db'))).toBe(true)
  expect(await exists(path.join(folder, 'conversations', `${OTHER}.db`))).toBe(true)
  expect(await exists(path.join(folder, 'brain', OTHER))).toBe(true)
})

it('removes the empty conversation a prepared agy session leaves when it is discarded', async () => {
  const home = await tempFolder('kite-agy-home-')
  const host = await agyHost(home)
  const window = host.connect()
  const prepared = await window.request('sessions.prepare', {
    agentId: 'antigravity',
    projectPath: host.project,
  })
  const conversation = prepared.acpSessionId
  expect(conversation).toMatch(/^[0-9a-f-]{36}$/)
  const folder = await agyConversation(home, conversation!)
  const summaries = new DatabaseSync(path.join(folder, 'conversation_summaries.db'))
  summaries.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY,
    step_count integer NOT NULL DEFAULT 0, parent_conversation_id text NOT NULL DEFAULT "",
    nesting_depth integer NOT NULL DEFAULT 0)`)
  summaries
    .prepare('INSERT INTO conversation_summaries (conversation_id) VALUES (?), (?)')
    .run(conversation!, OTHER)
  summaries.close()

  await window.request('sessions.discard', { sessionId: prepared.id })

  await expect
    .poll(() => exists(path.join(folder, 'conversations', `${conversation}.db`)))
    .toBe(false)
  await expect.poll(() => exists(path.join(folder, 'brain', conversation!))).toBe(false)
  expect(await exists(path.join(folder, 'conversations', `${OTHER}.db`))).toBe(true)
})
